// Talking to lyricad. The types all come from daemon/src/api.ts.
import type { Pool } from "@lyrica/daemon/api";

export type * from "@lyrica/daemon/api";
export { THREAD_TASKS } from "@lyrica/daemon/api";

/** A refused request, with lyricad's reason in plain words. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const PLAIN: Record<number, string> = {
  401: "You're not logged in.",
  403: "That isn't allowed.",
  404: "That doesn't exist any more.",
  413: "That file is too large.",
  429: "Too many attempts. Wait a little and try again.",
  503: "Lyrica is locked.",
};

/** Called on 401 and 503, so the app can go back to login or unlock. */
let onAuthLost: (status: number) => void = () => {};
export function whenAuthLost(fn: (status: number) => void) { onAuthLost = fn; }

export async function request<T>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined || body instanceof Blob ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body),
      ...init,
    });
  } catch {
    throw new HttpError(0, "Lyrica can't be reached. Check the connection.");
  }
  if (!res.ok) throw await errorFrom(res);
  const text = await res.text();
  return (text ? safeJson(text) : undefined) as T;
}

/** A refused response as an HttpError with lyricad's reason, read from its body. */
export async function errorFrom(res: Response): Promise<HttpError> {
  if (res.status === 401 || res.status === 503) onAuthLost(res.status);
  const data = safeJson(await res.text().catch(() => ""));
  const reason = data && typeof data === "object" && "error" in data ? sentence(String(data.error)) : "";
  return new HttpError(res.status, reason || PLAIN[res.status] || `Something went wrong (${res.status}).`);
}

/** lyricad's reasons are lower-case phrases; show them as sentences. */
function sentence(s: string): string {
  return s && s[0]!.toUpperCase() + s.slice(1) + (/[.!?]$/.test(s) ? "" : ".");
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

export const get = <T>(path: string) => request<T>("GET", path);
export const post = <T>(path: string, body: unknown = {}) => request<T>("POST", path, body);
export const put = <T>(path: string, body: unknown) => request<T>("PUT", path, body);
export const patch = <T>(path: string, body: unknown) => request<T>("PATCH", path, body);
export const del = <T>(path: string, body?: unknown) => request<T>("DELETE", path, body);

const enc = encodeURIComponent;
/** `/api/u/:userId` plus the rest, each segment encoded. */
export const u = (userId: string, ...rest: string[]) => ["/api/u", userId, ...rest].map((s, i) => (i ? enc(s) : s)).join("/");
export const threadPath = (userId: string, pool: Pool, threadId: string, ...rest: string[]) => u(userId, "threads", pool, threadId, ...rest);

/** Uploads report progress, which fetch can't, so they use XMLHttpRequest. */
export function upload(url: string, file: File, onProgress: (fraction: number) => void): Promise<{ path: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onerror = () => reject(new HttpError(0, "The upload was interrupted."));
    xhr.onload = () => {
      const data = safeJson(xhr.responseText) as { path?: string; error?: string } | undefined;
      if (xhr.status >= 200 && xhr.status < 300 && data?.path) resolve({ path: data.path });
      else reject(new HttpError(xhr.status, (data?.error && sentence(data.error)) || PLAIN[xhr.status] || `The upload failed (${xhr.status}).`));
    };
    xhr.send(file);
  });
}
