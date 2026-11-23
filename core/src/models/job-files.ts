// Principle 1: a model host's job takes its images and clips, and gives its results, as bytes in a multipart form
// (host/API.md, "Sending files"), not as base64 in JSON: a third smaller on the wire, and never a string, so a clip
// isn't bounded by Node's longest string. A host from before forms (2026-11) refuses one as not JSON: the job is
// sent again as JSON, so a daemon updated first keeps working until Update… reaches its hosts. In memory only.
import { HostRefused } from "./host.ts";

/** A job's files by field: `references` is a list, the rest one file each. */
export type JobFiles = Record<string, Uint8Array | Uint8Array[] | undefined>;

/** A host answer's files by part name, each in the order the answer gave them. */
export const FILES = Symbol("job files");
export type JobAnswer = Record<string, any> & { [FILES]?: Record<string, Buffer[]> };

/** The job as a form: its fields in the `json` part, each file a part named by its field. */
export function jobForm(fields: Record<string, unknown>, files: JobFiles): FormData {
  const form = new FormData();
  form.set("json", JSON.stringify(fields));
  for (const [name, v] of Object.entries(files)) {
    for (const bytes of v === undefined ? [] : Array.isArray(v) ? v : [v]) form.append(name, new Blob([bytes as Uint8Array<ArrayBuffer>]), name);
  }
  return form;
}

/**
 * The most file bytes a job as JSON carries: its base64 must fit one Node string (536,870,888 characters), and a host
 * from before forms takes a clip of at most 256 MB anyway.
 */
const JSON_FILE_BYTES = 360 * 1024 * 1024;

/** The job as JSON, its files in base64 in their fields: what a host from before forms takes. */
export function jobJson(fields: Record<string, unknown>, files: JobFiles): string {
  const total = Object.values(files).flatMap((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v])).reduce((n, b) => n + b.length, 0);
  if (total > JSON_FILE_BYTES) throw new HostRefused("invalid", "This host is from before it took files as bytes, and these are too large for it: run Update… on it.");
  const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
  const inline = Object.fromEntries(Object.entries(files).filter(([, v]) => v !== undefined).map(([k, v]) => [k, Array.isArray(v) ? v.map(b64) : b64(v!)]));
  return JSON.stringify({ ...fields, ...inline });
}

/** A host from before forms: its JSON reader refused the form (host/src/http.ts readJson). */
const beforeForms = (e: unknown) => e instanceof HostRefused && e.code === "invalid" && /body isn't valid JSON/.test(e.message);

/** Sends a job as a form, and as JSON again when the host is from before forms. */
export async function postJob<T>(fields: Record<string, unknown>, files: JobFiles, send: (body: FormData | string, headers: Record<string, string>) => Promise<T>): Promise<T> {
  // fetch sets the form's content type, with its boundary.
  try { return await send(jobForm(fields, files), {}); }
  catch (e) {
    if (!beforeForms(e)) throw e;
    return send(jobJson(fields, files), { "content-type": "application/json" });
  }
}

/** A host's answer: a form's `json` part with its files beside it under FILES, or a JSON answer as it is. */
export async function readAnswer(res: Response): Promise<JobAnswer> {
  if (!/^multipart\/form-data\s*;/i.test(res.headers.get("content-type") ?? "")) return await res.json() as JobAnswer;
  const form = await res.formData();
  const json = form.get("json");
  const out = JSON.parse(typeof json === "string" ? json : "null") as unknown;
  if (!out || typeof out !== "object" || Array.isArray(out)) throw new Error("the answer's json part isn't an object");
  const files: Record<string, Buffer[]> = {};
  for (const [name, v] of form.entries()) {
    if (name === "json" || typeof v === "string") continue;
    (files[name] ??= []).push(Buffer.from(await v.arrayBuffer()));
  }
  return Object.assign(out, { [FILES]: files }) as JobAnswer;
}
