// host-api's entry point, run in its container.
import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { LlamaCpp, Vllm } from "./backends.ts";
import { Comfy } from "./comfy.ts";
import { Downloads } from "./downloads.ts";
import { Images } from "./images.ts";
import { RecipeBook, loadStarters } from "./recipes.ts";
import { loadTemplates } from "./templates.ts";
import { amdMonitor, noGpus, nvidiaMonitor } from "./gpus.ts";
import { stdoutLog } from "./log.ts";
import { Runtime } from "./runtime.ts";
import { Scheduler } from "./scheduler.ts";
import { Speech } from "./speech.ts";
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
const modelsDir = env.MODELS_DIR || "/models";
const serving = env.SERVING_DIR || "/serving";
const vendor = env.GPU_VENDOR || "none";
// How the model servers reach the GPUs: CUDA, ROCm, or Vulkan (llama.cpp only,
// for AMD GPUs that ROCm doesn't support).
const backend = vendor === "nvidia" ? "cuda" : vendor === "amd" ? (env.GPU_BACKEND === "vulkan" ? "vulkan" : "rocm") : null;

const host = new Host({
  dataDir: env.DATA_DIR || "/data",
  name,
  version: env.HOST_VERSION || "dev",
  names: [name, ...(env.HOST_NAMES ?? "").split(",")].map((n) => n.trim()).filter(Boolean),
  tailnetName: env.TAILNET_NAME || undefined,
  localPeers: env.LOCAL_PEERS ? env.LOCAL_PEERS.split(",") : defaultGateway(),
  modelsDir,
  modelsHostPath: env.MODELS_HOST_PATH || modelsDir,
  log: stdoutLog,
});

const comfy = new Comfy(env.COMFYUI_URL || "http://comfyui:8188");
const scheduler = new Scheduler({
  monitor: vendor === "nvidia" ? nvidiaMonitor : vendor === "amd" ? amdMonitor("/sys", { order: backend === "vulkan" ? "pci" : "kfd" }) : noGpus,
  gpuBackend: backend,
  servers: backend === "vulkan" ? ["llamacpp"] : undefined,
  // The speech server runs on an NVIDIA GPU, and on the CPU anywhere else
  // (its ONNX runtime has no ROCm or Vulkan build).
  cpuServers: backend === "cuda" ? [] : ["speech"],
  // llama.cpp can use an integrated GPU's shared memory on Vulkan, or on ROCm
  // when install.sh turned on unified memory (an APU without a discrete GPU).
  sharedMemory: backend === "vulkan" || (backend === "rocm" && env.LLAMA_UNIFIED_MEMORY === "1") ? ["llamacpp"] : [],
  backends: {
    llamacpp: new LlamaCpp({ url: env.LLAMACPP_URL || "http://llamacpp:8080", serving, models: modelsDir, device: (i) => `${backend === "vulkan" ? "Vulkan" : backend === "rocm" ? "ROCm" : "CUDA"}${i}` }),
    vllm: new Vllm({ url: env.VLLM_URL || "http://vllm:{port}", serving, models: modelsDir }),
    comfyui: comfy,
    speech: new Speech({ url: env.SPEECH_URL || "http://speech:8000", models: modelsDir }),
  },
  state: host.state,
  log: stdoutLog,
});
host.runtime = new Runtime({ scheduler, modelsDir, state: host.state, log: stdoutLog });

await host.listen(Number(env.TLS_PORT || 7443), Number(env.LOCAL_PORT || 7080));
host.downloads = new Downloads({ url: env.FETCH_URL || "http://fetch:7300", runtime: host.runtime, log: stdoutLog });
await host.downloads.start();
const dataDir = env.DATA_DIR || "/data";
const book = new RecipeBook(dataDir, loadTemplates(new URL("../workflows/", import.meta.url).pathname), loadStarters(new URL("../recipes/", import.meta.url).pathname));
host.images = new Images({ book, runtime: host.runtime, comfy, downloads: host.downloads, modelsDir, serving, comfyGpu: Number(env.COMFY_GPU || 0), log: stdoutLog });
host.runtime.afterScan = () => host.images!.scan();
await host.runtime.start();
// fetch shares a network with host-api (for host-api's calls to it) and may not
// call back. Its address is looked up on every request, so a restart that moves
// it leaves no window.
host.refusePeer = async (address) => {
  const found = await lookup(env.FETCH_HOST || "fetch", { all: true }).catch(() => []);
  return found.some((a) => a.address === address);
};
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => void host.close().then(() => process.exit(0)));
