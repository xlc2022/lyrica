// host-api's entry point, run in its container.
import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { diskReads } from "./disk.ts";
import { LlamaCpp, Vllm } from "./backends.ts";
import { Comfy, ComfyGpus } from "./comfy.ts";
import { Downloads } from "./downloads.ts";
import { Images } from "./images.ts";
import { RecipeBook, loadStarters } from "./recipes.ts";
import { loadTemplates } from "./templates.ts";
import { Workflows } from "./workflows.ts";
import { amdMonitor, isCmp, noGpus, nvidiaComputeCaps, nvidiaMonitor } from "./gpus.ts";
import { stdoutLog } from "./log.ts";
import { Runtime } from "./runtime.ts";
import { SERVERS } from "./placement.ts";
import { Scheduler } from "./scheduler.ts";
import { SdCpp } from "./sdcpp.ts";
import { WhisperCpp } from "./whispercpp.ts";
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
  commit: env.HOST_COMMIT || undefined,
  updateDir: env.UPDATE_DIR || "/update",
  names: [name, ...(env.HOST_NAMES ?? "").split(",")].map((n) => n.trim()).filter(Boolean),
  tailnetName: env.TAILNET_NAME || undefined,
  localPeers: env.LOCAL_PEERS ? env.LOCAL_PEERS.split(",") : defaultGateway(),
  modelsDir,
  modelsHostPath: env.MODELS_HOST_PATH || modelsDir,
  log: stdoutLog,
});

// A ComfyUI per image GPU (COMFY_GPU, one or a list such as 0,1), each on the next port up (host/comfyui/gate.py).
const comfyGpus = [...new Set((env.COMFY_GPU || "0").split(",").map((g) => Number(g.trim())).filter((g) => Number.isInteger(g) && g >= 0))];
const comfyUrl = new URL(env.COMFYUI_URL || "http://comfyui:8188");
const comfyStatus = env.COMFYUI_STATUS || "/comfyui-status";
const comfy = new ComfyGpus(new Map((comfyGpus.length ? comfyGpus : [0]).map((gpu, place) => {
  const url = new URL(comfyUrl);
  url.port = String(Number(comfyUrl.port || 80) + place);
  const base = url.toString().replace(/\/$/, "");
  return [gpu, new Comfy(base, undefined, undefined, { state: join(serving, `comfyui-${gpu}.json`), status: join(comfyStatus, `comfyui-${gpu}.json`) })];
})));
const nvidiaGpus = vendor === "nvidia" ? await nvidiaMonitor.read().catch(() => []) : [];
// On a CMP 100-210, install.sh adds stable-diffusion.cpp, which makes the images in ComfyUI's place.
const sdcpp = env.SDCPP_URL
  ? new SdCpp(env.SDCPP_URL, { serving, status: env.SDCPP_STATUS || "/sdcpp-status/sdcpp.json" }, nvidiaGpus.find((g) => g.index === (comfyGpus[0] ?? 0))?.total ?? 0)
  : null;
// Beside a CMP 100-210, install.sh adds whisper.cpp for dictation, which vLLM can't do there.
const whispercpp = env.WHISPER_URL ? new WhisperCpp(env.WHISPER_URL, { serving, status: env.WHISPER_STATUS || "/whisper-status/whisper.json", models: modelsDir }) : null;
const cmpGpus = new Set(nvidiaGpus.filter((g) => isCmp(g.pciId)).map((g) => g.index));
const computeCaps = vendor === "nvidia" ? await nvidiaComputeCaps() : new Map<number, number>();
// The oldest compute capability each server's image has kernels for. llama.cpp's CUDA 12.8 image builds
// 5.0 and up (its ggml-cuda CMakeLists; on a CMP, install.sh builds it for this host's cards). vLLM v0.32.0
// builds 7.5 and up (torch_cuda_arch_list), as does ComfyUI's CUDA 13.0 PyTorch, CUDA 13 having dropped
// older cards; stable-diffusion.cpp in its place is built for the CMP (70-real). The speech server's cuDNN 9.27
// supports 7.5 and up (cuDNN's support matrix); beside a CMP, install.sh builds it with one that has Volta's.
const minCompute = { llamacpp: 5.0, vllm: 7.5, images: sdcpp ? 7.0 : 7.5, speech: cmpGpus.size ? 7.0 : 7.5 };
const scheduler = new Scheduler({
  disk: diskReads(modelsDir) ?? undefined,
  monitor: vendor === "nvidia" ? nvidiaMonitor : vendor === "amd" ? amdMonitor("/sys", { order: backend === "vulkan" ? "pci" : "kfd" }) : noGpus,
  gpuBackend: backend,
  ...(vendor === "nvidia" ? { computeCap: (i: number) => computeCaps.get(i), minCompute } : {}),
  // Only CMP 100-210s here: install.sh leaves vLLM's service out (compose.novllm.yaml).
  servers: backend === "vulkan" ? ["llamacpp"] : env.VLLM === "off" ? SERVERS.filter((s) => s !== "vllm") : undefined,
  // The speech server runs on an NVIDIA GPU, and on the CPU anywhere else
  // (its ONNX runtime has no ROCm or Vulkan build).
  cpuServers: backend === "cuda" ? [] : ["speech"],
  // llama.cpp can use an integrated GPU's shared memory on Vulkan, or on ROCm
  // when install.sh turned on unified memory (an APU without a discrete GPU).
  sharedMemory: backend === "vulkan" || (backend === "rocm" && env.LLAMA_UNIFIED_MEMORY === "1") ? ["llamacpp"] : [],
  backends: {
    llamacpp: new LlamaCpp({ url: env.LLAMACPP_URL || "http://llamacpp:8080", serving, models: modelsDir, device: (i) => `${backend === "vulkan" ? "Vulkan" : backend === "rocm" ? "ROCm" : "CUDA"}${i}`, cmp: (i) => cmpGpus.has(i), log: stdoutLog }),
    vllm: new Vllm({ url: env.VLLM_URL || "http://vllm:{port}", serving, models: modelsDir }),
    comfyui: sdcpp ?? comfy,
    speech: new Speech({ url: env.SPEECH_URL || "http://speech:8000", models: modelsDir }),
    ...(whispercpp ? { whispercpp } : {}),
  },
  state: host.state,
  log: stdoutLog,
});
host.runtime = new Runtime({ scheduler, modelsDir, state: host.state, log: stdoutLog });

await host.listen(Number(env.TLS_PORT || 7443), Number(env.LOCAL_PORT || 7080));
host.downloads = new Downloads({ url: env.FETCH_URL || "http://fetch:7300", runtime: host.runtime, log: stdoutLog });
await host.downloads.start();
const dataDir = env.DATA_DIR || "/data";
const templates = loadTemplates(new URL("../workflows/", import.meta.url).pathname);
// Custom workflows join the built-in templates (host/src/workflows.ts); each ComfyUI start refreshes the node list they're checked against.
const workflows = new Workflows(dataDir, templates);
for (const c of comfy.byGpu.values()) c.onNodes = (info) => workflows.saveNodes(info);
const book = new RecipeBook(dataDir, templates, loadStarters(new URL("../recipes/", import.meta.url).pathname));
host.images = new Images({ book, workflows, runtime: host.runtime, comfy, sdcpp, downloads: host.downloads, modelsDir, serving, log: stdoutLog });
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
