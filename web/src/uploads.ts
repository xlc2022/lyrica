// Sends a model file from this computer to a model host, piece by piece (docs/briefs/model-upload.md; host/API.md
// "Uploads"). The sending lives here, outside any page, so it carries on while the user moves around the app; the
// Downloads tab lists each upload from its host and asks here whether this tab is sending it. Closing the tab stops
// it: the browser asks first while anything is being sent.
import { useSyncExternalStore } from "react";
import { get, HttpError, post, request, u, type HostDownload } from "./api.ts";

/** One request's piece. The host takes up to 64 MiB; 32 keeps a lost piece cheap on a slow link. */
export const PIECE = 32 * 1024 * 1024;
/** Waits before sending a piece again after the connection or the host failed, five in a row at most. */
const RETRIES = [2_000, 5_000, 15_000, 30_000, 60_000];

/** Room the host keeps free beyond a file (host/API.md, "Downloads"). */
export const MARGIN = 1024 ** 3;

const key = (hostId: string, id: string) => `${hostId}/${id}`;
/** The uploads this tab is sending now, and why each one it stopped stopped. */
const sending = new Map<string, () => void>();
const stopped = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;
const changed = () => { version++; for (const l of listeners) l(); };

/** Re-renders a page when this tab starts or stops sending an upload. */
export function useSending(): number {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => version);
}
export const isSending = (hostId: string, id: string) => sending.has(key(hostId, id));
/** Why this tab stopped sending an upload, until it is sent again. */
export const whyStopped = (hostId: string, id: string) => stopped.get(key(hostId, id));
/** Stops sending one (before it is cancelled on the host). */
export function stopSending(hostId: string, id: string) { sending.get(key(hostId, id))?.(); }

function warnBeforeLeaving(e: BeforeUnloadEvent) {
  if (!sending.size) return;
  e.preventDefault();
  e.returnValue = "";
}

/** Whether a failure is the connection or the host's trouble, worth sending the piece again. */
const temporary = (e: unknown) => e instanceof HttpError && (e.status === 0 || e.status === 408 || e.status === 429 || e.status >= 500);

/**
 * Starts one file's upload on a host, or carries on the unfinished one with its name and size, and sends its pieces in
 * the background. Resolves once the host lists it, so the page can move on to Downloads.
 */
export async function upload(userId: string, hostId: string, file: File): Promise<HostDownload> {
  const base = u(userId, "hosts", hostId, "uploads");
  const first = await post<HostDownload>(base, { name: file.name, size: file.size });
  const k = key(hostId, first.id);
  if (sending.has(k)) return first;
  const stop = { stopped: false };
  sending.set(k, () => { stop.stopped = true; sending.delete(k); changed(); });
  stopped.delete(k);
  if (sending.size === 1) addEventListener("beforeunload", warnBeforeLeaving);
  changed();
  void (async () => {
    let at = first.received;
    let tries = 0;
    try {
      while (!stop.stopped && at < file.size) {
        try {
          const d = await request<HostDownload>("PUT", `${base}/${first.id}?offset=${at}`, file.slice(at, Math.min(at + PIECE, file.size)));
          if (d.state !== "uploading") break;
          if (d.received > at) tries = 0;
          at = d.received;
        } catch (e) {
          if (stop.stopped) break;
          if (e instanceof HttpError && e.status === 409) {
            // Out of step with the host, or cancelled there: carry on from what it has, if it still waits.
            const list = await get<{ downloads: HostDownload[] }>(u(userId, "hosts", hostId, "downloads"));
            const now = list.downloads.find((x) => x.id === first.id);
            if (now?.state !== "uploading") break;
            at = now.received;
            continue;
          }
          if (!temporary(e) || tries >= RETRIES.length) throw e;
          await new Promise((r) => setTimeout(r, RETRIES[tries++]));
        }
      }
    } catch (e) {
      stopped.set(k, (e as Error).message);
    } finally {
      sending.delete(k);
      if (!sending.size) removeEventListener("beforeunload", warnBeforeLeaving);
      changed();
    }
  })();
  return first;
}
