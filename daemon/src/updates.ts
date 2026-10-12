import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import type { BusyItem, Health, KeptRelease, RollbackInfo, UpdateNote, Updates, UpdaterState } from "./api.ts";
import { HttpError, sendJson } from "./http.ts";

// lyricad's side of updates (docs/daemon.md "Updates"). The updater runs as
// root, outside lyricad: it reads health and drains over update.sock, picks up
// requests from a folder only lyricad writes, and leaves its state in files
// lyricad only reads. A broken release can't change what removes it.

export interface UpdatePaths {
  /** The updater's state, written by root: state.json and releases.json. */
  state: string;
  /** Where lyricad writes request.json for lyrica-update.path. Inside LYRICA_HOME, so it is never granted to a thread. */
  requests: string;
}

type Schema = { self: number; user: number; pool: number };
const KINDS = ["self", "user", "pool"] as const;

/** releases.json, written by lyrica-update, lyrica-rollback and lyrica-snapshot. */
interface ReleasesFile {
  current?: string;
  previous?: string;
  releases?: { commit: string; builtAt: string; tag?: string; schema: Schema; minReader: Schema }[];
  /** The highest min_reader any release that ran since the last restore may have written: what a release must read. */
  minReader?: Schema;
  snapshots?: { dir: string; at: string; commit: string; minReader: Schema }[];
}

/** state.json, written by lyrica-update and lyrica-rollback. */
interface StateFile {
  state?: UpdaterState;
  since?: string;
  tag?: string;
  commit?: string;
  busy?: BusyItem[];
  error?: string;
  note?: UpdateNote;
  lastRollback?: RollbackInfo;
}

function readJson<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; }
}

const reads = (release: Schema, needed: Schema) => KINDS.every((k) => (release[k] ?? 0) >= (needed[k] ?? 0));

/** What Administration → Updates shows. */
export function readUpdates(paths: UpdatePaths, running: { version: string; build: string }): Updates {
  const file = readJson<ReleasesFile>(join(paths.state, "releases.json"));
  const state = readJson<StateFile>(join(paths.state, "state.json")) ?? {};
  const kept = (file?.releases ?? []).slice().sort((a, b) => b.builtAt.localeCompare(a.builtAt));
  const needed = file?.minReader ?? { self: 0, user: 0, pool: 0 };
  const snapshots = (file?.snapshots ?? []).slice().sort((a, b) => b.at.localeCompare(a.at));
  const possible = (r: (typeof kept)[number]) => reads(r.schema, needed) || snapshots.some((s) => reads(r.schema, s.minReader));
  const oldest = kept.filter(possible).at(-1)?.commit;
  const releases: KeptRelease[] = kept.map((r) => {
    const rollback: KeptRelease["rollback"] = reads(r.schema, needed)
      ? { possible: true }
      : (() => {
        const snapshot = snapshots.find((s) => reads(r.schema, s.minReader));
        return snapshot ? { possible: true, restores: snapshot.at } : { possible: false, ...(oldest ? { oldest } : {}) };
      })();
    return {
      commit: r.commit, builtAt: r.builtAt, ...(r.tag ? { tag: r.tag } : {}),
      running: r.commit === file?.current, previous: r.commit === file?.previous, rollback,
    };
  });
  return {
    available: !!file,
    running,
    note: state.note ?? null,
    state: {
      state: state.state ?? "idle", since: state.since ?? "",
      ...(state.tag ? { tag: state.tag } : {}), ...(state.commit ? { commit: state.commit } : {}),
      ...(state.busy ? { busy: state.busy } : {}), ...(state.error ? { error: state.error } : {}),
    },
    releases,
    lastRollback: state.lastRollback ?? null,
  };
}

const TAG = /^update\/[A-Za-z0-9._-]{1,64}$/;
const COMMIT = /^[0-9a-f]{7,40}$/;

export type UpdateAction = { action: "update"; tag: string } | { action: "rollback"; commit: string } | { action: "check" };

/** Writes the request lyrica-update.path picks up. One at a time; the updater checks it again as root. */
export function writeRequest(paths: UpdatePaths, req: UpdateAction): void {
  if (req.action === "update" && !TAG.test(req.tag)) throw new HttpError(400, "an update is an update/… tag");
  if (req.action === "rollback" && !COMMIT.test(req.commit)) throw new HttpError(400, "name the release by its commit");
  const busy = readJson<StateFile>(join(paths.state, "state.json"))?.state;
  if (req.action !== "check" && busy && busy !== "idle" && busy !== "failed" && !(busy === "probation" && req.action === "rollback")) {
    throw new HttpError(409, "an update is running");
  }
  mkdirSync(paths.requests, { recursive: true, mode: 0o700 });
  const target = join(paths.requests, "request.json");
  if (existsSync(target)) throw new HttpError(409, "a request is already waiting for the updater");
  const tmp = join(paths.requests, ".request.json");
  writeFileSync(tmp, `${JSON.stringify(req)}\n`, { mode: 0o600 });
  renameSync(tmp, target);
}

/** The work a drain waits for, as lyricad reports it. */
export interface Drainable {
  readonly locked: boolean;
  draining: boolean;
  busy(): BusyItem[];
  health(): Promise<Health>;
  undrained(): void;
}

/**
 * The update socket: GET /health, POST /drain, POST /undrain. Owner-only, like
 * lyricad.sock; no login, since only root and the service user can connect.
 */
export async function listenUpdateSocket(path: string, d: Drainable, log: (line: string) => void): Promise<Server> {
  rmSync(path, { force: true });
  const server = createServer((req, res) => {
    void (async () => {
      const route = `${req.method} ${new URL(req.url ?? "/", "http://update").pathname}`;
      try {
        if (route === "GET /health") return sendJson(res, 200, await d.health());
        if (route === "POST /drain") {
          if (!d.draining) log("draining for an update");
          d.draining = true;
          return sendJson(res, 200, { busy: d.busy() });
        }
        if (route === "POST /undrain") {
          if (d.draining) log("undrained");
          d.draining = false;
          d.undrained();
          return sendJson(res, 200, { ok: true });
        }
        sendJson(res, 404, { error: "not found" });
      } catch (err) {
        log(`update socket: ${route} failed: ${(err as Error).name}`);
        sendJson(res, 500, { error: "internal error" });
      }
    })();
  });
  const umask = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  } finally {
    process.umask(umask);
  }
  chmodSync(path, 0o600);
  return server;
}
