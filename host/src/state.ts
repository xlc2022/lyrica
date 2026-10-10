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
  /** Seconds of audio transcribed or spoken. */
  audioSeconds: number;
}

export const NO_USAGE = (): Usage => ({ requests: 0, promptTokens: 0, completionTokens: 0, images: 0, seconds: 0, audioSeconds: 0 });

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
  /** One-time changes already made to this file. */
  migrations: string[];
}

const EMPTY: HostState = { clients: [], password: null, paused: false, gpuSettings: {}, models: {}, pins: [], vram: {}, usageSince: "", usage: {}, migrations: [] };

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
    // GPU settings saved before the speech server: it is allowed where the others were.
    if (!this.state.migrations.includes("speech")) {
      for (const g of Object.values(this.state.gpuSettings)) if (g.servers.includes("vllm") && !g.servers.includes("speech")) g.servers.push("speech");
      for (const u of Object.values(this.state.usage)) u.audioSeconds ??= 0;
      this.state.migrations = [...this.state.migrations, "speech"];
    }
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
