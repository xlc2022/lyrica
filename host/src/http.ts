import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

/** An error with a code and plain message from API.md's table. */
export class HostError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const invalid = (message: string) => new HostError(400, "invalid", message);
export const refused = (message: string) => new HostError(403, "refused", message);
export const notFound = (message = "Not found.") => new HostError(404, "not_found", message);

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(text);
}

export function sendError(res: ServerResponse, err: HostError): void {
  sendJson(res, err.status, { error: { code: err.code, message: err.message } });
}

/** Reads a JSON object body of at most `limit` bytes. */
export async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HostError(400, "invalid", "The request is too large.");
    chunks.push(chunk as Buffer);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw invalid("The body isn't valid JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("The body must be a JSON object.");
  return body as Record<string, unknown>;
}

/** Refuses fields other than `allowed`. */
export function onlyFields(body: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length) throw invalid(`Unknown field: ${extra[0]}.`);
}

/** The file fields a job's multipart request may carry (API.md, "Sending files"); `references` may repeat. */
const FILE_FIELDS = new Set(["image", "mask", "references", "drive", "extend", "source", "video"]);

/**
 * A job's body of at most `limit` bytes: JSON with its files in base64, or multipart/form-data whose `json` part holds
 * the fields and whose other parts are the files as bytes, set on the body as Buffers (`references` a list). `form`
 * says it came as a form, so its answer goes as one too (sendJob). A form's files never pass through a string.
 */
export async function readJob(req: IncomingMessage, limit: number): Promise<{ body: Record<string, unknown>; form: boolean }> {
  const type = req.headers["content-type"] ?? "";
  if (!/^multipart\/form-data\s*;/i.test(type)) return { body: await readJson(req, limit), form: false };
  let size = 0, tooBig = false;
  const counted = Readable.from((async function* () {
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > limit) { tooBig = true; throw new HostError(400, "invalid", "The request is too large."); }
      yield chunk as Buffer;
    }
  })());
  let form: FormData;
  try { form = await new Response(Readable.toWeb(counted) as ReadableStream, { headers: { "content-type": type } }).formData(); }
  catch { throw tooBig ? new HostError(400, "invalid", "The request is too large.") : invalid("The body isn't a valid form."); }
  const json = form.get("json");
  if (typeof json !== "string") throw invalid("The form has no json part.");
  let body: unknown;
  try { body = JSON.parse(json); } catch { throw invalid("The form's json part isn't valid JSON."); }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("The form's json part must be a JSON object.");
  const fields = body as Record<string, unknown>;
  for (const name of new Set([...form.keys()])) {
    if (name === "json") continue;
    if (!FILE_FIELDS.has(name)) throw invalid(`Unknown field: ${name}.`);
    if (name in fields) throw invalid(`${name} is both a field and a file.`);
    const parts = form.getAll(name);
    if (parts.some((p) => typeof p === "string")) throw invalid(`${name} must be a file.`);
    const bytes = await Promise.all(parts.map(async (p) => Buffer.from(await (p as Blob).arrayBuffer())));
    if (name !== "references" && bytes.length > 1) throw invalid(`${name} is given more than once.`);
    fields[name] = name === "references" ? bytes : bytes[0];
  }
  return { body: fields, form: true };
}

/** A file in a job's answer: its form part's name, and its bytes. */
export interface JobFile { name: string; bytes: Buffer; type: string }

/**
 * A job's answer: as a form when its request came as one (`body` in the `json` part, each file a part of its own, in
 * order), else as JSON, where `inline` puts the files in `body` as base64.
 */
export async function sendJob(res: ServerResponse, form: boolean, body: Record<string, unknown>, files: JobFile[], inline: () => Record<string, unknown>): Promise<void> {
  if (!form) return sendJson(res, 200, inline());
  const out = new FormData();
  out.set("json", JSON.stringify(body));
  for (const f of files) out.append(f.name, new Blob([f.bytes], { type: f.type }), f.name);
  const answer = new Response(out);
  res.writeHead(200, { "content-type": answer.headers.get("content-type")!, "cache-control": "no-store" });
  for await (const chunk of answer.body!) if (!res.write(chunk)) await new Promise((r) => res.once("drain", r));
  res.end();
}
