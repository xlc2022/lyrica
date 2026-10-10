// The text models in the models folder: GGUF files for llama.cpp, and
// safetensors folders for vLLM. Reads headers only.
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { readGguf, type GgufValue } from "./gguf.ts";

export interface Identity {
  basename: string | null;
  sizeLabel: string | null;
  finetune: string | null;
  baseModels: { name: string | null; organization: string | null; repoUrl: string | null }[];
}

export interface Capabilities {
  tools: boolean;
  vision: boolean;
  embedding: boolean;
  reasoning: string[] | null;
}

export interface TextModel {
  /** Path relative to the models folder, with `/`. */
  id: string;
  kind: "chat" | "embedding";
  server: "llamacpp" | "vllm";
  format: "gguf" | "safetensors";
  size: number;
  identity: Identity;
  capabilities: Capabilities;
  contextLength: number | null;
  /** A vision projector next to a GGUF model, relative like `id`. */
  mmproj: string | null;
  /** A vLLM model whose config asks for remote code: never loaded. */
  remoteCode: boolean;
}

const SHARD = /-(\d{5})-of-(\d{5})\.gguf$/;

function str(v: GgufValue | undefined): string | null {
  return typeof v === "string" && v ? v : null;
}

function templateCapabilities(template: string | null): Pick<Capabilities, "tools" | "reasoning"> {
  return {
    tools: !!template && /\btools\b/.test(template),
    reasoning: template && /enable_thinking|<think>/.test(template) ? ["off", "on"] : null,
  };
}

function ggufModel(root: string, path: string, siblings: string[]): TextModel | null {
  const meta = readGguf(path);
  if (meta["tokenizer.ggml.model"] === undefined) return null; // an image model's GGUF
  const arch = str(meta["general.architecture"]) ?? "";
  const count = Number(meta["general.base_model.count"] ?? 0);
  const baseModels = Array.from({ length: count }, (_, i) => ({
    name: str(meta[`general.base_model.${i}.name`]),
    organization: str(meta[`general.base_model.${i}.organization`]),
    repoUrl: str(meta[`general.base_model.${i}.repo_url`]),
  }));
  const pooling = meta[`${arch}.pooling_type`];
  const embedding = pooling !== undefined && Number(pooling) !== 0;
  let size = statSync(path).size;
  const shard = basename(path).match(SHARD);
  if (shard) {
    const prefix = basename(path).slice(0, -shard[0].length);
    for (const s of siblings) if (s !== basename(path) && s.startsWith(prefix) && SHARD.test(s)) size += statSync(join(dirname(path), s)).size;
  }
  const mmproj = siblings.find((s) => s.toLowerCase().startsWith("mmproj") && s.endsWith(".gguf"));
  const context = meta[`${arch}.context_length`];
  return {
    id: relative(root, path).split("\\").join("/"),
    kind: embedding ? "embedding" : "chat",
    server: "llamacpp",
    format: "gguf",
    size,
    identity: {
      basename: str(meta["general.basename"]),
      sizeLabel: str(meta["general.size_label"]),
      finetune: str(meta["general.finetune"]),
      baseModels,
    },
    capabilities: { ...templateCapabilities(embedding ? null : str(meta["tokenizer.chat_template"])), vision: !!mmproj && !embedding, embedding },
    contextLength: context === undefined || context === null ? null : Number(context),
    mmproj: mmproj ? relative(root, join(dirname(path), mmproj)).split("\\").join("/") : null,
    remoteCode: false,
  };
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function vllmModel(root: string, dir: string, files: string[]): TextModel | null {
  const config = readJson(join(dir, "config.json"));
  if (!config || !Array.isArray(config.architectures)) return null;
  const size = files.filter((f) => f.endsWith(".safetensors")).reduce((n, f) => n + statSync(join(dir, f)).size, 0);
  const tokenizer = readJson(join(dir, "tokenizer_config.json"));
  const template = files.includes("chat_template.jinja") ? readFileSync(join(dir, "chat_template.jinja"), "utf8") : typeof tokenizer?.chat_template === "string" ? tokenizer.chat_template : null;
  const embedding = files.includes("modules.json");
  const text = config.text_config ?? config;
  return {
    id: relative(root, dir).split("\\").join("/"),
    kind: embedding ? "embedding" : "chat",
    server: "vllm",
    format: "safetensors",
    size,
    identity: { basename: basename(dir), sizeLabel: null, finetune: null, baseModels: [] },
    capabilities: { ...templateCapabilities(embedding ? null : template), vision: !!config.vision_config && !embedding, embedding },
    contextLength: typeof text.max_position_embeddings === "number" ? text.max_position_embeddings : null,
    mmproj: null,
    remoteCode: !!config.auto_map,
  };
}

/** Every text model under `root`. Unreadable files are skipped. */
export function scanTextModels(root: string): TextModel[] {
  const found: TextModel[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 12) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).filter((e) => !e.startsWith("."));
    } catch {
      return;
    }
    if (entries.includes("config.json") && !entries.includes("model_index.json") && entries.some((e) => e.endsWith(".safetensors"))) {
      const model = vllmModel(root, dir, entries);
      if (model) found.push(model);
      return;
    }
    for (const e of entries.sort()) {
      const path = join(dir, e);
      let st;
      try {
        st = lstatSync(path);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(path, depth + 1);
      else if ((st.isFile() || (st.isSymbolicLink() && existsSync(path) && statSync(path).isFile())) && e.endsWith(".gguf") && !e.toLowerCase().startsWith("mmproj")) {
        const shard = e.match(SHARD);
        if (shard && shard[1] !== "00001") continue;
        try {
          const model = ggufModel(root, path, entries);
          if (model) found.push(model);
        } catch {}
      }
    }
  };
  walk(root, 0);
  return found;
}
