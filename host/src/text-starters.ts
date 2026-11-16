// The text, embedding, voice and dictation models worth starting with, each
// downloaded at a pinned revision into the models folder. The dashboard and
// Lyrica's Download text model page both read this list (host/API.md,
// "Text starters"); image starters are recipes (recipes.ts).
import { HostError } from "./http.ts";

type StarterServer = "llamacpp" | "vllm" | "speech" | "whispercpp";

export interface TextStarter {
  /** A short, stable id for the API. */
  id: string;
  /** The model id the file or folder gets once downloaded. */
  model: string;
  name: string;
  /** A model's sizes share `variantOf`, each with its own `variant` label. */
  variantOf?: string;
  variant?: string;
  kind: "chat" | "embedding" | "speak" | "transcribe";
  server: StarterServer;
  repo: string;
  revision: string;
  files: string[];
  /** Matches the rest of a folder's files. */
  also?: RegExp;
  /** Bytes to download. */
  size: number;
  /** GPU memory it wants loaded, in bytes. */
  needs: number;
}

const GiB = 2 ** 30;

export const TEXT_STARTERS: TextStarter[] = [
  { id: "qwen3.8-27b", model: "lyrica/huggingface/unsloth/Qwen3.8-27B-GGUF/Qwen3.8-27B-UD-Q4_K_M.gguf", name: "Qwen3.8 27B", kind: "chat", server: "llamacpp",
    repo: "unsloth/Qwen3.8-27B-GGUF", revision: "4ca720788d1e01f1bff70c033e0d0028fd02e502", files: ["Qwen3.8-27B-UD-Q4_K_M.gguf", "mmproj-F16.gguf"],
    size: 16_464_440_224 + 927_607_488, needs: 22 * GiB },
  { id: "glm-5.3-flash-q3", model: "lyrica/huggingface/unsloth/GLM-5.3-Flash-GGUF/UD-Q3_K_XL/GLM-5.3-Flash-UD-Q3_K_XL-00001-of-00004.gguf", name: "GLM 5.3 Flash Q3",
    variantOf: "GLM 5.3 Flash", variant: "Q3", kind: "chat", server: "llamacpp",
    repo: "unsloth/GLM-5.3-Flash-GGUF", revision: "a38483c8cd5df544f53d70fb281afe97369d5ab6",
    files: [1, 2, 3, 4].map((n) => `UD-Q3_K_XL/GLM-5.3-Flash-UD-Q3_K_XL-0000${n}-of-00004.gguf`).concat("mmproj-F16.gguf"),
    size: 147_535_922_080 + 1_128_047_296, needs: 160 * GiB },
  { id: "glm-5.3-flash-q4", model: "lyrica/huggingface/unsloth/GLM-5.3-Flash-GGUF/UD-Q4_K_XL/GLM-5.3-Flash-UD-Q4_K_XL-00001-of-00006.gguf", name: "GLM 5.3 Flash Q4",
    variantOf: "GLM 5.3 Flash", variant: "Q4", kind: "chat", server: "llamacpp",
    repo: "unsloth/GLM-5.3-Flash-GGUF", revision: "a38483c8cd5df544f53d70fb281afe97369d5ab6",
    files: [1, 2, 3, 4, 5, 6].map((n) => `UD-Q4_K_XL/GLM-5.3-Flash-UD-Q4_K_XL-0000${n}-of-00006.gguf`).concat("mmproj-F16.gguf"),
    size: 199_707_321_472 + 1_128_047_296, needs: 208 * GiB },
  { id: "deepseek-v4-flash", model: "lyrica/huggingface/unsloth/DeepSeek-V4-Flash-GGUF/UD-Q4_K_XL/DeepSeek-V4-Flash-UD-Q4_K_XL-00001-of-00005.gguf", name: "DeepSeek V4 Flash", kind: "chat", server: "llamacpp",
    repo: "unsloth/DeepSeek-V4-Flash-GGUF", revision: "e3aa0d6a5fa4f820d9e132ac1fd1d01e1b2b49e0",
    files: [1, 2, 3, 4, 5].map((n) => `UD-Q4_K_XL/DeepSeek-V4-Flash-UD-Q4_K_XL-0000${n}-of-00005.gguf`),
    size: 155_095_840_320, needs: 168 * GiB },
  { id: "qwen3.5-9b", model: "lyrica/huggingface/unsloth/Qwen3.5-9B-GGUF/Qwen3.5-9B-Q4_K_M.gguf", name: "Qwen3.5 9B", variantOf: "Qwen3.5", variant: "9B", kind: "chat", server: "llamacpp",
    repo: "unsloth/Qwen3.5-9B-GGUF", revision: "3885219b6810b007914f3a7950a8d1b469d598a5", files: ["Qwen3.5-9B-Q4_K_M.gguf", "mmproj-F16.gguf"],
    size: 5_680_522_464 + 918_166_080, needs: 8 * GiB },
  // Eyes for a chat model without vision (Look at images): the 4B names files and copies text best, the 2B for small cards.
  { id: "qwen3.5-4b", model: "lyrica/huggingface/unsloth/Qwen3.5-4B-GGUF/Qwen3.5-4B-Q4_K_M.gguf", name: "Qwen3.5 4B", variantOf: "Qwen3.5", variant: "4B", kind: "chat", server: "llamacpp",
    repo: "unsloth/Qwen3.5-4B-GGUF", revision: "e87f176479d0855a907a41277aca2f8ee7a09523", files: ["Qwen3.5-4B-Q4_K_M.gguf", "mmproj-F16.gguf"],
    size: 2_740_937_888 + 672_423_616, needs: 6.5 * GiB },
  { id: "qwen3.5-2b", model: "lyrica/huggingface/unsloth/Qwen3.5-2B-GGUF/Qwen3.5-2B-Q4_K_M.gguf", name: "Qwen3.5 2B", variantOf: "Qwen3.5", variant: "2B", kind: "chat", server: "llamacpp",
    repo: "unsloth/Qwen3.5-2B-GGUF", revision: "f6d5376be1edb4d416d56da11e5397a961aca8ae", files: ["Qwen3.5-2B-Q4_K_M.gguf", "mmproj-F16.gguf"],
    size: 1_280_835_840 + 668_227_264, needs: 4 * GiB },
  { id: "qwen3-embedding-0.6b", model: "lyrica/huggingface/Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf", name: "Qwen3 Embedding 0.6B", kind: "embedding", server: "llamacpp",
    repo: "Qwen/Qwen3-Embedding-0.6B-GGUF", revision: "370f27d7550e0def9b39c1f16d3fbaa13aa67728", files: ["Qwen3-Embedding-0.6B-Q8_0.gguf"],
    size: 639_150_592, needs: 1 * GiB },
  { id: "kokoro-82m", model: "lyrica/huggingface/onnx-community/Kokoro-82M-v1.1-zh-ONNX", name: "Kokoro 82M", kind: "speak", server: "speech",
    repo: "onnx-community/Kokoro-82M-v1.1-zh-ONNX", revision: "6cc0f0d2ebe369a68b0df87c2b65c1af8c0ac3e3",
    files: ["onnx/model.onnx", "config.json", "tokenizer.json", "tokenizer_config.json", "voices/zm_010.bin", "voices/zf_001.bin", "voices/af_maple.bin"],
    size: Math.round(0.33 * GiB), needs: 1 * GiB },
  { id: "whisper-large-v3-turbo-cpp", model: "lyrica/huggingface/ggerganov/whisper.cpp/ggml-large-v3-turbo-q8_0.bin", name: "Whisper large-v3 turbo", kind: "transcribe", server: "whispercpp",
    repo: "ggerganov/whisper.cpp", revision: "5359861c739e955e79d9a303bcbc70fb988958b1", files: ["ggml-large-v3-turbo-q8_0.bin"], size: 874_188_075, needs: 1.5 * GiB },
  { id: "whisper-large-v3-turbo", model: "lyrica/huggingface/openai/whisper-large-v3-turbo", name: "Whisper large-v3 turbo", kind: "transcribe", server: "vllm",
    repo: "openai/whisper-large-v3-turbo", revision: "41f01f3fe87f28c78e2fbf8b568835947dd65ed9",
    files: ["model.safetensors"], also: /^[^/]+\.(json|txt)$/, size: Math.round(1.6 * GiB), needs: Math.round(2.4 * GiB) },
  // Mistral's own format (consolidated.safetensors, params.json, tekken.json), which vLLM picks for it; the repository's
  // model.safetensors is the same weights again for Transformers. config.json is how the host knows it. Needs: its
  // weights and the cache for the default 32k context.
  { id: "voxtral-mini-4b-realtime", model: "lyrica/huggingface/mistralai/Voxtral-Mini-4B-Realtime-2602", name: "Voxtral Mini 4B Realtime", kind: "transcribe", server: "vllm",
    repo: "mistralai/Voxtral-Mini-4B-Realtime-2602", revision: "2769294da9567371363522aac9bbcfdd19447add",
    files: ["consolidated.safetensors", "params.json", "tekken.json", "config.json", "generation_config.json", "processor_config.json"],
    size: 8_874_376_582, needs: 14 * GiB },
];

/** What the host's status says that decides which starters it lists and whether each fits. */
export interface StarterHost {
  servers: string[];
  cpuServers: string[];
  dictation: "vllm" | "whispercpp";
  gpus: { vram: { total: number }; settings: { servers: string[]; keepFree: number; excluded: boolean } }[];
  systemRam?: { allowance: number } | null;
}

/** A starter as the API lists it. */
export interface ListedStarter {
  id: string;
  model: string;
  name: string;
  variantOf?: string;
  variant?: string;
  kind: TextStarter["kind"];
  server: StarterServer;
  vision: boolean;
  repo: string;
  size: number;
  needs: number;
  /** `here` once its model is in the folder, `downloading` while any of its files is on the way. */
  state: "here" | "downloading" | "available";
  /** Where it would run: GPUs, GPUs and the System RAM allowance (llama.cpp only), the CPU, or nowhere here. */
  fits: "gpu" | "ram" | "cpu" | "too_big";
}

/**
 * The starters this host can serve (its servers run them, on a GPU or the CPU), each with its state here.
 * llama.cpp splits a model over every GPU that allows it and can keep the rest in the System RAM allowance;
 * the other servers use one GPU.
 */
export function listStarters(host: StarterHost, models: Set<string>, inFlight: Set<string>): ListedStarter[] {
  const rooms = (server: StarterServer) => host.gpus
    .filter((g) => !g.settings.excluded && g.settings.servers.includes(server === "whispercpp" ? "speech" : server))
    .map((g) => g.vram.total - g.settings.keepFree);
  const room = (server: StarterServer) => server === "llamacpp" ? rooms(server).reduce((a, b) => a + b, 0) : Math.max(0, ...rooms(server));
  const ram = host.systemRam?.allowance ?? 0;
  const serves = (s: TextStarter) => (s.kind !== "transcribe" || s.server === host.dictation)
    && (s.server === "whispercpp" || host.servers.includes(s.server) || host.cpuServers.includes(s.server));
  return TEXT_STARTERS.filter(serves).map((s) => {
    const prefix = `lyrica/huggingface/${s.repo}/`;
    const state = models.has(s.model) ? "here" : [...inFlight].some((p) => p.startsWith(prefix)) ? "downloading" : "available";
    const fits = host.cpuServers.includes(s.server) ? "cpu" : s.needs <= room(s.server) ? "gpu"
      : s.server === "llamacpp" && s.needs <= room(s.server) + ram ? "ram" : "too_big";
    return {
      id: s.id, model: s.model, name: s.name, ...(s.variantOf ? { variantOf: s.variantOf, variant: s.variant } : {}),
      kind: s.kind, server: s.server, vision: s.files.some((f) => f.includes("mmproj")), repo: s.repo, size: s.size, needs: s.needs, state, fits,
    };
  });
}

/** The files to download for a starter, from the repository's listing at its revision; refuses one the repository no longer has. */
export function starterFiles(s: TextStarter, listing: { files: { path: string; allowed?: boolean; present?: boolean }[] }): string[] {
  const missing = s.files.filter((f) => !listing.files.some((x) => x.path === f));
  if (missing.length) throw new HostError(409, "starter_gone", `${s.repo} no longer has ${missing.join(", ")}.`);
  return listing.files.filter((f) => f.allowed !== false && !f.present && (s.files.includes(f.path) || s.also?.test(f.path))).map((f) => f.path);
}
