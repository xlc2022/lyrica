// Updates from Lyrica (README.md, "Updates"). host-api writes a request into
// the updater's inbox and reads its state; the updater (update.sh) runs as
// root outside the container, fetches and checks the tag itself, and pauses
// and resumes host-api through the dashboard port at the machine. The same
// updater moves the host to another models folder, checked again as root.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HostError, invalid } from "./http.ts";

export type UpdateState = "idle" | "requested" | "fetching" | "draining" | "building" | "rolling-back" | "failed";

export interface UpdateStatus {
  available: boolean;
  /** Why it isn't, in words for the person. */
  reason?: string;
  /** The updater also takes a new models folder (installed by a recent install.sh). */
  changesFolder: boolean;
  /** The updater also takes a commit: Lyrica's latest merge, or the commit her tag must point at (a recent install.sh). */
  commits: boolean;
  state: UpdateState;
  since?: string;
  tag?: string;
  /** The models folder asked for, while the updater moves the host to it or after it failed. */
  models?: string;
  /** The step that failed. */
  error?: string;
  /** The last run: an update (tag) or a new models folder (models). */
  last?: { tag?: string; models?: string; commit: string; at: string; ok: boolean };
}

const TAG = /^update\/[A-Za-z0-9._-]{1,64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
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
      changesFolder: available && file.changesFolder === true,
      commits: available && file.commits === true,
      state,
      ...(file.since ? { since: file.since } : {}),
      ...(file.tag ? { tag: file.tag } : {}),
      ...(file.models ? { models: file.models } : {}),
      ...(file.error ? { error: file.error } : {}),
      ...(file.last ? { last: file.last } : {}),
    };
  }

  /** Asks the updater for this release. It checks the tag again, as root. */
  /**
   * Asks the updater for Lyrica's release: an update/… tag, her commit (the latest merge), or both, when the tag
   * must point at that commit. A commit needs an updater that takes one (`commits`); Lyrica sends the tag alone otherwise.
   */
  request(tag: unknown, commit?: unknown): UpdateStatus {
    if (tag !== undefined && (typeof tag !== "string" || !TAG.test(tag))) throw invalid("tag must be an update/… tag.");
    if (commit !== undefined && (typeof commit !== "string" || !COMMIT.test(commit))) throw invalid("commit must be a full commit hash.");
    if (tag === undefined && commit === undefined) throw invalid("tag or commit is required.");
    const now = this.status();
    if (commit !== undefined && now.available && !now.commits) throw new HostError(409, "unavailable", "This host's updater can't take a commit yet: run install.sh on the host again.");
    return this.ask({ ...(tag !== undefined ? { tag: tag as string } : {}), ...(commit !== undefined ? { commit: commit as string } : {}) });
  }

  /** Asks the updater to move the host to another models folder. It checks the folder again, as root. */
  requestModels(path: unknown): UpdateStatus {
    if (typeof path !== "string" || !path.startsWith("/") || path.length > 4096 || /[\u0000-\u001f\u007f]/.test(path)) throw invalid("path must be an absolute path on the host machine.");
    const now = this.status();
    if (now.available && !now.changesFolder) throw new HostError(409, "unavailable", "This host's updater can't change the models folder yet: run install.sh on the host again.");
    return this.ask({ models: path });
  }

  private ask(request: { tag?: string; commit?: string } | { models: string }): UpdateStatus {
    const now = this.status();
    if (!now.available) throw new HostError(409, "unavailable", now.reason!);
    if (BUSY.has(now.state)) throw new HostError(409, "updating", "An update is already running.");
    const file = join(this.dir, "inbox", "request.json");
    writeFileSync(`${file}.tmp`, JSON.stringify(request), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    return this.status();
  }
}
