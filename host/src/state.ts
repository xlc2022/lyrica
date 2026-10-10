// The host's own state, one JSON file in its data folder. Never holds prompt text or tokens.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PairedClient {
  fingerprint: string;
  name: string;
  cert: string; // PEM, as presented when pairing
  pairedAt: string;
  lastSeen: string | null;
}

export interface Usage {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  images: number;
  seconds: number;
}

export interface HostState {
  clients: PairedClient[];
  /** scrypt$<N>$<salt b64>$<hash b64>, set at the machine. */
  password: string | null;
  paused: boolean;
  /** GPU index → role; a GPU not listed is shared. */
  roles: Record<number, "vllm" | "shared">;
  pins: { model: string; gpu: number }[];
  /** Model ID → bytes of VRAM measured on its first load. */
  vram: Record<string, number>;
  usageSince: string;
  usage: Record<string, Usage>;
}

const EMPTY: HostState = { clients: [], password: null, paused: false, roles: {}, pins: [], vram: {}, usageSince: "", usage: {} };

export class StateFile {
  readonly path: string;
  private state: HostState;

  constructor(dir: string) {
    this.path = join(dir, "state.json");
    this.state = existsSync(this.path) ? { ...EMPTY, ...JSON.parse(readFileSync(this.path, "utf8")) } : structuredClone(EMPTY);
    if (!this.state.usageSince) this.state.usageSince = new Date().toISOString();
  }

  get(): Readonly<HostState> {
    return this.state;
  }

  /** Changes the state and writes it at once (temporary file, then rename). */
  update(change: (s: HostState) => void): void {
    const next = structuredClone(this.state);
    change(next);
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
    this.state = next;
  }

  client(fingerprint: string): PairedClient | undefined {
    return this.state.clients.find((c) => c.fingerprint === fingerprint);
  }
}
