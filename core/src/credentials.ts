import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
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
  /** The secret as it was handed to this process at startup, if it was. */
  load(name: string): Buffer | undefined;
  /** Why saving can't work here, if it can't. */
  unavailable(): string | undefined;
}

/** Seals `secret` into `out`, bound to the credential name `id`. */
export type Seal = (id: string, secret: Buffer, out: string) => Promise<void>;

/**
 * systemd credentials. Each secret is sealed with `systemd-creds encrypt`
 * (to the TPM where one exists, else the host key) into `dir`, which the unit
 * loads with `LoadCredentialEncrypted=lyrica:<dir>`. systemd decrypts them at
 * service start into `$CREDENTIALS_DIRECTORY` as `lyrica_<name>`, readable only
 * by the service. A non-root service user seals with `--user` (systemd 256 or
 * later), so no root step is needed.
 */
export class SystemdCredentials implements CredentialStore {
  constructor(
    /** Sealed files, one per name. */
    readonly dir: string,
    /** Where systemd put the unsealed credentials at start: `$CREDENTIALS_DIRECTORY`. */
    private readonly loaded: string | undefined = process.env.CREDENTIALS_DIRECTORY,
    private readonly seal: Seal = systemdSeal,
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

  load(name: string): Buffer | undefined {
    if (!this.loaded) return undefined;
    const path = join(this.loaded, `lyrica_${checkName(name)}`);
    return existsSync(path) ? readFileSync(path) : undefined;
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
