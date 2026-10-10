import type { IncomingMessage, ServerResponse } from "node:http";

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
