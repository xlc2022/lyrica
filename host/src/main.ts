// host-api's entry point, run in its container.
import { readFileSync } from "node:fs";
import { stdoutLog } from "./log.ts";
import { Host } from "./server.ts";

/** Docker's gateway on our default route: where the published loopback port arrives from. */
function defaultGateway(): string[] {
  for (const line of readFileSync("/proc/net/route", "utf8").split("\n").slice(1)) {
    const [, dest, gw] = line.trim().split(/\s+/);
    if (dest === "00000000" && gw) return [Buffer.from(gw, "hex").reverse().join(".")];
  }
  return [];
}

const env = process.env;
const name = env.HOST_NAME || "lyrica-host";
const host = new Host({
  dataDir: env.DATA_DIR || "/data",
  name,
  version: env.HOST_VERSION || "dev",
  names: [name, ...(env.HOST_NAMES ?? "").split(",")].map((n) => n.trim()).filter(Boolean),
  tailnetName: env.TAILNET_NAME || undefined,
  localPeers: env.LOCAL_PEERS ? env.LOCAL_PEERS.split(",") : defaultGateway(),
  modelsDir: env.MODELS_DIR || "/models",
  modelsHostPath: env.MODELS_HOST_PATH || "/models",
  log: stdoutLog,
});
await host.listen(Number(env.TLS_PORT || 7443), Number(env.LOCAL_PORT || 7080));
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => void host.close().then(() => process.exit(0)));
