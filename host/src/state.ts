// The host's own state, one JSON file in its data folder. Never holds prompt text or tokens.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GpuSettings, ModelSettings } from "./placement.ts";

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
  /** GPU index → what it may run and keep free; a GPU not listed allows everything. */
  gpuSettings: Record<number, GpuSettings>;
  /** Model ID → its placement and serving settings; a model not listed is Auto with defaults. */
  models: Record<string, ModelSettings>;
  /** Model IDs kept loaded. */
  pins: string[];
  /** "<model ID>@<placement>" → bytes measured on each GPU on its first load there. */
  vram: Record<string, Record<number, number>>;
  usageSince: string;
  usage: Record<string, Usage>;
}

const EMPTY: HostState = { clients: [], password: null, paused: false, gpuSettings: {}, models: {}, pins: [], vram: {}, usageSince: "", usage: {} };

export class StateFile {
  readonly path: string;
  private state: HostState;

  constructor(dir: string) {
    this.path = join(dir, "state.json");
    const stored = existsSync(this.path) ? readFileSync(this.path, "utf8") : null;
    this.state = stored ? { ...EMPTY, ...JSON.parse(stored) } : structuredClone(EMPTY);
    if (!this.state.usageSince) this.state.usageSince = new Date().toISOString();
    // From before placements: pins named a GPU, and VRAM was one number per model.
    this.state.pins = this.state.pins.map((p) => (typeof p === "string" ? p : (p as { model: string }).model));
    for (const [k, v] of Object.entries(this.state.vram)) if (typeof v === "number" || !k.includes("@")) delete this.state.vram[k];
    delete (this.state as { roles?: unknown }).roles;
    // Written back once, so the file on disk is in today's shape.
    if (stored !== null && JSON.stringify(JSON.parse(stored)) !== JSON.stringify(this.state)) this.update(() => {});
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
