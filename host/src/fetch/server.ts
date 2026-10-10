// fetch's own small API, for host-api only. It listens on the internal `fetch-api`
// network and answers only host-api's address.
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { DownloadError, plainError } from "./net.ts";
import { shown, type Downloader } from "./downloads.ts";

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1 << 20) throw new DownloadError("Too large.", 413);
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function send(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

export function fetchServer(d: Downloader, isCaller: (address: string) => Promise<boolean>): http.Server {
  return http.createServer(async (req, res) => {
    try {
      if (!(await isCaller((req.socket.remoteAddress ?? "").replace(/^::ffff:/, "")))) {
        res.socket?.destroy();
        return;
      }
      const url = new URL(req.url ?? "/", "http://fetch");
      const method = req.method ?? "GET";
      const path = url.pathname;
      if (path === "/list" && method === "POST") {
        const b = await body(req);
        return send(res, 200, await d.listRepo(b.source, b.repo, b.revision, b.token));
      }
      if (path === "/downloads" && method === "POST") {
        const { token, ...request } = await body(req);
        return send(res, 202, { downloads: (await d.request(request, token)).map(shown) });
      }
      if (path === "/downloads" && method === "GET") return send(res, 200, { downloads: d.list().map(shown) });
      const one = path.match(/^\/downloads\/([0-9a-f-]{36})$/);
      if (one && method === "GET") {
        const found = d.get(one[1]!);
        return found ? send(res, 200, shown(found)) : send(res, 404, { error: { code: "not_found", message: "No such download." } });
      }
      if (one && method === "DELETE") {
        d.cancel(one[1]!);
        return send(res, 200, {});
      }
      if (path === "/record" && method === "GET") return send(res, 200, { files: d.record() });
      if (path === "/delete" && method === "POST") return send(res, 200, { deleted: await d.remove((await body(req)).path) });
      if (path === "/space" && method === "GET") return send(res, 200, { free: d.free() });
      send(res, 404, { error: { code: "not_found", message: "Not found." } });
    } catch (e) {
      const err = e instanceof SyntaxError ? new DownloadError("The body isn't valid JSON.") : plainError(e);
      const [http, code] =
        err.status === 401 || err.status === 403 ? [403, "refused"]
        : err.status === 404 ? [404, "not_found"]
        : err.status === 507 ? [507, "no_space"]
        : err.status === 503 ? [503, "unavailable"]
        : [400, "invalid"];
      send(res, http, { error: { code, message: err.message } });
    }
  });
}
