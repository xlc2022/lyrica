import { spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Where "save credentials" keeps secrets: the self.db passphrase (`self`) and
 * users' data keys (`user-<id>`). Saved secrets are sealed on disk and come
 * back, unsealed, at the next start.
 */
export interface CredentialStore {
  save(name: string, secret: Buffer): Promise<void>;
  remove(name: string): Promise<void>;
  /** Whether a sealed copy exists. */
  saved(name: string): boolean;
  /** Unseals a saved secret into memory; failures return undefined. */
  load(name: string): Promise<Buffer | undefined>;
  /** Why saving can't work here, if it can't. */
  unavailable(): string | undefined;
}

/** Seals `secret` into `out`, bound to the credential name `id`. */
export type Seal = (id: string, secret: Buffer, out: string) => Promise<void>;

/** Unseals `file`, bound to credential name `id`, into memory only. */
export type Unseal = (id: string, file: string) => Promise<Buffer>;

/**
 * Secrets are sealed in `dir` with `systemd-creds encrypt` (TPM where one
 * exists, else the host key). lyricad unseals them itself at startup with
 * `systemd-creds decrypt --user`, reading only the child's stdout pipe.
 * Plaintext never goes to disk or /run. A non-root service user seals with
 * `--user` (systemd 256 or later), so no root step is needed.
 */
export class SystemdCredentials implements CredentialStore {
  constructor(
    /** Sealed files, one per name. */
    readonly dir: string,
    private readonly seal: Seal = systemdSeal,
    private readonly unseal: Unseal = systemdUnseal,
    private readonly log: (line: string) => void = (line) => { process.stderr.write(`${line}\n`); },
  ) {}

  async save(name: string, secret: Buffer): Promise<void> {
    const out = this.path(name);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${out}.tmp`;
    try {
      await this.seal(`lyrica_${name}`, secret, tmp);
      renameSync(tmp, out);
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  async remove(name: string): Promise<void> { rmSync(this.path(name), { force: true }); }

  saved(name: string): boolean { return existsSync(this.path(name)); }

  async load(name: string): Promise<Buffer | undefined> {
    const file = this.path(name);
    if (!existsSync(file)) return undefined;
    try {
      const secret = await this.unseal(`lyrica_${name}`, file);
      if (!secret.length) throw new UnsealFailed("empty output");
      return secret;
    } catch (err) {
      // Only our fixed failure classes are printable; injected errors may contain secrets.
      const reason = err instanceof UnsealFailed ? err.message : "unseal error";
      this.log(`credential ${name}: decrypt failed: ${reason}`);
      return undefined;
    }
  }

  unavailable(): string | undefined {
    return this.seal === systemdSeal && !onPath("systemd-creds") ? "systemd-creds is not installed" : undefined;
  }

  private path(name: string): string { return join(this.dir, checkName(name)); }
}

function checkName(name: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(name)) throw new Error(`unusable credential name: ${name}`);
  return name;
}

const onPath = (cmd: string) => (process.env.PATH ?? "").split(":").some((d) => d && existsSync(join(d, cmd)));

/** `systemd-creds encrypt`, reading the secret on stdin so it never touches disk unsealed. */
export const systemdSeal: Seal = (id, secret, out) => new Promise((resolve, reject) => {
  const user = process.getuid?.() !== 0 ? ["--user"] : [];
  const child = spawn("systemd-creds", ["encrypt", `--name=${id}`, ...user, "-", out], { stdio: ["pipe", "ignore", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  child.on("error", reject);
  child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`systemd-creds encrypt failed: ${err.trim() || `exit ${code}`}`))));
  child.stdin.on("error", () => {}); // the exit code says why
  child.stdin.end(secret);
});

class UnsealFailed extends Error {}

/** Plaintext is read from stdout only; stderr is discarded because it may contain data. */
export const systemdUnseal: Unseal = (id, file) => new Promise((resolve, reject) => {
  const child = spawn("systemd-creds", ["decrypt", "--user", `--name=${id}`, file, "-"], { stdio: ["ignore", "pipe", "ignore"] });
  const chunks: Buffer[] = [];
  const clear = () => { for (const chunk of chunks) chunk.fill(0); };
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.on("error", (err: NodeJS.ErrnoException) => {
    clear();
    reject(new UnsealFailed(err.code === "ENOENT" ? "command missing" : "spawn error"));
  });
  child.on("close", (code) => {
    if (code !== 0) {
      clear();
      reject(new UnsealFailed(code === null ? "terminated" : `exit ${code}`));
    } else {
      const secret = Buffer.concat(chunks);
      clear();
      resolve(secret);
    }
  });
});
