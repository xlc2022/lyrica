// fetch's entry point, run in its own container: the only one with a route out.
import { lookup } from "node:dns/promises";
import { huggingFace, modelScope } from "./hubs.ts";
import { Downloader } from "./downloads.ts";
import { Net } from "./net.ts";
import { fetchServer } from "./server.ts";

const log = (event: string, fields: Record<string, string | number | boolean | null> = {}) =>
  process.stdout.write(JSON.stringify({ time: new Date().toISOString(), event, ...fields }) + "\n");

const net = new Net();
const downloader = new Downloader({
  models: process.env.MODELS_DIR || "/models",
  data: process.env.DATA_DIR || "/data",
  net,
  hubs: { huggingface: huggingFace(net), modelscope: modelScope(net) },
  log,
});

// Only host-api may call: compare with its address on our shared network.
const callerName = process.env.CALLER || "host-api";
const isCaller = async (address: string) => (await lookup(callerName, { all: true }).catch(() => [])).some((a) => a.address === address);

fetchServer(downloader, isCaller).listen(Number(process.env.PORT || 7300), "0.0.0.0", () => log("listening", {}));
downloader.start();
process.on("SIGTERM", () => process.exit(0));
