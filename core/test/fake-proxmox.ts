import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A Proxmox API on 127.0.0.1 with a self-signed certificate, as a node has:
// the few routes the proxmox tool uses, a token it checks, and a record of
// every request that reached it.

export const TOKEN = "lyrica@pve!agent=6b9f4c2e-0d1a-4c3e-9a7b-2f1e8d5c4b3a";

interface Guest { vmid: number; name: string; node: string; type: "qemu" | "lxc"; status: string; config: Record<string, string>; snapshots: { name: string; snaptime?: number; description?: string }[] }

function selfSigned(): { key: string; cert: string; fingerprint: string } {
  const dir = mkdtempSync(join(tmpdir(), "lyrica-pve-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
      "-keyout", join(dir, "k"), "-out", join(dir, "c"), "-days", "2", "-subj", "/CN=pve1"], { stdio: "ignore" });
    const cert = readFileSync(join(dir, "c"), "utf8");
    return { key: readFileSync(join(dir, "k"), "utf8"), cert, fingerprint: new X509Certificate(cert).fingerprint256 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface FakeProxmox {
  address: string;
  port: number;
  fingerprint: string;
  guests: Guest[];
  /** Every request that reached the API: "METHOD path", and the Authorization header it carried. */
  requests: { line: string; auth?: string }[];
  /** Serves a different certificate from now on, and returns its fingerprint. */
  swapCert(): string;
  close(): Promise<void>;
}

export async function fakeProxmox(): Promise<FakeProxmox> {
  const first = selfSigned();
  const guests: Guest[] = [
    { vmid: 101, name: "web", node: "pve1", type: "qemu", status: "running", config: { net0: "virtio=BC:24:11:AA:BB:CC,bridge=vmbr0" },
      snapshots: [{ name: "before-upgrade", snaptime: 1_760_000_000, description: "clean install" }, { name: "current" }] },
    { vmid: 200, name: "db", node: "pve1", type: "lxc", status: "stopped", config: { net0: "name=eth0,bridge=vmbr0,hwaddr=BC:24:11:DD:EE:FF" }, snapshots: [{ name: "current" }] },
  ];
  const requests: FakeProxmox["requests"] = [];
  const server: Server = createServer({ key: first.key, cert: first.cert }, (req, res) => {
    requests.push({ line: `${req.method} ${req.url}`, auth: req.headers.authorization });
    const send = (status: number, data?: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ data: data ?? null })); };
    if (req.headers.authorization !== `PVEAPIToken=${TOKEN}`) return send(401);
    const url = new URL(req.url!, "https://pve1");
    const path = url.pathname.replace(/^\/api2\/json/, "");
    if (req.method === "GET" && path === "/version") return send(200, { version: "9.0.3" });
    if (req.method === "GET" && path === "/cluster/resources") {
      return send(200, guests.map((g) => ({ id: `${g.type}/${g.vmid}`, vmid: g.vmid, name: g.name, node: g.node, type: g.type, status: g.status })));
    }
    const m = /^\/nodes\/([^/]+)\/(qemu|lxc)\/(\d+)\/(.+)$/.exec(path);
    const g = m && guests.find((x) => x.node === m[1] && x.type === m[2] && String(x.vmid) === m[3]);
    if (!m || !g) return send(404);
    const rest = m[4]!;
    if (req.method === "GET" && rest === "status/current") return send(200, { status: g.status, uptime: 90_000, cpu: 0.12, cpus: 4, mem: 2 * 2 ** 30, maxmem: 8 * 2 ** 30 });
    if (req.method === "GET" && rest === "snapshot") return send(200, g.snapshots);
    if (req.method === "GET" && rest === "config") return send(200, g.config);
    const action = /^status\/(start|stop|shutdown|reboot)$/.exec(rest)?.[1];
    if (req.method === "POST" && action) {
      g.status = action === "stop" || action === "shutdown" ? "stopped" : "running";
      return send(200, `UPID:${g.node}:0001:${action}:${g.vmid}:lyrica@pve!agent:`);
    }
    return send(501);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    address: `https://127.0.0.1:${port}`, port, fingerprint: first.fingerprint, guests, requests,
    swapCert() {
      const next = selfSigned();
      server.setSecureContext({ key: next.key, cert: next.cert });
      return next.fingerprint;
    },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
