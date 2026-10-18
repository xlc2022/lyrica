// Updates from Lyrica (README.md, "Updates"). host-api writes a request into
// the updater's inbox and reads its state; the updater (update.sh) runs as
// root outside the container, fetches and checks the tag itself, and pauses
// and resumes host-api through the dashboard port at the machine.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HostError, invalid } from "./http.ts";

export type UpdateState = "idle" | "requested" | "fetching" | "draining" | "building" | "rolling-back" | "failed";

export interface UpdateStatus {
  available: boolean;
  /** Why it isn't, in words for the person. */
  reason?: string;
  state: UpdateState;
  since?: string;
  tag?: string;
  /** The step that failed. */
  error?: string;
  last?: { tag: string; commit: string; at: string; ok: boolean };
}

const TAG = /^update\/[A-Za-z0-9._-]{1,64}$/;
const BUSY = new Set<UpdateState>(["requested", "fetching", "draining", "building", "rolling-back"]);

export class Updates {
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  status(): UpdateStatus {
    let file: Partial<UpdateStatus> = {};
    try {
      file = JSON.parse(readFileSync(join(this.dir, "status", "state.json"), "utf8"));
    } catch {}
    const requested = existsSync(join(this.dir, "inbox", "request.json"));
    const state: UpdateState = requested && !BUSY.has(file.state as UpdateState) ? "requested" : ((file.state as UpdateState) ?? "idle");
    const available = file.available === true;
    return {
      available,
      ...(!available ? { reason: typeof file.reason === "string" ? file.reason : "This host has no updater: run install.sh again." } : {}),
      state,
      ...(file.since ? { since: file.since } : {}),
      ...(file.tag ? { tag: file.tag } : {}),
      ...(file.error ? { error: file.error } : {}),
      ...(file.last ? { last: file.last } : {}),
    };
  }

  /** Asks the updater for this release. It checks the tag again, as root. */
  request(tag: unknown): UpdateStatus {
    if (typeof tag !== "string" || !TAG.test(tag)) throw invalid("tag must be an update/… tag.");
    const now = this.status();
    if (!now.available) throw new HostError(409, "unavailable", now.reason!);
    if (BUSY.has(now.state)) throw new HostError(409, "updating", "An update is already running.");
    const file = join(this.dir, "inbox", "request.json");
    writeFileSync(`${file}.tmp`, JSON.stringify({ tag }), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    return this.status();
  }
}
