// The shapes of Pi's ReadOperations, WriteOperations, EditOperations and
// BashOperations, restated so core stays free of Pi. They are structurally
// identical, so the extension passes them straight to Pi's create*Tool.

export interface ToolOps {
  read: {
    readFile(path: string): Promise<Buffer>;
    access(path: string): Promise<void>;
    detectImageMimeType(path: string): Promise<string | null>;
  };
  write: {
    /** A Buffer is written as is: putting back a snapshot (Pi's tools pass text). */
    writeFile(path: string, content: string | Buffer): Promise<void>;
    mkdir(dir: string): Promise<void>;
  };
  edit: {
    readFile(path: string): Promise<Buffer>;
    writeFile(path: string, content: string | Buffer): Promise<void>;
    access(path: string): Promise<void>;
  };
  bash: {
    exec(command: string, cwd: string, options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    }): Promise<{ exitCode: number | null }>;
  };
}

/** Where her tools run: "sandbox" or "ssh:<name>". */
export interface ExecutionTarget {
  readonly name: string;
  /** The directory relative paths resolve against, as the target sees it. */
  cwd(): Promise<string>;
  /** A unique alias of this thread’s own folder, so git worktree records differ across sandboxes. */
  worktreeRoot?(): Promise<string>;
  ops(): ToolOps;
  /** Host folders, or `<ssh name>:<path>`, for pages about them. */
  folders(): string[];
  /** Runs argv, no shell, under the target's own network rules (the sandbox has it; web_fetch uses it). */
  run?(argv: string[], o?: { signal?: AbortSignal; timeoutMs?: number; cwd?: string; onData?: (data: Buffer) => void; maxBytes?: number }): Promise<{ code: number | null; stdout: Buffer; stderr: Buffer }>;
  /** The credentials its runs hold (the sandbox's tokens), so they can be hidden in output and kept out of calls that leave. */
  secrets?(): string[];
}

export const SECRET_HIDDEN = "[credential hidden]";

/** Whether `text` holds any of `secrets`. */
export const holdsSecret = (text: string, secrets: readonly string[]): boolean => secrets.some((s) => text.includes(s));

/** `content` with each of `secrets` replaced. Bytes are kept as they are otherwise. */
export function maskSecrets(content: Buffer, secrets: readonly string[]): Buffer {
  if (!secrets.length) return content;
  let s = content.toString("latin1");
  let changed = false;
  for (const secret of secrets) {
    const raw = Buffer.from(secret).toString("latin1");
    if (s.includes(raw)) { s = s.split(raw).join(SECRET_HIDDEN); changed = true; }
  }
  return changed ? Buffer.from(s, "latin1") : content;
}

/**
 * Passes output on with each of `secrets` replaced, holding back the end of
 * a chunk only while it could be the start of one, so a secret split across
 * two chunks is caught too and other output isn't delayed.
 */
export function secretMasker(secrets: readonly string[], onData: (data: Buffer) => void): { push(data: Buffer): void; end(): void } {
  if (!secrets.length) return { push: onData, end: () => {} };
  const raw = secrets.map((s) => Buffer.from(s).toString("latin1"));
  const longest = Math.max(...raw.map((s) => s.length - 1));
  /** How many bytes at the end of `s` begin a secret. */
  const pending = (s: string) => {
    for (let k = Math.min(longest, s.length); k > 0; k--) if (raw.some((r) => r.startsWith(s.slice(-k)))) return k;
    return 0;
  };
  let held: Buffer = Buffer.alloc(0);
  return {
    push(data) {
      const all = maskSecrets(Buffer.concat([held, data]), secrets);
      const cut = all.length - pending(all.toString("latin1"));
      held = all.subarray(cut);
      if (cut) onData(all.subarray(0, cut));
    },
    end() {
      if (held.length) onData(maskSecrets(held, secrets));
      held = Buffer.alloc(0);
    },
  };
}

/** Image type from the first bytes of a file, for the types Pi's read tool shows as images. */
export function sniffImage(head: Buffer): string | null {
  const starts = (...bytes: number[]) => bytes.every((b, i) => head[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && head.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

const HEAD = 20 * 1024;
const TAIL = 20 * 1024;
const LINES = 800;

/**
 * Passes command output on while it is short, then keeps only the tail.
 * Pi writes any output over its limits (50 KB or 2,000 lines) to a plaintext
 * temp file on the host, so what reaches Pi always stays under them.
 */
export function capOutput(onData: (data: Buffer) => void): { push(data: Buffer): void; end(): void } {
  let sent = 0;
  let lines = 0;
  let tail: Buffer[] = [];
  let tailBytes = 0;
  let dropped = 0;
  const newlines = (b: Buffer) => { let n = 0; for (const c of b) if (c === 10) n++; return n; };
  return {
    push(data) {
      if (!tail.length && sent + data.length <= HEAD && lines + newlines(data) <= LINES) {
        sent += data.length;
        lines += newlines(data);
        return onData(data);
      }
      tail.push(data);
      tailBytes += data.length;
      while (tail.length > 1 && tailBytes - tail[0]!.length >= TAIL) {
        tailBytes -= tail[0]!.length;
        dropped += tail.shift()!.length;
      }
    },
    end() {
      if (!tail.length) return;
      let rest = Buffer.concat(tail);
      tail = [];
      const cut = Math.max(0, rest.length - TAIL);
      rest = rest.subarray(cut);
      const lastLines = rest.toString("utf8").split("\n").slice(-LINES).join("\n");
      dropped += rest.length - Buffer.byteLength(lastLines) + cut;
      onData(Buffer.from(`\n[… ${dropped} bytes of output left out …]\n${lastLines}`));
    },
  };
}
