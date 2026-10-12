import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";

// Claude Code's way to Anthropic for one sandbox run (docs/workspace.md,
// "Claude Code"). The user's token stays in lyricad: the run gets this
// relay's address, forwarded into its sandbox, and a random capability in
// place of the token. The relay checks the capability, swaps in the token
// and forwards only /v1/ requests to Anthropic. It logs nothing and keeps
// nothing, and closes when the run ends, so a capability read from the
// run's environment is worth nothing afterwards or anywhere else.

/** Where Claude Code's requests go, and the host a run's network must reach for it to be given Claude Code. */
export const ANTHROPIC_API = "https://api.anthropic.com";

/** Headers never passed on: the capability, any key the run set, and what Node's request sets itself. */
const DROPPED = new Set(["authorization", "x-api-key", "host", "connection", "keep-alive", "proxy-authorization", "transfer-encoding", "upgrade"]);

export interface ClaudeRelay {
  /** The loopback port the relay listens on, forwarded into the run's sandbox. */
  port: number;
  /** What the run sends as its bearer token: random, for this run only. */
  capability: string;
  close(): void;
}

/** Opens a relay for one run. `upstream` is for tests. */
export async function openClaudeRelay(token: string, upstream = ANTHROPIC_API): Promise<ClaudeRelay> {
  const capability = randomBytes(32).toString("base64url");
  const expected = Buffer.from(`Bearer ${capability}`);
  const base = new URL(upstream);
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const given = Buffer.from(String(req.headers.authorization ?? ""));
    const path = req.url ?? "";
    if (given.length !== expected.length || !timingSafeEqual(given, expected) || !path.startsWith("/v1/")) {
      req.resume();
      res.writeHead(401, { "content-type": "application/json" }).end('{"type":"error","error":{"type":"authentication_error","message":"not this run\'s relay"}}');
      return;
    }
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !DROPPED.has(k)) headers[k] = v;
    headers.authorization = `Bearer ${token}`;
    const request = base.protocol === "https:" ? httpsRequest : httpRequest;
    const out = request({ protocol: base.protocol, hostname: base.hostname, port: base.port || undefined, method: req.method, path, headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    out.on("error", () => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy(); });
    req.pipe(out);
  });
  // No keep-alive across runs: close() ends every connection.
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    port: (server.address() as AddressInfo).port,
    capability,
    close: () => { server.close(); server.closeAllConnections(); },
  };
}
