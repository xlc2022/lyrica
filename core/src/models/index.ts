import { CLOUD_IMAGE_PROVIDERS, imageAt, PLAN_IMAGE, PLAN_IMAGE_MODEL, validateImageRequest, type ImageRequest, type GeneratedImage } from "./images.ts";
export { CLOUD_IMAGE_PROVIDERS, PLAN_IMAGE_MODEL, type ImageRequest, type GeneratedImage, type ImageInput } from "./images.ts";
import { validateVideoRequest, videoAt, type GeneratedVideo, type VideoRequest } from "./videos.ts";
export { isMp4, type GeneratedVideo, type VideoRequest } from "./videos.ts";
export { type JobProgress } from "./progress.ts";
import type { JobProgress } from "./progress.ts";
export { CODEX_DISABLED, codexImage, codexSignedIn, codexSignIn, codexSignOut, type CodexBox, type CodexSignIn } from "./codex.ts";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { Db } from "../db.ts";
import type { Keyring } from "../keyring.ts";
import { DEFAULT_THINKING, TASK_NAMES, TASKS, THINKING_LEVELS, type CallContext, type Column, type ModelRef, type Pool, type PresetScope, type Task, type ThinkingLevel } from "../types.ts";
import { selfName } from "../persona.ts";
import { Forbidden, type User, type Users } from "../users.ts";
import { addressesOutside, discoverModels, llamaServerModel, type LlamaServerModel, modelDefaults, lmStudioLoad, lmStudioModel, lmStudioModels, probeUrl, type DiscoveredModel, type ModelDefaults, type ModelIdentity, type ModelPrice } from "./http.ts";
import { hostError, hostFetch, HostRefused, hostOrigin, listIn, lyricaIdentity, pair } from "./host.ts";
import { baseName } from "./identity.ts";
import { copyIdentity } from "./library.ts";
import { acceptedSettings, ANSWER_SETTINGS, checkSettings, DEFAULT_CONTEXT, type AnswerSettings, type SettingSource } from "./settings.ts";
import { collectRefs, isList, mapMembers, moveSettings, refId, rewrite, type Entry, type Use } from "./refs.ts";
import type { Named } from "./match.ts";
import { addNotice, MIXED_PRESET, NOTICE, syncLegacy } from "./schema.ts";
import { MAX_CLIP_BYTES, MAX_CLIP_SECONDS, MAX_SPEAK_CHARS, speakAt, transcribeAt, wavSeconds, type SpeechTarget } from "./speech.ts";

export type SpeechTask = "speech.transcribe" | "speech.speak";

export { addressesOutside, discoverModels, inOwnNetwork, openRouterPrice, openRouterReasoning, probeUrl, type DiscoveredModel, type ModelDefaults, type ModelIdentity, type ModelPrice } from "./http.ts";
export { baseName } from "./identity.ts";
export { acceptedSettings, ANSWER_SETTINGS, payloadFields, replyCap, DEFAULT_CONTEXT, type AnswerSettings, type SettingSource } from "./settings.ts";
export { fingerprint, HostIdentityChanged, HostRefused, hostOrigin, normaliseCode, PairingFailed, pairingProofs } from "./host.ts";
export { useTailnetProxy } from "./tailnet.ts";
export { refId, type Entry, type Use } from "./refs.ts";
export { matchModel, sameModelName, singledOut, unmatched, type Match, type Named } from "./match.ts";
export { MAX_CLIP_BYTES, MAX_CLIP_SECONDS, MAX_SPEAK_CHARS, pcmSeconds, SPEECH_CONTENT_TYPE, SPEECH_FORMAT, wavData, wavSeconds } from "./speech.ts";

/** A cloud model was asked for where only local models are allowed. Nothing falls back. */
export class CloudModelForbidden extends Error {}
/** No usable model is set for a task, or the one set no longer exists. */
export class NoModel extends Error {}
/**
 * The model a turn would run on is a plan at its usage limit, and the user
 * didn't choose to fall back: nothing is sent, and the turn waits for the reset (`until`).
 */
export class PlanWaiting extends Error {
  override readonly name = "PlanWaiting";
  constructor(readonly endpointId: string, readonly until: number) {
    super("the plan reached its usage limit; waiting for it to reset");
  }
}
/**
 * Every model that could take a task's call is away (its machine down, paused
 * or stale) or failed to answer: nothing can answer now, though something may
 * once a machine is back. A NoModel, so whatever handles one handles this.
 * `tried` holds labels and reasons, never text.
 */
export class Offline extends NoModel {
  readonly code = "offline";
  override readonly name = "Offline";
  constructor(readonly task: Task, readonly tried: { label: string; reason: string }[]) {
    super(`no model for ${TASK_NAMES[task]} can be reached now${tried.length ? ` (${tried.map((t) => `${t.label}: ${t.reason}`).join("; ")})` : ""}`);
  }
}

// "terminated" is a reply cut off mid-stream when its connection dropped; the timeouts are a machine that stopped answering.
// Anchored: a provider's own error text that merely mentions connecting mustn't mark a healthy endpoint down.
const UNREACHABLE = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|fetch failed|socket hang up|^Connection error\.?$|connect(ion)? (refused|reset|timed out|timeout)|^terminated$|other side closed|timed out|Timeout Error|UND_ERR_(HEADERS|BODY|CONNECT)_TIMEOUT/i;
/** A model host's answers that mean another model should answer for a while. */
const AWAY_CODES = new Set(["unreachable", "paused", "busy", "restarting", "unavailable", "unpaired", "identity_changed", "model_unavailable"]);

/**
 * Whether a failed call (or a reply's error message) means its machine couldn't
 * be reached or is away, so the next model should try, rather than that the
 * model refused this request.
 */
/**
 * The context Dictation runs in: a thread's own Dictation choice may be a
 * cloud model, since picking it there is the user's consent; without one,
 * the Private column's list, so a user's voice never reaches a cloud model
 * they didn't pick in that thread.
 */
export const voiceContext = (ctx: CallContext): CallContext => (ctx.overrides?.["speech.transcribe"]?.length ? ctx : { ...ctx, localOnly: true });

export function isUnreachable(err: unknown): boolean {
  if (err instanceof HostRefused) return AWAY_CODES.has(err.code);
  if (typeof err === "string") return UNREACHABLE.test(err);
  const e = err as { name?: string; message?: string; code?: string; cause?: unknown } | undefined;
  if (!e) return false;
  if (e.name === "TimeoutError" || UNREACHABLE.test(e.message ?? "") || UNREACHABLE.test(e.code ?? "")) return true;
  return e.cause !== undefined && e.cause !== err && isUnreachable(e.cause);
}

/** A plan's usage limit, as OpenAI reports it: it resets after hours, not seconds. */
export const isPlanLimit = (message: string | undefined): boolean => /subscription_sharing_usage_limit_exceeded|usage.?limit/i.test(message ?? "");
/** How long a plan that reached its limit is skipped when it doesn't say when it resets: an hour, doubled each time it's still limited at the guess, up to six. */
const PLAN_LIMIT_MS = 60 * 60_000;
const PLAN_LIMIT_MAX_MS = 6 * PLAN_LIMIT_MS;
/** A refusal this soon after a guessed reset means the guess was early. */
const PLAN_LIMIT_AGAIN_MS = 15 * 60_000;
/** When a plan's limit resets, from its error (OpenAI's `resets_at` or `resets_in_seconds`, or Pi's "Try again in ~N min."); undefined when it doesn't say. */
export function planLimitReset(message: string | undefined, now = Date.now()): number | undefined {
  const text = message ?? "";
  const at = /"?resets_at"?\s*[:=]\s*(\d{9,})/.exec(text);
  if (at) return Number(at[1]) * 1000;
  const after = /"?resets_in_seconds"?\s*[:=]\s*(\d+)/.exec(text);
  if (after) return now + Number(after[1]) * 1000;
  const minutes = /try again in ~?(\d+)\s*min/i.exec(text);
  return minutes ? now + Number(minutes[1]) * 60_000 : undefined;
}

/** An endpoint unreachable this long is stale; a model missing this long is gone. */
export const STALE_DAYS = 14;
export const GONE_DAYS = 30;
/** How long a gone shared model stays before it is removed, even while lists name it. */
export const SHARED_GONE_DAYS = 7;
const DAY = 86_400_000;
/** How long a probe or a failed call counts for in the health cache. */
export const HEALTH_MS = 30_000;
/** How long a cloud endpoint's last answer stands on the Models page, so the shell's 30 s poll probes its provider at most every 90 s. Local endpoints keep `HEALTH_MS`. */
const CLOUD_PAGE_PROBE_MS = 90_000;
/** How long the router waits for a probe before trying the next model. */
const PROBE_MS = 2_000;
/** Recent calls kept per user. */
const CALLS_KEPT = 500;

export interface Endpoint {
  /** Permanent. */
  id: string;
  /** A label that can change. */
  name: string;
  kind: "cloud" | "local";
  /** A plain OpenAI-compatible server, a paired model host, or a subscription plan (ChatGPT or Grok) signed in with its provider. */
  api: "openai-compatible" | "host" | PlanKind;
  /** For a host, its first address's `/v1`. */
  baseUrl: string;
  apiKey?: string;
  shared: boolean;
  /** A host's addresses, tried in order. */
  addresses?: string[];
  /** A host's pinned key fingerprint. */
  fingerprint?: string;
  /** A local endpoint served over plain HTTP outside this machine and the tailnet. */
  unencrypted: boolean;
  /** When it stopped answering, while it doesn't. */
  downSince?: string;
  /** Unreachable for STALE_DAYS. Fallbacks skip it. */
  stale: boolean;
  /** A plan whose sign-in lapsed (its refresh was refused). Fallbacks skip it until it signs in again. */
  signedOut?: boolean;
  /** When a plain endpoint or plan was paused by hand. Fallbacks skip it until it is resumed; a host pauses itself instead. */
  pausedAt?: string;
}

/** The subscription plans a user can sign in with (docs/models.md, "Subscription plans"). */
export const PLAN_KINDS = ["chatgpt", "grok"] as const;
export type PlanKind = (typeof PLAN_KINDS)[number];
export const isPlan = (api: string | undefined): api is PlanKind => (PLAN_KINDS as readonly string[]).includes(api ?? "");
/** Where each plan's calls go: its provider's Responses API, with the plan's own token. */
export const PLAN_URLS: Record<PlanKind, string> = { chatgpt: "https://api.openai.com/v1", grok: "https://api.x.ai/v1" };
const PLAN_NAMES: Record<PlanKind, string> = { chatgpt: "ChatGPT", grok: "Grok" };

/** A plan's sign-in, as Pi's sign-in returns it (access, refresh, expires, and for ChatGPT clientId and scopes). */
export type PlanCredential = { access: string; refresh: string; expires: number } & Record<string, unknown>;

/** What a model can do. Discovered where the endpoint says, else set by hand. */
export interface Capabilities {
  contextWindow?: number;
  tools?: boolean;
  vision?: boolean;
  embedding?: boolean;
  image?: boolean;
  edit?: boolean;
  upscale?: boolean;
  /** Makes a clip from a prompt (a host's video recipe). */
  video?: boolean;
  /** Makes a clip from a first frame. */
  animate?: boolean;
  /** Moves an image's subject as the person in a driving clip moves (SCAIL-2). */
  motion?: boolean;
  /** Image create tiers; absent means both. Stored in hand JSON for cloud models. */
  useFor?: "fast" | "quality" | "both";
  /** The thinking levels it offers, besides off. */
  reasoning?: Exclude<ThinkingLevel, "off">[];
  /** Speech to text (Dictation). */
  transcribe?: boolean;
  /** Text to speech (Read aloud), with its voices and the language each speaks. */
  speak?: { voices: Voice[] };
}
/** One of a speech model's voices. `language` is a primary language tag, such as "en" or "zh". */
export interface Voice { id: string; language: string }
/** What a host recipe can be asked to do (host/API.md "Recipes"). */
const RECIPE_ACTIONS = ["create", "edit", "upscale", "video", "animate", "motion"];

export const CAPABILITIES = ["contextWindow", "tools", "vision", "embedding", "image", "edit", "upscale", "video", "animate", "motion", "reasoning", "transcribe", "speak", "useFor"] as const satisfies readonly (keyof Capabilities)[];

/** One model on one endpoint, with a permanent ID. */
export interface Offering extends Capabilities {
  id: string;
  endpointId: string;
  /** The endpoint's own model ID, sent in requests. */
  modelId: string;
  /** Added by hand rather than discovered. */
  manual: boolean;
  /** listed; missing (the endpoint stopped listing it); gone (missing for GONE_DAYS, so fallbacks skip it). */
  status: "listed" | "missing" | "gone";
  missingSince?: string;
  /** The file's SHA-256, where a host reports it. */
  digest?: string;
  /** What a host read from the file or its model card. */
  identity?: ModelIdentity;
  /** The host downloaded it itself, so it can be deleted. */
  downloaded?: boolean;
  size?: number;
  /** An image model's name: a host's confirmed recipe, or a ChatGPT plan's image tool. */
  recipe?: string;
  /** A host recipe that edits says whether its edits take a mask; false skips it for a masked edit. */
  mask?: boolean;
  /** "Not this model": kept out of the entry its name would put it in. */
  separate?: boolean;
  /** A host's chat template writes `<think>` itself, so a reply can start mid-thought. */
  opensThinking?: boolean;
  /** Its server says it can't turn thinking off (LM Studio, OpenRouter), so it thinks at mandatoryThinking when asked for off. */
  alwaysThinks?: boolean;
  /** An LM Studio model, as last discovered: the `models` tool may load it again with another context. */
  lmStudio?: boolean;
  /** A plain llama-server described it on /props: its one thinking level is the chat template's switch. */
  llamaServer?: boolean;
  /** Requests its server runs at once, sharing one context cache (LM Studio's `parallel`), when the server says. */
  parallel?: number;
  /** What it costs, where its server says (OpenRouter). */
  price?: ModelPrice;
  /** The day its server stops offering it, where the server says (OpenRouter). */
  retiresAt?: string;
  /** The longest reply it gives, in tokens, where the server says (OpenRouter). */
  maxOutput?: number;
}

/** Offerings from different endpoints declared the same model, in preferred order. */
export interface Group {
  id: string;
  name: string;
  shared: boolean;
  /** Offering IDs, in order. */
  members: string[];
}

export type Profiles = Partial<Record<Task, Entry>>;
export type Hub = "huggingface" | "modelscope";

/** A named task-to-model table. The built-ins Local and Cloud have a non-null `builtin`; a user preset's is null. */
export interface Preset {
  id: string;
  name: string;
  scope: PresetScope;
  builtin: "local" | "cloud" | null;
  entries: Profiles;
  updatedAt: string;
}

/** One column's state on the Models page: the preset it follows, or Custom with its own entries and the preset they came from. */
export interface ColumnState {
  column: Column;
  /** The preset this column follows, or null while it is Custom. */
  preset: Preset | null;
  /** The preset a Custom column's entries came from (Save to), or null. */
  fromPreset: Preset | null;
  /** The column's own entries: its table while it is Custom. */
  entries: Profiles;
}

/** One model in the text library, with its copies on every endpoint. */
export interface LibraryEntry {
  key: string;
  name: string;
  /** For a finetune, merge or adapter (or a copy flagged as maybe one): the model it derives from. */
  base?: { key: string; name: string };
  starred: boolean;
  groups: string[];
  copies: {
    offeringId: string; label: string;
    /** The file under the models folder, or the endpoint's model ID. */
    rawName: string;
    endpointId: string; endpointName: string; kind: "cloud" | "local"; shared: boolean;
    status: Offering["status"];
    /** Lyrica downloaded it, so it can be deleted. */
    downloaded: boolean;
    capabilities: Capabilities;
    groups: string[];
    flagged?: string;
    size?: number;
    /** Its median speeds over the user's last twenty measured calls to it. */
    speed?: { tokPerSec?: number; promptTokPerSec?: number };
  }[];
}

/** Host management paths passed through (host/API.md). */
/** A host model's serving settings as the host reports them (host/API.md). */
export interface ServingEntry {
  model: string;
  settings: Record<string, unknown>;
  contextLength: number;
  /** The trained length times the stretch; null when the host couldn't read the trained length. */
  maxContextLength: number | null;
  trainedContextLength: number | null;
  /** The KV cache at the served context, by the host's estimate. */
  kvBytes: number | null;
  /** What it would keep in the host's system RAM, not fitting the GPUs; absent from a host from before the allowance. */
  ramBytes?: number;
  /** A per-layer embedding table over 4 GiB that llama.cpp reads from the file as needed, unless its settings keep it in RAM. */
  layerTableBytes?: number;
  recommended: Recommended | null;
  /** vLLM's stretch is untested (vllm#58870). */
  stretchUntested: boolean;
  /** A vision projector, and an MTP file or the model's own MTP layers, that settings can turn off. */
  extras?: { vision: boolean; mtp: "file" | "built-in" | null };
  /**
   * A GGUF chat model's companions: the projector it loads (picked in its
   * settings' `mmproj`, or matched by name), the one its name matches, every
   * projector on the host to pick from (its own folders first), and the
   * repository it was downloaded from, where a missing projector or MTP file
   * can be found.
   */
  projector?: string | null;
  matchedProjector?: string | null;
  projectors?: { path: string; size: number }[];
  origin?: { source: "huggingface" | "modelscope"; repo: string; revision: string | null } | null;
}

/** What a model's card recommends for its context (DESIGN, "Model settings"). */
export interface Recommended {
  native: number | null;
  stretched?: number;
  factor?: number;
  originalContext?: number;
  source: { hub: "huggingface" | "modelscope"; repo: string; revision: string; at: string };
}

const MANAGE = [/^\/host\/v1\/models\/(load|unload|pin|reload)$/, /^\/host\/v1\/gpus\/\d+$/, /^\/host\/v1\/memory$/, /^\/host\/v1\/scan$/, /^\/host\/v1\/usage$/];

export interface CleanupItem {
  /** For a stale endpoint, its uses are those of all its models. */
  endpoint?: Endpoint;
  offering?: Offering;
  /** A group left with no members. */
  group?: Group;
  label: string;
  /** Where the asking user's own lists (and shared groups) use it. */
  usedIn: Use[];
  /** How many other users' lists name it (shared only). */
  otherUsers: number;
  /** The same model on another endpoint of the same kind, for Replace with… */
  suggestion?: { offeringId: string; label: string };
}

/** What a call needs from a model: tools, room for the conversation, or an image create tier. */
export interface Need { tools?: boolean; tokens?: number; imageTier?: "fast" | "quality"; imageMask?: boolean; animate?: boolean; motion?: boolean }
/** `evenIfDown`: ignore the health cache (stale still counts). `except`: endpoints to treat as down. */
export interface ResolveOptions { evenIfDown?: boolean; except?: ReadonlySet<string> }

/** The model chosen for a call, and why earlier ones in the list were passed over. */
export interface Resolution {
  ref: { offeringId: string };
  endpoint: Endpoint;
  offering: Offering;
  label: string;
  /** The preset this call was chosen from, or "Custom" for a column's own table. */
  profile: string;
  source: "thread" | "preset" | "column";
  /** Earlier models in the list that were skipped, with the reason. */
  skipped: { label: string; reason: string }[];
  /** Models after this one in the list that could still be tried. */
  remaining: number;
  /** A free model earlier in the list (local, or priced free) that was skipped, when this one costs money. */
  paidAfter?: { label: string; reason: string };
}

export interface CallRecord {
  at: string;
  pool: Pool;
  threadId: string;
  task: Task;
  offeringId: string;
  /** Kept with the ID, so history reads correctly after the model is gone. */
  label: string;
  endpointName: string;
  kind: "cloud" | "local";
  /** Why the first model in the list didn't answer, when it didn't. */
  fallback?: string;
  /** Such as a model that couldn't think at the level asked for. */
  note?: string;
  /** How the turn went, once it ended: counts and times only. */
  pace?: Pace;
  /** A speech call's seconds of audio, heard or spoken. */
  audioSeconds?: number;
}

/**
 * One turn's measurements. `promptTokens` is the last request's whole prompt
 * (the context used); `processed` is the prompt tokens the server actually
 * read (not from its cache), over every request in the turn; `ttftMs` is the
 * time to the first token, summed over those requests, and `genMs` the time
 * from there to the end; `outputTokens` is everything written.
 */
export interface Pace {
  promptTokens: number;
  /** Every request read, including cached reads; absent on older records. */
  readTokens?: number;
  outputTokens: number;
  window: number;
  ttftMs: number;
  genMs: number;
  processed: number;
  /** Output tokens per second of generation. */
  tokPerSec?: number;
  /** Prompt tokens read per second, before the first token. */
  promptTokPerSec?: number;
}

/** Speeds from a turn's counts and times; absent where a time is too short to mean anything. */
export function speeds(p: Omit<Pace, "tokPerSec" | "promptTokPerSec">): Pace {
  const rate = (n: number, ms: number) => (ms >= 50 && n > 0 ? Math.round((n / ms) * 10_000) / 10 : undefined);
  const tok = rate(p.outputTokens, p.genMs);
  const prompt = rate(p.processed, p.ttftMs);
  return { ...p, ...(tok !== undefined ? { tokPerSec: tok } : {}), ...(prompt !== undefined ? { promptTokPerSec: prompt } : {}) };
}

/**
 * One thread's tokens on one model: `input` and `output` split `tokens` where known; `gpuMs` for local models only.
 * `cached` of `measured` input tokens were read from the server's cache, over the call records still kept that measured it.
 */
export interface UsageRow { threadId: string; label: string; kind?: "local" | "cloud"; tokens: number; input: number; output: number; gpuMs?: number; cached?: number; measured?: number }

/** An endpoint's call count, and its recent speeds when it has measured turns (Models.endpointUses). */
export interface EndpointUse { endpointId: string; calls: number; tokPerSec?: number; promptTokPerSec?: number; speedCalls?: number }
/** How many of an endpoint's latest measured turns its recent speed averages over, and how far back they may reach. */
export const SPEED_CALLS = 10;
export const SPEED_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Private and local-only threads may use local endpoints only. */
export const isRestricted = (ctx: Pick<CallContext, "pool" | "localOnly">): boolean => ctx.pool === "private" || ctx.localOnly;

export function checkTask(task: string): Task {
  if (!(TASKS as readonly string[]).includes(task)) throw new Error(`unknown task ${task}; tasks are ${TASKS.join(", ")}`);
  return task as Task;
}

/** What a task needs: text models, embeddings, images or speech. `same` stays within one. */
const capability = (t: Task) => (t === "embedding" ? "embedding" : t === "vision" ? "vision" : t === "image.create" ? "image" : t === "image.edit" ? "edit" : t === "image.upscale" ? "upscale"
  : t === "video" ? "video" : t === "speech.transcribe" ? "transcribe" : t === "speech.speak" ? "speak" : "text");
/** Tasks with no list of their own follow chat, except these. */
const OWN_LIST_ONLY: readonly Task[] = ["embedding", "vision", "image.create", "image.edit", "image.upscale", "video", "speech.transcribe", "speech.speak"];
/** A new preset starts with these following other tasks. */
const NEW_PRESET: Partial<Record<Task, { same: Task }>> = {
  code: { same: "subagent.strong" },
  title: { same: "subagent.cheap" }, compaction: { same: "subagent.cheap" }, watching: { same: "subagent.cheap" },
  "sleep.consolidate": { same: "subagent.strong" }, "sleep.dream": { same: "subagent.strong" }, "sleep.wake": { same: "subagent.strong" },
};

/** Tasks added after presets were first stored: a preset with no entry for one gets its NEW_PRESET default when read. */
const LATER_TASKS: readonly Task[] = ["watching", "code"];

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/i;
/** A primary language tag: "en", "zh", "yue". */
export const LANGUAGE = /^[a-zA-Z]{2,3}$/;
const SHARED = "shared.";

/** Loopback or the tailnet, by the URL's host alone. */
function nearby(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".ts.net")) return true;
  if (isIP(h) === 4) {
    const [a, b] = h.split(".").map(Number) as [number, number];
    return a === 127 || (a === 100 && b >= 64 && b < 128);
  }
  return isIP(h) === 6 && (h === "::1" || /^fd7a:115c:a1e0:/.test(h));
}

async function localWarning(ep: Endpoint): Promise<string | undefined> {
  const urls = ep.api === "host" ? (ep.addresses ?? []).map(hostOrigin) : [ep.baseUrl];
  const warnings: string[] = [];
  for (const url of urls) {
    const host = new URL(url).hostname;
    try {
      // A resolver that never answers is no answer.
      const outside = await Promise.race([addressesOutside(url), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000).unref())]);
      if (outside.length) warnings.push(`${host} resolves to ${outside.join(", ")}`);
    } catch {
      warnings.push(`${host} doesn't resolve`);
    }
  }
  return warnings.length ? `${ep.name} is declared local, but ${warnings.join(", and ")}, outside loopback, private and tailnet addresses` : undefined;
}

interface EndpointRow { id: string; name: string; kind: "cloud" | "local"; api: string; base_url: string; api_key: string | null; down_since: string | null; addresses: string | null; pin: string | null; paused_at: string | null }
interface OfferingRow { id: string; endpoint: string; model: string; found: string; hand: string; manual: number; missing_since: string | null }
interface GroupRow { id: string; name: string; members: string }
interface PresetRow { id: string; name: string; scope: PresetScope; builtin: "local" | "cloud" | null; entries: string; updated_at: string }

const toEndpoint = (r: EndpointRow, shared: boolean, now = Date.now()): Endpoint => {
  const url = new URL(r.base_url);
  const plan = isPlan(r.api);
  return {
    id: r.id, name: r.name, kind: r.kind, api: plan ? r.api as PlanKind : r.api === "host" ? "host" : "openai-compatible", baseUrl: r.base_url, shared,
    // A plan's api_key column holds its sign-in, which is read only through planCredential.
    ...(r.api_key && !plan ? { apiKey: r.api_key } : {}),
    ...(plan && !r.api_key ? { signedOut: true } : {}),
    ...(r.api === "host" ? { addresses: JSON.parse(r.addresses ?? "[]") as string[], fingerprint: r.pin ?? "" } : {}),
    unencrypted: r.kind === "local" && url.protocol === "http:" && !nearby(url.hostname),
    ...(r.down_since ? { downSince: r.down_since } : {}),
    stale: !!r.down_since && now - Date.parse(r.down_since) >= STALE_DAYS * DAY,
    ...(r.paused_at ? { pausedAt: r.paused_at } : {}),
  };
};
const toOffering = (r: OfferingRow, now = Date.now()): Offering => {
  const caps: Capabilities & { digest?: string; identity?: ModelIdentity; downloaded?: boolean; size?: number; recipe?: string; mask?: boolean; useFor?: Offering["useFor"]; separate?: boolean; servedContext?: number; servedParallel?: number; opensThinking?: boolean; alwaysThinks?: boolean; lmStudio?: boolean; llamaServer?: boolean; price?: ModelPrice; retiresAt?: string; maxOutput?: number } = { ...JSON.parse(r.found), ...JSON.parse(r.hand) };
  // A host's serving settings decide its context window, over one set by hand and one discovered.
  const served = (JSON.parse(r.found) as { servedContext?: number }).servedContext;
  if (served) caps.contextWindow = served;
  const gone = !!r.missing_since && now - Date.parse(r.missing_since) >= GONE_DAYS * DAY;
  return {
    id: r.id, endpointId: r.endpoint, modelId: r.model, manual: r.manual === 1,
    ...Object.fromEntries(CAPABILITIES.filter((k) => caps[k] !== undefined).map((k) => [k, caps[k]])),
    status: gone ? "gone" : r.missing_since ? "missing" : "listed",
    ...(r.missing_since ? { missingSince: r.missing_since } : {}),
    ...(typeof caps.digest === "string" ? { digest: caps.digest } : {}),
    ...(caps.identity ? { identity: caps.identity } : {}),
    ...(caps.downloaded !== undefined ? { downloaded: caps.downloaded } : {}),
    ...(caps.size ? { size: caps.size } : {}),
    ...(caps.recipe ? { recipe: caps.recipe, useFor: caps.useFor ?? "both" } : {}),
    ...(caps.mask !== undefined ? { mask: caps.mask } : {}),
    ...(caps.separate ? { separate: true } : {}),
    ...(caps.opensThinking ? { opensThinking: true } : {}),
    ...(caps.alwaysThinks ? { alwaysThinks: true } : {}),
    ...(caps.lmStudio ? { lmStudio: true } : {}),
    ...(caps.llamaServer ? { llamaServer: true } : {}),
    ...(caps.servedParallel ? { parallel: caps.servedParallel } : {}),
    ...(caps.price ? { price: caps.price } : {}),
    ...(caps.retiresAt ? { retiresAt: caps.retiresAt } : {}),
    ...(caps.maxOutput ? { maxOutput: caps.maxOutput } : {}),
  };
};
const toGroup = (r: GroupRow, shared: boolean): Group => ({ id: r.id, name: r.name, shared, members: JSON.parse(r.members) });
const factsOf = (m: DiscoveredModel): Capabilities => {
  const { modelId: _m, ...caps } = m;
  return Object.fromEntries(Object.entries(caps).filter(([, v]) => v !== undefined));
};

/** Every endpoint, offering and group one user can see, read once. */
interface Catalog {
  endpoints: Map<string, Endpoint>;
  offerings: Map<string, Offering>;
  groups: Map<string, Group>;
}

/**
 * Endpoints, offerings, groups, presets and the router. Shared endpoints
 * and groups live in self.db and change only with an administrator actor; a
 * user's own endpoints, groups, presets and thread choices live in their
 * user.db, so the user must be unlocked. Opening a user's user.db first
 * applies any redirects they haven't applied yet, so their lists follow
 * replacements and removals made while they were locked.
 */
export class Models {
  /** Users whose user.db was migrated and indexed since this process started. */
  private readonly ready = new Set<string>();
  /** Endpoint ID → whether it answered lately, from probes and calls. */
  private readonly health = new Map<string, { up: boolean; at: number }>();
  /** Hosts that answered `unpaired`: they revoked this server, so pairing again is the fix. Cleared when one answers or is paired again. */
  private readonly unpaired = new Set<string>();
  /** Models whose host answered but couldn't run them (`model_unavailable`), skipped for HEALTH_MS without marking the host down. */
  private readonly modelDown = new Map<string, number>();
  /** Each host's pinned fetch, by endpoint, key and addresses. */
  private readonly fetches = new Map<string, typeof fetch>();
  /** The address each host last answered on, for its dashboard link. */
  private readonly reached = new Map<string, string>();
  /** Each host's last status that wasn't running (paused, pausing, restarting): the page keeps showing it, with Resume, while the router skips the host. */
  private readonly awayStatus = new Map<string, unknown>();
  /** Finished downloads already read as offerings, by host and download ID. */
  private readonly discovered = new Set<string>();
  /** Plans that reached their usage limit, until when they're skipped. */
  private readonly limited = new Map<string, number>();
  /** The last guessed wait for a plan that didn't say when it resets, and when that guess ran out. */
  private readonly guessed = new Map<string, { ms: number; until: number }>();
  /** Limited plans the user chose to fall back from until they reset. */
  private readonly fallingBack = new Set<string>();
  /** Offerings whose provider refused a request with thinking off (mustThink). */
  private readonly alwaysThinks = new Set<string>();
  /** Models seen thinking though their server lists no thinking levels: they think on their own, so nothing says they can't. */
  private readonly thinksUnasked = new Set<string>();
  private codexImages?: (userId: string, request: ImageRequest, signal?: AbortSignal) => Promise<GeneratedImage[]>;

  /** The models each plan offers (setPlanCatalog). */
  private planCatalog: (kind: PlanKind) => DiscoveredModel[] = () => [];

  constructor(private readonly keyring: Keyring, private readonly users: Users) {}

  // --- Endpoints ---

  addEndpoint(actor: User, input: { name: string; kind: "cloud" | "local"; baseUrl: string; apiKey?: string }, opts: { shared?: boolean } = {}): Endpoint {
    checkName(input.name);
    if (input.kind !== "cloud" && input.kind !== "local") throw new Error("an endpoint is either cloud or local");
    const baseUrl = checkUrl(input.baseUrl, input.kind);
    const id = randomUUID();
    this.place(actor, !!opts.shared, (db) => {
      if (db.prepare("SELECT 1 FROM endpoints WHERE name = ?").get(input.name)) throw new Error(`endpoint ${input.name} already exists`);
      db.prepare("INSERT INTO endpoints (id, name, kind, api, base_url, api_key, created_at) VALUES (?, ?, ?, 'openai-compatible', ?, ?, ?)")
        .run(id, input.name, input.kind, baseUrl, input.apiKey || null, new Date().toISOString());
    });
    return this.endpoint(actor.id, id)!;
  }

  /** Renames an endpoint, changes its URL or key, or pauses or resumes it. Its IDs, and its models' IDs, never change. A null key removes it. */
  editEndpoint(actor: User, id: string, change: { name?: string; baseUrl?: string; apiKey?: string | null; paused?: boolean }): Endpoint {
    if (change.name !== undefined) checkName(change.name);
    const ep = this.endpoint(actor.id, id);
    const api = ep?.api;
    if (change.paused !== undefined && api === "host") throw new Error("a model host pauses itself: use its Pause");
    if ((change.baseUrl !== undefined || change.apiKey !== undefined) && api === "host") throw new Error("a model host has addresses and a pinned key, not a URL or an API key");
    if ((change.baseUrl !== undefined || change.apiKey !== undefined) && isPlan(api)) throw new Error(`a ${PLAN_NAMES[api]} plan signs in with ${PLAN_NAMES[api]}; it has no URL or API key to change`);
    const baseUrl = change.baseUrl === undefined ? undefined : checkUrl(change.baseUrl, ep?.kind ?? "local");
    this.write(actor, id, (db) => {
      const current = db.prepare("SELECT * FROM endpoints WHERE id = ?").get(id) as EndpointRow;
      if (change.name !== undefined && change.name !== current.name && db.prepare("SELECT 1 FROM endpoints WHERE name = ?").get(change.name)) {
        throw new Error(`endpoint ${change.name} already exists`);
      }
      db.prepare("UPDATE endpoints SET name = ?, base_url = ?, api_key = ?, paused_at = ? WHERE id = ?").run(
        change.name ?? current.name, baseUrl ?? current.base_url, change.apiKey === undefined ? current.api_key : change.apiKey || null,
        change.paused === undefined ? current.paused_at ?? null : change.paused ? new Date().toISOString() : null, id);
    });
    this.health.delete(id);
    return this.endpoint(actor.id, id)!;
  }

  /** Removes an endpoint. Each of its models leaves a tombstone, so lists that named them drop them. */
  removeEndpoint(actor: User, id: string): void {
    this.retire(actor, this.isShared(id), (db) => {
      if (!db.prepare("SELECT 1 FROM endpoints WHERE id = ?").get(id)) throw new Error(`no endpoint ${id}`);
      return (db.prepare("SELECT id FROM offerings WHERE endpoint = ?").all(id) as { id: string }[]).map((r) => [r.id, null]);
    }, (db) => { db.prepare("DELETE FROM endpoints WHERE id = ?").run(id); });
  }

  // --- Subscription plans ---

  /** ChatGPT Images runs the user's own Codex; the daemon installs the runner, which knows where their encrypted home is. */
  setCodexImages(run: (userId: string, request: ImageRequest, signal?: AbortSignal) => Promise<GeneratedImage[]>): void {
    this.codexImages = run;
  }

  /** Throws when a name can't name an endpoint, so a sign-in isn't started for one that would be refused after it. */
  checkEndpointName(name: string): void { checkName(name); }

  /**
   * Adds a ChatGPT or Grok plan from a finished sign-in: always cloud,
   * always the user's own (a plan belongs to one person), calling its
   * PLAN_URLS entry. Its sign-in is kept in the user's user.db, in the api_key column.
   */
  addPlan(actor: User, input: { name: string; plan: PlanKind; credential: PlanCredential }): Endpoint {
    checkName(input.name);
    if (!isPlan(input.plan)) throw new Error("a plan is ChatGPT or Grok");
    const id = randomUUID();
    this.place(actor, false, (db) => {
      if (db.prepare("SELECT 1 FROM endpoints WHERE name = ?").get(input.name)) throw new Error(`endpoint ${input.name} already exists`);
      db.prepare("INSERT INTO endpoints (id, name, kind, api, base_url, api_key, created_at) VALUES (?, ?, 'cloud', ?, ?, ?, ?)")
        .run(id, input.name, input.plan, PLAN_URLS[input.plan], JSON.stringify(checkCredential(input.credential)), new Date().toISOString());
    });
    return this.endpoint(actor.id, id)!;
  }

  /** A plan's sign-in, or undefined when it is signed out. Only its owner's user.db has it. */
  planCredential(userId: string, endpointId: string): PlanCredential | undefined {
    return this.withUser(userId, (db) => {
      const r = db.prepare("SELECT api_key FROM endpoints WHERE id = ? AND api IN ('chatgpt', 'grok')").get(endpointId) as { api_key: string | null } | undefined;
      return r?.api_key ? JSON.parse(r.api_key) as PlanCredential : undefined;
    });
  }

  /** Only an explicit account label from sign-in; never decode or return tokens. */
  planAccount(userId: string, endpointId: string): string | undefined {
    const c = this.planCredential(userId, endpointId);
    const account = c?.email ?? c?.accountId;
    return typeof account === "string" && account.trim() ? account : undefined;
  }

  /**
   * Saves a plan's refreshed or new sign-in, keeping every ID. Null signs it
   * out: the router skips it until it signs in again.
   */
  setPlanCredential(userId: string, endpointId: string, credential: PlanCredential | null): void {
    this.withUser(userId, (db) => {
      const r = db.prepare("UPDATE endpoints SET api_key = ? WHERE id = ? AND api IN ('chatgpt', 'grok')").run(credential ? JSON.stringify(checkCredential(credential)) : null, endpointId);
      if (!r.changes) throw new Error(`no plan ${endpointId}`);
    });
    if (credential) this.health.delete(endpointId);
  }

  /** This installation's ID for Sign in with ChatGPT, which OpenAI asks for: made on first use and kept in self.db. */
  installationId(): string {
    const db = this.self();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'chatgpt.installation'").get() as { value: string } | undefined;
    if (row) return row.value;
    const id = randomUUID();
    db.prepare("INSERT INTO settings (key, value) VALUES ('chatgpt.installation', ?)").run(id);
    return id;
  }

  /** The models each plan offers, from Pi's catalogue (core has no Pi). Set once at start. */
  setPlanCatalog(list: (kind: PlanKind) => DiscoveredModel[]): void {
    this.planCatalog = list;
  }

  /** The user's own endpoints, then the shared ones. */
  endpoints(userId: string): Endpoint[] {
    return [...this.catalog(userId).endpoints.values()];
  }

  endpoint(userId: string, id: string): Endpoint | undefined {
    return this.catalog(userId).endpoints.get(id);
  }

  /** An endpoint's models. */
  offerings(userId: string, endpointId: string): Offering[] {
    return [...this.catalog(userId).offerings.values()].filter((o) => o.endpointId === endpointId);
  }

  /** An offering and its endpoint, if this user can see it. */
  offering(userId: string, offeringId: string): { endpoint: Endpoint; offering: Offering } | undefined {
    const c = this.catalog(userId);
    const offering = c.offerings.get(offeringId);
    return offering && { endpoint: c.endpoints.get(offering.endpointId)!, offering };
  }

  /**
   * How a model is named to people and to Lyrica: `<endpoint>/<model>`, with
   * shared endpoints as `shared.<name>` so the two never collide. A group is
   * named by its name.
   */
  label(userId: string, id: string): string | undefined {
    const c = this.catalog(userId);
    const o = c.offerings.get(id);
    if (o) return labelOf(c.endpoints.get(o.endpointId)!, o);
    const g = c.groups.get(id);
    return g && `${g.shared ? SHARED : ""}${g.name}`;
  }

  /** Finds an offering by its ID or its label, or a group by its ID. */
  find(userId: string, idOrLabel: string): ModelRef | undefined {
    const c = this.catalog(userId);
    if (c.offerings.has(idOrLabel)) return { offeringId: idOrLabel };
    if (c.groups.has(idOrLabel)) return { groupId: idOrLabel };
    const i = idOrLabel.indexOf("/");
    if (i <= 0) return undefined;
    const ep = this.findEndpoint(userId, idOrLabel.slice(0, i));
    const model = idOrLabel.slice(i + 1);
    const on = ep ? [...c.offerings.values()].filter((x) => x.endpointId === ep.id) : [];
    // A recipe's label uses its name; its `recipe/<id>` model ID still works.
    const o = on.find((x) => x.modelId === model) ?? on.find((x) => x.recipe === model);
    return o && { offeringId: o.id };
  }

  /** Finds an endpoint by its ID or its label: its name, or `shared.<name>` for a shared one. */
  findEndpoint(userId: string, idOrLabel: string): Endpoint | undefined {
    return this.endpoints(userId).find((e) => e.id === idOrLabel || (e.shared ? SHARED + e.name : e.name) === idOrLabel);
  }

  /** Records a model by hand, for servers whose /v1/models says too little. Returns its offering. */
  addModel(actor: User, endpointId: string, m: { modelId: string } & Capabilities): Offering {
    if (!m.modelId) throw new Error("a model needs its ID");
    const { modelId, ...caps } = m;
    if (m.useFor !== undefined && !["fast", "quality", "both"].includes(m.useFor)) throw new Error("useFor is fast, quality or both");
    let id = "";
    this.write(actor, endpointId, (db) => {
      const row = db.prepare("SELECT id, hand FROM offerings WHERE endpoint = ? AND model = ?").get(endpointId, modelId) as { id: string; hand: string } | undefined;
      const hand = JSON.stringify(clean({ ...(row ? JSON.parse(row.hand) : {}), ...caps }));
      id = row?.id ?? randomUUID();
      if (row) db.prepare("UPDATE offerings SET hand = ?, missing_since = NULL WHERE id = ?").run(hand, id);
      else db.prepare("INSERT INTO offerings (id, endpoint, model, hand, manual, created_at) VALUES (?, ?, ?, ?, 1, ?)").run(id, endpointId, modelId, hand, new Date().toISOString());
    });
    return this.offering(actor.id, id)!.offering;
  }

  /** Sets capabilities by hand. They win over what discovery reports; undefined leaves one as it is, null clears it. */
  setCapabilities(actor: User, offeringId: string, caps: { [K in keyof Capabilities]?: Capabilities[K] | null }): Offering {
    const o = this.offering(actor.id, offeringId);
    if (!o) throw new NoModel(`no model ${offeringId}`);
    if (caps.useFor != null && !["fast", "quality", "both"].includes(caps.useFor)) throw new Error("useFor is fast, quality or both");
    if (caps.reasoning?.some((l) => !THINKING_LEVELS.includes(l) || (l as string) === "off")) throw new Error("reasoning levels are low, medium and high");
    if (caps.transcribe !== undefined && caps.transcribe !== null && typeof caps.transcribe !== "boolean") throw new Error("transcribe is true or false");
    if (caps.speak) caps = { ...caps, speak: { voices: checkVoices(caps.speak.voices) } };
    this.write(actor, o.endpoint.id, (db) => {
      const row = db.prepare("SELECT hand FROM offerings WHERE id = ?").get(offeringId) as { hand: string };
      const hand: Record<string, unknown> = JSON.parse(row.hand);
      for (const k of CAPABILITIES) if (caps[k] === null) delete hand[k]; else if (caps[k] !== undefined) hand[k] = caps[k];
      db.prepare("UPDATE offerings SET hand = ? WHERE id = ?").run(JSON.stringify(hand), offeringId);
    });
    const after = this.offering(actor.id, offeringId)!.offering;
    const lost = DROPPABLE.filter(([, has]) => has(o.offering) && !has(after)).map(([task]) => task);
    if (lost.length) this.dropFromLists(actor.id, offeringId, lost);
    return after;
  }

  /**
   * A model that can no longer do a task leaves that task's lists in this
   * user's presets and columns, so a list never holds an entry the router
   * would skip and the user couldn't remove. Groups stay: other copies may fit.
   */
  private dropFromLists(userId: string, offeringId: string, tasks: Task[]): void {
    this.editLists(userId, (table) => {
      let changed = false;
      for (const task of tasks) {
        const e = table[task];
        if (!isList(e) || !e.some((r) => "offeringId" in r && r.offeringId === offeringId)) continue;
        const kept = e.filter((r) => !("offeringId" in r && r.offeringId === offeringId));
        if (kept.length) table[task] = kept; else delete table[task];
        changed = true;
      }
      return changed;
    });
  }

  /** Changes this user's presets and columns in one transaction; `edit` changes a table in place and says whether it did. */
  private editLists(userId: string, edit: (table: Profiles, scope: PresetScope) => boolean): void {
    const prune = (raw: string, scope: PresetScope): string | undefined => {
      const table = JSON.parse(raw) as Profiles;
      return edit(table, scope) ? JSON.stringify(table) : undefined;
    };
    this.withUser(userId, (db) => {
      db.transaction(() => {
        for (const r of db.prepare("SELECT id, scope, entries FROM model_presets").all() as { id: string; scope: PresetScope; entries: string }[]) {
          const next = prune(r.entries, r.scope);
          if (next) db.prepare("UPDATE model_presets SET entries = ?, updated_at = ? WHERE id = ?").run(next, new Date().toISOString(), r.id);
        }
        for (const r of db.prepare("SELECT column, entries FROM model_columns").all() as { column: Column; entries: string }[]) {
          const next = prune(r.entries, r.column);
          if (next) db.prepare("UPDATE model_columns SET entries = ? WHERE column = ?").run(next, r.column);
        }
        syncLegacy(db);
      })();
      this.index(userId, db);
    });
  }

  /**
   * Re-reads what the endpoint lists. A new model gets an offering; one no
   * longer listed keeps its offering, marked missing; one listed again is
   * no longer missing. IDs never change.
   */
  async discover(actor: User, endpointId: string): Promise<Offering[]> {
    const ep = this.endpoint(actor.id, endpointId);
    if (!ep) throw new Error(`no endpoint ${endpointId}`);
    let found: DiscoveredModel[];
    // A router's models it wasn't asked about (not loaded): they keep what /props said of them last time.
    const unasked = new Set<string>();
    try {
      if (ep.signedOut) throw new Error(`${ep.name} is signed out; sign in again`);
      found = ep.api === "host" ? await this.hostModels(ep) : isPlan(ep.api) ? this.planCatalog(ep.api) : await discoverModels(ep.baseUrl, ep.apiKey);
      // LM Studio says which models are loaded and with what context: plan by that, like a host's.
      // An unloaded one keeps the hand-set or default window: LM Studio loads it on demand at its own default, not its maximum.
      const lm = ep.kind === "local" && ep.api !== "host" && !isPlan(ep.api) ? await lmStudioModels(ep.baseUrl, ep.apiKey) : null;
      if (lm) found = found.map((m) => {
        const l = lmStudioModel(lm, m.modelId);
        const served = l?.instances[0]?.context;
        const parallel = l?.instances[0]?.parallel;
        // Its OpenAI-compatible list says nothing about images, thinking, embeddings or tools; its own API says.
        return { ...m, ...(served ? { servedContext: served } : {}), ...(parallel ? { servedParallel: parallel } : {}), ...(l ? { lmStudio: true } : {}), ...(m.vision === undefined && l?.vision !== undefined ? { vision: l.vision } : {}),
          ...(m.embedding === undefined && l?.embedding ? { embedding: true } : {}), ...(m.tools === undefined && l?.tools ? { tools: true } : {}),
          ...(m.reasoning === undefined && l?.reasoning ? { reasoning: l.reasoning.levels, ...(l.reasoning.canTurnOff ? {} : { alwaysThinks: true }) } : {}) };
      });
      // A plain llama-server lists only IDs and context; its /props has the chat template, a projector and the slots.
      // A router (its list gives each model's state) is asked only about loaded models, one at a time: it may load what it's asked about.
      // A server serving one model is asked once, without naming it.
      else if (ep.kind === "local" && ep.api !== "host" && !isPlan(ep.api)) {
        const router = found.some((m) => m.routerState !== undefined);
        const props = new Map<string, LlamaServerModel>();
        if (router) {
          for (const m of found) {
            if (m.routerState !== "loaded") { unasked.add(m.modelId); continue; }
            const l = await llamaServerModel(ep.baseUrl, ep.apiKey, m.modelId);
            if (l) props.set(m.modelId, l);
          }
        } else if (found.length === 1) {
          const l = await llamaServerModel(ep.baseUrl, ep.apiKey);
          if (l) props.set(found[0]!.modelId, l);
        }
        found = found.map((m) => {
          const l = props.get(m.modelId);
          if (!l) return m;
          return { ...m, llamaServer: true, ...(l.parallel ? { servedParallel: l.parallel } : {}), ...(l.opensThinking ? { opensThinking: true } : {}),
            ...(m.reasoning === undefined && l.reasoning ? { reasoning: l.reasoning } : {}), ...(m.tools === undefined && l.tools ? { tools: true } : {}),
            ...(m.vision === undefined && l.vision !== undefined ? { vision: l.vision } : {}) };
        });
      }
      found = found.map(({ routerState: _, ...m }) => m);
      // A ChatGPT plan's image tool is one model of its own, not a switch on each chat model.
      if (ep.api === "chatgpt") found = [...found, PLAN_IMAGE];
    } catch (err) {
      this.seen(ep, false, actor.id);
      throw err;
    }
    this.seen(ep, true, actor.id);
    this.readAt.set(ep.id, Date.now());
    const now = new Date().toISOString();
    let planImage: string | undefined;
    this.write(actor, endpointId, (db) => {
      db.transaction(() => {
        const have = new Map((db.prepare("SELECT id, model FROM offerings WHERE endpoint = ?").all(endpointId) as { id: string; model: string }[]).map((r) => [r.model, r.id]));
        for (let m of found) {
          const id = have.get(m.modelId);
          if (id && unasked.has(m.modelId)) {
            const prev = JSON.parse((db.prepare("SELECT found FROM offerings WHERE id = ?").get(id) as { found: string }).found) as DiscoveredModel;
            if (prev.llamaServer) m = { ...m, llamaServer: true, ...Object.fromEntries((["reasoning", "tools", "vision", "opensThinking", "servedParallel"] as const)
              .filter((k) => m[k] === undefined && prev[k] !== undefined).map((k) => [k, prev[k]])) };
          }
          if (id) db.prepare("UPDATE offerings SET found = ?, missing_since = NULL WHERE id = ?").run(JSON.stringify(factsOf(m)), id);
          else {
            const added = randomUUID();
            db.prepare("INSERT INTO offerings (id, endpoint, model, found, manual, created_at) VALUES (?, ?, ?, ?, 0, ?)").run(added, endpointId, m.modelId, JSON.stringify(factsOf(m)), now);
            if (m.modelId === PLAN_IMAGE_MODEL) planImage = added;
          }
        }
        const listed = new Set(found.map((m) => m.modelId));
        const missing = db.prepare("UPDATE offerings SET missing_since = ? WHERE id = ? AND missing_since IS NULL AND manual = 0");
        for (const [model, id] of have) if (!listed.has(model)) missing.run(now, id);
      })();
    });
    // Once, when it is first found: image lists that named one of the plan's chat
    // models move to its image model, and an empty Image edits list that may use
    // cloud models gets it.
    if (planImage) {
      const to = planImage, before = new Set(this.offerings(actor.id, endpointId).filter((o) => o.id !== to).map((o) => o.id));
      this.editLists(actor.id, (table, scope) => {
        let changed = false;
        const edit = table["image.edit"];
        if (scope === "general" && (edit === undefined || (isList(edit) && !edit.length))) {
          table["image.edit"] = [{ offeringId: to }];
          changed = true;
        }
        for (const task of ["image.create", "image.edit"] as const) {
          const e = table[task];
          if (!isList(e) || !e.some((r) => "offeringId" in r && before.has(r.offeringId))) continue;
          const seen = new Set<string>();
          table[task] = e.map((r) => ("offeringId" in r && before.has(r.offeringId) ? { offeringId: to } : r)).filter((r) => !("offeringId" in r) || (!seen.has(r.offeringId) && !!seen.add(r.offeringId)));
          changed = true;
        }
        return changed;
      });
    }
    return this.offerings(actor.id, endpointId);
  }

  /**
   * Whether the endpoint answers. For a local endpoint, also a warning when its
   * host resolves outside the operator's own network. It only warns: the kind stays as declared.
   */
  async probe(userId: string, endpointId: string, timeoutMs?: number): Promise<{ state: "up" | "down"; warning?: string }> {
    const ep = this.endpoint(userId, endpointId);
    if (!ep) throw new Error(`no endpoint ${endpointId}`);
    const [state, warning] = await Promise.all([
      this.answers(ep, timeoutMs),
      ep.kind === "local" ? localWarning(ep) : undefined,
    ]);
    this.seen(ep, state === "up", userId);
    return warning ? { state, warning } : { state };
  }

  // --- The text model library ---

  /**
   * The text library: one entry per model with its copies on every endpoint,
   * the groups they're in, and whether the user starred it. Search matches
   * names and raw names; filters by kind, endpoint, capability, groups only.
   * Starred entries come first. Image recipes are in the image library.
   */
  textLibrary(userId: string, q: { search?: string; kind?: "cloud" | "local"; endpointId?: string; capability?: "tools" | "vision" | "embedding" | "image" | "transcribe" | "speak"; groupsOnly?: boolean; offset?: number; limit?: number } = {}): { total: number; entries: LibraryEntry[] } {
    const c = this.catalog(userId);
    const starred = this.starredIds(userId);
    const inGroups = new Map<string, string[]>();
    for (const g of c.groups.values()) for (const m of g.members) inGroups.set(m, [...(inGroups.get(m) ?? []), g.id]);
    const entries = new Map<string, LibraryEntry>();
    const measured = this.speedsByOffering(userId);
    for (const o of c.offerings.values()) {
      if (o.recipe) continue;
      const ep = c.endpoints.get(o.endpointId)!;
      const id = copyIdentity(o);
      const e = entries.get(id.key) ?? { key: id.key, name: id.name, ...(id.base ? { base: id.base } : {}), starred: false, copies: [], groups: [] };
      e.copies.push({
        offeringId: o.id, label: labelOf(ep, o), rawName: o.modelId, endpointId: ep.id, endpointName: ep.name, kind: ep.kind, shared: ep.shared,
        status: o.status, downloaded: !!o.downloaded, capabilities: Object.fromEntries(CAPABILITIES.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])) as Capabilities,
        groups: inGroups.get(o.id) ?? [], ...(id.flagged ? { flagged: id.flagged } : {}), ...(o.size ? { size: o.size } : {}),
        ...(measured.get(o.id) ? { speed: measured.get(o.id) } : {}),
      });
      for (const g of inGroups.get(o.id) ?? []) if (!e.groups.includes(g)) e.groups.push(g);
      if (starred.has(o.id)) e.starred = true;
      entries.set(id.key, e);
    }
    const needle = q.search?.toLowerCase().trim();
    const list = [...entries.values()].filter((e) => {
      if (needle && !e.name.includes(needle) && !e.copies.some((x) => x.rawName.toLowerCase().includes(needle) || x.label.toLowerCase().includes(needle))) return false;
      if (q.kind && !e.copies.some((x) => x.kind === q.kind)) return false;
      if (q.endpointId && !e.copies.some((x) => x.endpointId === q.endpointId)) return false;
      if (q.capability && !e.copies.some((x) => x.capabilities[q.capability!])) return false;
      if (q.groupsOnly && !e.groups.length) return false;
      return true;
    }).sort((a, b) => Number(b.starred) - Number(a.starred) || a.name.localeCompare(b.name));
    const offset = Math.max(0, q.offset ?? 0);
    return { total: list.length, entries: list.slice(offset, offset + Math.min(200, Math.max(1, q.limit ?? 50))) };
  }

  /** The models this user starred, by offering ID. */
  starredIds(userId: string): Set<string> {
    return this.withUser(userId, (db) => new Set((db.prepare("SELECT offering FROM starred_offerings").all() as { offering: string }[]).map((r) => r.offering)));
  }

  /** Stars (or unstars) a model for this user; pickers show starred models first. */
  star(userId: string, offeringId: string, on: boolean): void {
    if (!this.offering(userId, offeringId)) throw new NoModel(`no model ${offeringId}`);
    this.withUser(userId, (db) => {
      if (on) db.prepare("INSERT OR IGNORE INTO starred_offerings (offering) VALUES (?)").run(offeringId);
      else db.prepare("DELETE FROM starred_offerings WHERE offering = ?").run(offeringId);
    });
  }

  /**
   * "Not this model": moves a copy to an entry of its own (or back, with
   * false). An administrator decides for a shared endpoint, its owner for a
   * personal one.
   */
  notThisModel(actor: User, offeringId: string, separate = true): void {
    const o = this.offering(actor.id, offeringId);
    if (!o) throw new NoModel(`no model ${offeringId}`);
    this.write(actor, o.endpoint.id, (db) => {
      const row = db.prepare("SELECT hand FROM offerings WHERE id = ?").get(offeringId) as { hand: string };
      const hand = JSON.parse(row.hand) as Record<string, unknown>;
      if (separate) hand.separate = true; else delete hand.separate;
      db.prepare("UPDATE offerings SET hand = ? WHERE id = ?").run(JSON.stringify(hand), offeringId);
    });
  }

  // --- Hub tokens ---

  /** The hub tokens this user can use, as the last four characters only: their own, and a shared one an administrator saved. */
  hubTokens(userId: string): { hub: Hub; shared: boolean; last4: string }[] {
    const read = (db: Db, shared: boolean) => (db.prepare("SELECT hub, token FROM hub_tokens ORDER BY hub").all() as { hub: Hub; token: string }[])
      .map((r) => ({ hub: r.hub, shared, last4: r.token.slice(-4) }));
    return [...this.withUser(userId, (db) => read(db, false)), ...read(this.self(), true)];
  }

  /** Saves or replaces a token for Hugging Face or ModelScope: the user's own, or (administrators) one shared with every user. */
  setHubToken(actor: User, hub: Hub, token: string, opts: { shared?: boolean } = {}): void {
    if (hub !== "huggingface" && hub !== "modelscope") throw new Error("tokens are for huggingface or modelscope");
    const t = String(token ?? "").trim();
    if (t.length < 8 || /\s/.test(t)) throw new Error("that doesn't look like an access token");
    this.place(actor, !!opts.shared, (db) => db.prepare("INSERT OR REPLACE INTO hub_tokens (hub, token) VALUES (?, ?)").run(hub, t));
  }

  removeHubToken(actor: User, hub: Hub, opts: { shared?: boolean } = {}): void {
    this.place(actor, !!opts.shared, (db) => db.prepare("DELETE FROM hub_tokens WHERE hub = ?").run(hub));
  }

  /** The token sent with a request to `hub`: the user's own, else the shared one. Never returned by the API. */
  private tokenFor(userId: string, hub: string): string | undefined {
    const sql = "SELECT token FROM hub_tokens WHERE hub = ?";
    return (this.withUser(userId, (db) => db.prepare(sql).get(hub)) as { token: string } | undefined)?.token
      ?? (this.self().prepare(sql).get(hub) as { token: string } | undefined)?.token;
  }

  // --- Downloads, deleting, and the image library, through a host's management API ---

  /** A repository's files on a host: which are there already and which are too big for its free space. */
  async hubFiles(actor: User, hostId: string, q: { source: Hub; repo: string; revision?: string }): Promise<unknown> {
    const ep = this.manageable(actor, hostId);
    const params = new URLSearchParams({ source: q.source, repo: q.repo, ...(q.revision ? { revision: q.revision } : {}) });
    return this.hostCall(ep, "GET", `/host/v1/hub/files?${params}`, undefined, this.hubHeader(actor.id, q.source));
  }

  /** Starts downloads on a host (host/API.md): files from a repository, or one https link. */
  async startDownload(actor: User, hostId: string, body: { source: Hub; repo: string; revision?: string; files: string[] } | { source: "url"; url: string; sha256?: string }): Promise<unknown> {
    const ep = this.manageable(actor, hostId);
    const checked = downloadBody(body);
    return this.hostCall(ep, "POST", "/host/v1/downloads", checked, checked.source === "url" ? undefined : this.hubHeader(actor.id, checked.source));
  }

  /**
   * A host's downloads. A download that finished since the last look is read
   * as a new offering at once, and the group suggestions pick it up.
   */
  async downloads(actor: User, hostId: string): Promise<{ downloads: { id: string; state: string }[] }> {
    const ep = this.manageable(actor, hostId);
    const downloads = listIn<{ id: string; state: string }>(await this.hostCall(ep, "GET", "/host/v1/downloads"), "downloads") ?? [];
    const fresh = downloads.filter((d) => d.state === "done" && !this.discovered.has(`${hostId}/${d.id}`));
    if (fresh.length) {
      await this.discover(actor, hostId);
      for (const d of fresh) this.discovered.add(`${hostId}/${d.id}`);
    }
    return { downloads };
  }

  /** Cancels an unfinished download (its partial file goes), or clears a finished one from the list. */
  async cancelDownload(actor: User, hostId: string, downloadId: string): Promise<unknown> {
    return this.hostCall(this.manageable(actor, hostId), "DELETE", `/host/v1/downloads/${encodeURIComponent(downloadId)}`);
  }

  /**
   * Deletes a copy Lyrica downloaded, from its host. Without `confirm`, it
   * only says where the copy is used. Only files in the host's download
   * record go; anything else (a shared models folder) is refused. The
   * offering leaves a tombstone, so every list skips it.
   */
  async deleteCopy(actor: User, offeringId: string, opts: { confirm?: boolean } = {}): Promise<{ usedIn: Use[]; deleted?: string[]; left?: { files: string[]; reason: string } }> {
    const o = this.offering(actor.id, offeringId);
    if (!o) throw new NoModel(`no model ${offeringId}`);
    const ep = this.manageable(actor, o.endpoint.id);
    const usedIn = [...(this.uses(actor.id).get(offeringId) ?? []), ...(collectRefs(this.self()).get(offeringId) ?? [])];
    if (!opts.confirm) return { usedIn };
    const record = listIn<{ path: string }>(await this.hostCall(ep, "GET", "/host/v1/files"), "files") ?? [];
    const files = record.map((f) => f.path).filter((p) => copyFile(o.offering.modelId, p));
    if (!files.length) throw new HostRefused("refused", "Only files Lyrica downloaded can be deleted.");
    // A split GGUF is offered as its first shard; every shard goes. If one can't, the copy is gone anyway: say what's left.
    const deleted: string[] = [];
    let left: { files: string[]; reason: string } | undefined;
    for (const path of files) {
      try {
        await this.hostCall(ep, "DELETE", `/host/v1/files?${new URLSearchParams({ path })}`);
        deleted.push(path);
      } catch (e) {
        if (!deleted.length) throw e;
        left = { files: files.filter((f) => !deleted.includes(f)), reason: (e as Error).message };
        break;
      }
    }
    this.removeOffering(actor, offeringId);
    return { usedIn, deleted, ...(left ? { left } : {}) };
  }

  /** A host's image library: its recipes (with proposals and missing parts) and its parts by role. */
  async imageLibrary(userId: string, hostId: string): Promise<{ recipes: unknown[]; parts: Record<string, unknown[]> }> {
    const ep = this.needHost(userId, hostId);
    const recipes = listIn<unknown>(await this.hostCall(ep, "GET", "/host/v1/recipes"), "recipes") ?? [];
    const parts = listIn<{ role?: string }>(await this.hostCall(ep, "GET", "/host/v1/parts"), "parts") ?? [];
    const byRole: Record<string, unknown[]> = {};
    for (const p of parts) (byRole[p.role ?? "unknown"] ??= []).push(p);
    return { recipes, parts: byRole };
  }

  /** The starter recipes a host ships, each part marked `present` when it is already on the host (host/API.md). */
  async starters(userId: string, hostId: string): Promise<unknown[]> {
    return listIn<unknown>(await this.hostCall(this.needHost(userId, hostId), "GET", "/host/v1/starters"), "starters") ?? [];
  }

  /**
   * Makes a starter recipe on a host: it downloads the parts not there yet,
   * with the user's hub token when one is saved, and confirms the recipe,
   * which becomes an offering. Again, it gives back the same recipe. A
   * shared host needs an administrator.
   */
  async installStarter(actor: User, hostId: string, starterId: string): Promise<unknown> {
    const ep = this.manageable(actor, hostId);
    const all = listIn<{ id?: string; parts?: { source?: string; present?: boolean }[] }>(await this.hostCall(ep, "GET", "/host/v1/starters"), "starters") ?? [];
    const starter = all.find((s) => s.id === starterId);
    if (!starter) throw new Error(`${ep.name} has no starter ${starterId}`);
    const hubs = new Set((starter.parts ?? []).filter((p) => !p.present).map((p) => p.source));
    const hub = hubs.has("huggingface") ? "huggingface" : hubs.has("modelscope") ? "modelscope" : undefined;
    const result = await this.hostCall(ep, "POST", `/host/v1/starters/${encodeURIComponent(starterId)}/install`, undefined, hub ? this.hubHeader(actor.id, hub) : undefined);
    await this.discover(actor, hostId).catch(() => {});
    return result;
  }

  /**
   * Changes a host's image library: confirm or ignore a proposal, download
   * its missing parts, change it (swap a part within its role and slot, add
   * or remove a LoRA, defaults, rename, create tiers), copy it, or delete it, which keeps
   * every part another recipe uses. A shared host needs an administrator.
   * Confirmed recipes become image offerings at once.
   */
  async recipe(actor: User, hostId: string, recipeId: string, action: { do: "confirm" | "ignore" | "download-parts" | "delete" } | { do: "change"; change: Record<string, unknown> } | { do: "copy"; name: string }): Promise<unknown> {
    const ep = this.manageable(actor, hostId);
    const path = `/host/v1/recipes/${encodeURIComponent(recipeId)}`;
    const result = action.do === "delete" ? await this.hostCall(ep, "DELETE", path)
      : action.do === "change" ? await this.hostCall(ep, "PATCH", path, action.change)
        : action.do === "copy" ? await this.hostCall(ep, "POST", `${path}/copy`, { name: action.name })
          : action.do === "download-parts" ? await this.hostCall(ep, "POST", `${path}/download-parts`, undefined, await this.partsHeader(actor.id, ep, path))
            : await this.hostCall(ep, "POST", `${path}/${action.do}`);
    // A recipe deleted here leaves a tombstone, like a deleted copy, so lists skip it at once.
    const gone = action.do === "delete" ? this.offerings(actor.id, hostId).find((o) => o.modelId === `recipe/${recipeId}`) : undefined;
    if (gone) this.removeOffering(actor, gone.id);
    await this.discover(actor, hostId).catch(() => {});
    return result;
  }

  /**
   * Host management passed through as the host defines it: loading,
   * unloading and pinning models, GPU settings and placements, scanning.
   * Only these paths; a shared host needs an administrator.
   */
  async manageHost(actor: User, hostId: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<unknown> {
    if (!MANAGE.some((re) => re.test(path.split("?")[0]!))) throw new Error(`${path} isn't host management Lyrica passes on`);
    return this.hostCall(this.manageable(actor, hostId), method, path, body);
  }

  /**
   * A host model's placement and serving settings (host/API.md), with the
   * context length it is served with, its maximum, the KV cache at that
   * context, and what the model's card recommends. Anyone who can use the
   * host may read them.
   */
  async servingSettings(userId: string, offeringId: string): Promise<ServingEntry> {
    const { endpoint, offering } = this.hostOffering(userId, offeringId);
    return this.hostCall(endpoint, "GET", `/host/v1/models/settings?${new URLSearchParams({ model: offering.modelId })}`) as Promise<ServingEntry>;
  }

  /**
   * Saves a host model's settings, whole; the host refuses a placement that
   * can't work, with the reason, and a stretch above the one the card
   * documents unless `anyway`. The served context becomes the offering's
   * context window at once. A shared host needs an administrator.
   */
  async setServingSettings(actor: User, offeringId: string, settings: Record<string, unknown>, opts: { anyway?: boolean } = {}): Promise<unknown> {
    const { endpoint, offering } = this.hostOffering(actor.id, offeringId);
    this.manageable(actor, endpoint.id);
    const entry = await this.hostCall(endpoint, "PUT", "/host/v1/models/settings", { model: offering.modelId, settings, ...(opts.anyway ? { anyway: true } : {}) });
    await this.discover(actor, endpoint.id).catch(() => {});
    return entry;
  }

  /**
   * Looks up a host model's recommended settings on its card, through the
   * host's fetch service: from the repository it was downloaded from, the
   * one its GGUF names, or `repo` (owner/name, modelscope:owner/name or a
   * link). Only the repository's name leaves the host, with the user's hub
   * token for that hub. A shared host needs an administrator.
   */
  async lookupRecommended(actor: User, offeringId: string, repo?: string): Promise<ServingEntry> {
    const { endpoint, offering } = this.hostOffering(actor.id, offeringId);
    this.manageable(actor, endpoint.id);
    const hub: Hub = repo && /^(modelscope:|https?:\/\/(www\.)?modelscope\.cn\/)/.test(repo.trim()) ? "modelscope" : "huggingface";
    // The token says which hub it is for, so the host never sends it to the other.
    const token = this.hubHeader(actor.id, hub);
    return this.hostCall(endpoint, "POST", "/host/v1/models/lookup", { model: offering.modelId, ...(repo ? { repo } : {}) },
      token ? { ...token, "x-hub": hub } : undefined, 60_000) as Promise<ServingEntry>;
  }

  /**
   * The hosts a thread's download tools may download to: the ones the user
   * can manage, and none at all for a private or local-only thread, since a
   * download is an outside call.
   */
  downloadHosts(actor: User, ctx: CallContext): { id: string; name: string }[] {
    if (isRestricted(ctx)) return [];
    const admin = !!this.users.get(actor.id)?.admin;
    return this.allowed(ctx)
      .filter(({ endpoint }) => endpoint.api === "host" && (!endpoint.shared || admin))
      .map(({ endpoint }) => ({ id: endpoint.id, name: endpoint.name }));
  }

  /**
   * The host text models a thread's `models` tool may name: on hosts the
   * user can manage, and none at all for a private or local-only thread,
   * since a lookup is an outside call.
   */
  hostCopies(actor: User, ctx: CallContext): { offering: string; name: string; host: string }[] {
    if (isRestricted(ctx)) return [];
    const admin = !!this.users.get(actor.id)?.admin;
    return this.allowed(ctx)
      .filter(({ endpoint }) => endpoint.api === "host" && (!endpoint.shared || admin))
      .flatMap(({ endpoint, offerings }) => offerings
        .filter((o) => o.status === "listed" && !o.recipe && !o.embedding && !o.transcribe && !o.speak && !o.image)
        .map((o) => ({ offering: o.id, name: o.identity?.basename ?? o.modelId.split("/").pop()!.replace(/\.gguf$/, ""), host: endpoint.name })));
  }

  /**
   * LM Studio models on the user's own network, which a thread's `models`
   * tool may load again with another context: none for a private or
   * local-only thread, like hostCopies.
   */
  localCopies(actor: User, ctx: CallContext): { offering: string; name: string; host: string }[] {
    if (isRestricted(ctx)) return [];
    const admin = !!this.users.get(actor.id)?.admin;
    return this.allowed(ctx)
      .filter(({ endpoint }) => endpoint.kind === "local" && endpoint.api !== "host" && !isPlan(endpoint.api) && (!endpoint.shared || admin))
      .flatMap(({ endpoint, offerings }) => offerings
        .filter((o) => o.status === "listed" && o.lmStudio && !o.embedding && !o.transcribe && !o.speak && !o.image)
        .map((o) => ({ offering: o.id, name: o.modelId, host: endpoint.name })));
  }

  /** An LM Studio model's loaded context and its maximum; null when its server isn't LM Studio. */
  async localContext(userId: string, offeringId: string): Promise<{ served?: number; max?: number } | null> {
    const o = this.offering(userId, offeringId);
    if (!o || o.endpoint.kind !== "local" || o.endpoint.api === "host" || isPlan(o.endpoint.api)) return null;
    const lm = await lmStudioModels(o.endpoint.baseUrl, o.endpoint.apiKey);
    const m = lm && lmStudioModel(lm, o.offering.modelId);
    return m ? { ...(m.instances[0]?.context ? { served: m.instances[0].context } : {}), ...(m.maxContext ? { max: m.maxContext } : {}) } : null;
  }

  /**
   * Reads again what LM Studio says of a model before a request: the context
   * it is loaded with, whether it has vision, and how it thinks. Each is kept
   * when it changed, so a load made in LM Studio itself is planned by from the
   * next request, and a model stored before discovery read vision or thinking
   * sees and thinks from then on. An unloaded model keeps its context. Nothing happens for other
   * servers, or when LM Studio doesn't answer within `timeoutMs`.
   */
  async refreshServed(userId: string, offeringId: string, timeoutMs = 1500): Promise<void> {
    const o = this.offering(userId, offeringId);
    if (!o?.offering.lmStudio) return;
    const lm = await lmStudioModels(o.endpoint.baseUrl, o.endpoint.apiKey, timeoutMs);
    const m = lm && lmStudioModel(lm, o.offering.modelId);
    if (!m) return;
    const served = m.instances[0]?.context;
    const parallel = m.instances[0]?.parallel;
    const update = (db: Db) => {
      const row = db.prepare("SELECT found FROM offerings WHERE id = ?").get(offeringId) as { found: string } | undefined;
      const found = row && JSON.parse(row.found) as DiscoveredModel;
      if (!found) return;
      const next: DiscoveredModel = { ...found, ...(served ? { servedContext: served } : {}), ...(parallel ? { servedParallel: parallel } : {}), ...(m.vision !== undefined ? { vision: m.vision } : {}) };
      if (m.reasoning) {
        next.reasoning = m.reasoning.levels;
        if (m.reasoning.canTurnOff) delete next.alwaysThinks;
        else next.alwaysThinks = true;
      }
      if (next.servedContext !== found.servedContext || next.servedParallel !== found.servedParallel || next.vision !== found.vision || String(next.reasoning) !== String(found.reasoning) || next.alwaysThinks !== found.alwaysThinks) db.prepare("UPDATE offerings SET found = ? WHERE id = ?").run(JSON.stringify(next), offeringId);
    };
    if (o.endpoint.shared) update(this.self());
    else this.withUser(userId, update);
  }

  /** Local endpoints read again since this daemon started (`rereadLocal`). */
  private reread = new Set<string>();

  /**
   * Reads the user's local endpoints again, once per daemon run, so what
   * discovery has learned to read since an offering was stored reaches it.
   * A shared endpoint is read as an administrator. Cloud and plan endpoints
   * aren't: their lists are long and rate limited. A server that doesn't
   * answer is tried again at the next user's unlock.
   */
  async rereadLocal(actor: User): Promise<void> {
    const admin = this.users.all().find((u) => u.admin);
    for (const ep of this.endpoints(actor.id)) {
      if (ep.kind !== "local" || isPlan(ep.api) || this.reread.has(ep.id)) continue;
      const as = ep.shared ? admin : actor;
      if (!as) continue;
      this.reread.add(ep.id);
      await this.discover(as, ep.id).catch(() => this.reread.delete(ep.id));
    }
  }

  /** When each endpoint's list was last read this run, by discovery or `rereadDaily`. */
  private readonly readAt = new Map<string, number>();
  private readingDaily?: Promise<void>;

  /**
   * Reads again, one at a time, every endpoint whose list hasn't been read
   * for a day, for each unlocked user with Read model lists daily on: their
   * own endpoints, and the shared ones when they are an administrator. Only
   * the list is read, never a model: one no longer listed is marked missing,
   * as by Refresh, and goes to Clean up when it's gone. Paused and signed-out
   * endpoints wait. One that doesn't answer is tried again a day later.
   */
  rereadDaily(now = Date.now()): Promise<void> {
    this.readingDaily ??= (async () => {
      for (const u of this.users.all()) {
        if (!this.keyring.hasUserKey(u.id) || !this.readDaily(u.id)) continue;
        for (const ep of this.endpoints(u.id)) {
          if (ep.pausedAt || ep.signedOut || (ep.shared && !u.admin) || now - (this.readAt.get(ep.id) ?? 0) < DAY) continue;
          this.readAt.set(ep.id, now);
          await this.discover(u, ep.id).catch(() => {});
        }
      }
    })().finally(() => { this.readingDaily = undefined; });
    return this.readingDaily;
  }

  /**
   * Loads an LM Studio model again with another context, for everyone using
   * it, then reads the endpoint again so the offering plans by it. A shared
   * endpoint needs an administrator; LM Studio's own refusal is the error.
   */
  async loadLocalContext(actor: User, offeringId: string, contextLength: number): Promise<void> {
    const o = this.offering(actor.id, offeringId);
    if (!o || o.endpoint.kind !== "local" || o.endpoint.api === "host" || isPlan(o.endpoint.api)) throw new NoModel(`no model ${offeringId} on LM Studio`);
    if (o.endpoint.shared && !this.users.get(actor.id)?.admin) throw new Forbidden("only an administrator can reload a model on a shared endpoint");
    const lm = await lmStudioModels(o.endpoint.baseUrl, o.endpoint.apiKey);
    const m = lm && lmStudioModel(lm, o.offering.modelId);
    if (!m) throw new Error(`${o.endpoint.name} isn't LM Studio, so its context can't be changed from here`);
    await lmStudioLoad(o.endpoint.baseUrl, o.endpoint.apiKey, m, contextLength);
    await this.discover(actor, o.endpoint.id).catch(() => {});
  }

  /** Applies a host model's saved settings now (Reload now). A shared host needs an administrator. */
  async reloadModel(actor: User, offeringId: string): Promise<unknown> {
    const { endpoint, offering } = this.hostOffering(actor.id, offeringId);
    this.manageable(actor, endpoint.id);
    return this.hostCall(endpoint, "POST", "/host/v1/models/reload", { model: offering.modelId });
  }

  private hostOffering(userId: string, offeringId: string): { endpoint: Endpoint; offering: Offering } {
    const o = this.offering(userId, offeringId);
    if (!o || o.endpoint.api !== "host") throw new NoModel(`no model ${offeringId} on a model host`);
    if (o.offering.recipe) throw new Error("an image recipe has no serving settings");
    return o;
  }

  /** A host's dashboard (a shared host's only for an administrator), opened directly (it has its own password away from the machine), at the address it last answered on. */
  hostDashboard(actor: User, hostId: string): string {
    const origins = (this.manageable(actor, hostId).addresses ?? []).map(hostOrigin);
    const last = this.reached.get(hostId);
    return `${last && origins.includes(last) ? last : origins[0]}/`;
  }

  /** A host the actor may manage: any they can see, but a shared one only as an administrator. */
  private manageable(actor: User, hostId: string): Endpoint {
    const ep = this.needHost(actor.id, hostId);
    if (ep.shared && !this.users.get(actor.id)?.admin) throw new Forbidden("only an administrator can manage a shared model host");
    return ep;
  }

  /** The token for a recipe's missing parts: the hub they come from (Hugging Face when they come from both). */
  private async partsHeader(userId: string, ep: Endpoint, path: string): Promise<Record<string, string> | undefined> {
    const r = (await this.hostCall(ep, "GET", path)) as { parts?: { missing?: { source?: string } | null }[] };
    const hubs = new Set((r.parts ?? []).map((p) => p.missing?.source).filter((h): h is Hub => h === "huggingface" || h === "modelscope"));
    const hub = hubs.has("huggingface") ? "huggingface" : hubs.has("modelscope") ? "modelscope" : undefined;
    return hub ? this.hubHeader(userId, hub) : undefined;
  }

  private hubHeader(userId: string, hub: string): Record<string, string> | undefined {
    const token = this.tokenFor(userId, hub);
    return token ? { "x-hub-token": token } : undefined;
  }

  // --- Sampling ---

  /**
   * An offering's settings for one user, with where each comes from: the
   * shared offering's values (self.db), then the user's own (user.db), which
   * win. Unset values are absent and never sent. Also its context window and
   * where that comes from.
   */
  offeringSettings(userId: string, offeringId: string): {
    values: AnswerSettings; sources: Partial<Record<keyof AnswerSettings, SettingSource>>;
    /** Saved values this endpoint's API doesn't take, so they aren't sent. */
    dropped: (keyof AnswerSettings)[];
    /** The sampling the model reports as its own, which applies where nothing is set; absent where it reports none. */
    defaults: ModelDefaults;
    /** "assumed" when nothing says how long the window is (DEFAULT_CONTEXT). */
    contextWindow: { value: number; source: "host" | "hand" | "discovered" | "assumed" };
  } {
    const o = this.offering(userId, offeringId);
    if (!o) throw new NoModel(`no model ${offeringId}`);
    const read = (db: Db) => {
      const row = db.prepare("SELECT settings FROM offering_settings WHERE offering = ?").get(offeringId) as { settings: string } | undefined;
      return row ? (JSON.parse(row.settings) as AnswerSettings) : {};
    };
    const shared = o.endpoint.shared ? read(this.self()) : {};
    const yours = this.withUser(userId, read);
    const values: AnswerSettings = { ...shared, ...yours };
    // A voice is chosen per language: yours for one language leaves the shared one for another.
    if (shared.voices && yours.voices) values.voices = { ...shared.voices, ...yours.voices };
    const sources = Object.fromEntries(ANSWER_SETTINGS.filter((k) => values[k] !== undefined).map((k) => [k, k in yours ? "yours" : "shared"]));
    const db = o.endpoint.shared ? this.self() : undefined;
    const raw = (db ? db.prepare("SELECT found, hand FROM offerings WHERE id = ?").get(offeringId)
      : this.withUser(userId, (u) => u.prepare("SELECT found, hand FROM offerings WHERE id = ?").get(offeringId))) as { found: string; hand: string };
    const hand = JSON.parse(raw.hand).contextWindow as number | undefined;
    const found = JSON.parse(raw.found).contextWindow as number | undefined;
    const served = JSON.parse(raw.found).servedContext as number | undefined;
    const accepted = acceptedSettings(o.endpoint);
    return {
      values, sources, dropped: ANSWER_SETTINGS.filter((k) => values[k] !== undefined && !accepted.includes(k)),
      defaults: (JSON.parse(raw.found).defaults as ModelDefaults | undefined) ?? {},
      contextWindow: served ? { value: served, source: "host" } : hand ? { value: hand, source: "hand" } : found ? { value: found, source: "discovered" } : { value: DEFAULT_CONTEXT, source: "assumed" },
    };
  }

  /**
   * Saves settings for an offering. `shared` sets a shared offering's values
   * for everyone (administrators only); `mine` sets the user's own: for their
   * offering, or over a shared one's for them alone. null clears a value.
   */
  setOfferingSettings(actor: User, offeringId: string, change: Record<string, unknown>, scope: "shared" | "mine" = "mine"): void {
    const o = this.offering(actor.id, offeringId);
    if (!o) throw new NoModel(`no model ${offeringId}`);
    const checked = checkSettings(change);
    if (scope === "shared" && !o.endpoint.shared) throw new Error("only a shared model has shared settings");
    if (scope === "shared" && !this.users.get(actor.id)?.admin) throw new Forbidden("only an administrator can change a shared model's settings");
    const apply = (db: Db) => {
      const row = db.prepare("SELECT settings FROM offering_settings WHERE offering = ?").get(offeringId) as { settings: string } | undefined;
      const next: Record<string, unknown> = row ? JSON.parse(row.settings) : {};
      for (const [k, v] of Object.entries(checked)) if (v === null) delete next[k]; else next[k] = v;
      if (Object.keys(next).length) db.prepare("INSERT OR REPLACE INTO offering_settings (offering, settings) VALUES (?, ?)").run(offeringId, JSON.stringify(next));
      else db.prepare("DELETE FROM offering_settings WHERE offering = ?").run(offeringId);
    };
    if (scope === "shared") apply(this.self()); else this.withUser(actor.id, apply);
  }

  // --- Model hosts ---

  /**
   * Pairs a model host (host/PAIRING.md) from its addresses and the code its
   * dashboard shows, and pins its key. Hosts are always local. A shared host
   * needs an administrator; a personal one is visible to its user only.
   * With `endpointId`, pairs an existing host again (its key changed),
   * keeping every ID.
   */
  async pairHost(actor: User, input: { name: string; addresses: string[]; code: string }, opts: { shared?: boolean; endpointId?: string } = {}): Promise<Endpoint> {
    checkName(input.name);
    const addresses = checkAddresses(input.addresses);
    const existing = opts.endpointId ? this.endpoint(actor.id, opts.endpointId) : undefined;
    if (opts.endpointId && existing?.api !== "host") throw new Error(`no model host ${opts.endpointId}`);
    const shared = existing ? existing.shared : !!opts.shared;
    if (shared && !this.users.get(actor.id)?.admin) throw new Forbidden("only an administrator can pair a shared model host");
    // Before pairing, so a taken name doesn't use up the code and leave the host pinned while Lyrica pins nothing.
    if (!existing && this.endpoints(actor.id).some((e) => e.name === input.name && e.shared === shared)) throw new Error(`endpoint ${input.name} already exists`);
    const name = selfName(this.self());
    const paired = await pair(lyricaIdentity(this.self(), name), addresses, input.code, `${name} (${input.name})`);
    const baseUrl = `${hostOrigin(addresses[0]!)}/v1`;
    const id = existing?.id ?? randomUUID();
    this.place(actor, shared, (db) => {
      if (existing) {
        db.prepare("UPDATE endpoints SET addresses = ?, pin = ?, base_url = ?, down_since = NULL WHERE id = ?").run(JSON.stringify(addresses), paired.fingerprint, baseUrl, id);
        return;
      }
      if (db.prepare("SELECT 1 FROM endpoints WHERE name = ?").get(input.name)) throw new Error(`endpoint ${input.name} already exists`);
      db.prepare("INSERT INTO endpoints (id, name, kind, api, base_url, api_key, created_at, addresses, pin) VALUES (?, ?, 'local', 'host', ?, NULL, ?, ?, ?)")
        .run(id, input.name, baseUrl, new Date().toISOString(), JSON.stringify(addresses), paired.fingerprint);
    });
    this.health.delete(id);
    this.unpaired.delete(id);
    return this.endpoint(actor.id, id)!;
  }

  /** Changes a host's addresses. Trust stays with its key, and its IDs stay as they are. */
  setHostAddresses(actor: User, id: string, addresses: string[]): Endpoint {
    const list = checkAddresses(addresses);
    this.write(actor, id, (db) => {
      if ((db.prepare("SELECT api FROM endpoints WHERE id = ?").get(id) as { api: string }).api !== "host") throw new Error("only a model host has addresses");
      db.prepare("UPDATE endpoints SET addresses = ?, base_url = ? WHERE id = ?").run(JSON.stringify(list), `${hostOrigin(list[0]!)}/v1`, id);
    });
    this.health.delete(id);
    return this.endpoint(actor.id, id)!;
  }

  /** The fetch that reaches a host over mutual TLS with its pinned key; undefined for a plain endpoint. */
  fetchFor(ep: Endpoint): typeof fetch | undefined {
    if (ep.api !== "host") return undefined;
    const key = `${ep.id}\u0000${ep.fingerprint}\u0000${(ep.addresses ?? []).join(",")}`;
    let f = this.fetches.get(key);
    if (!f) {
      f = hostFetch(lyricaIdentity(this.self(), selfName(this.self())), { addresses: ep.addresses ?? [], pin: ep.fingerprint ?? "" }, (_, code) => {
        this.reportDown(ep.id);
        if (code === "unpaired") this.unpaired.add(ep.id);
      }, (origin) => this.reached.set(ep.id, origin));
      this.fetches.set(key, f);
    }
    return f;
  }

  /** A host's status (host/API.md): GPUs, roles, loaded and pinned models, VRAM, queue. Anyone who can use the host may read it. */
  async hostStatus(userId: string, id: string): Promise<unknown> {
    return this.hostCall(this.needHost(userId, id), "GET", "/host/v1/status");
  }

  /**
   * An endpoint's state for the Models page, within a budget: one the router
   * saw down in the last HEALTH_MS isn't asked again, and nothing waits more
   * than `budgetMs`, so a host that's off doesn't hold the page. A cloud
   * endpoint whose provider would be probed is asked at most every
   * CLOUD_PAGE_PROBE_MS — its last answer stands in between — so the shell's
   * 30 s poll of this page doesn't spend a real request on it more often;
   * local endpoints and plans (which answer from their sign-in, no request)
   * keep HEALTH_MS.
   */
  async pageStatus(userId: string, endpointId: string, budgetMs = 3000): Promise<{ state: "up" | "down"; warning?: string; status?: unknown; error?: string; unpaired?: true }> {
    const ep = this.endpoint(userId, endpointId);
    if (!ep) throw new Error(`no endpoint ${endpointId}`);
    const unpaired = () => (this.unpaired.has(ep.id) ? { unpaired: true as const } : {});
    const h = this.health.get(ep.id);
    if (h && !h.up && Date.now() - h.at < HEALTH_MS) {
      const status = this.awayStatus.get(ep.id);
      return status ? { state: "down", status } : { state: "down", error: `${ep.name} is down`, ...unpaired() };
    }
    // A cloud endpoint that would be probed over the network keeps its last answer, up or down, for CLOUD_PAGE_PROBE_MS.
    if (h && ep.kind === "cloud" && !isPlan(ep.api) && Date.now() - h.at < CLOUD_PAGE_PROBE_MS) {
      return h.up ? { state: "up", ...unpaired() } : { state: "down", error: `${ep.name} is down`, ...unpaired() };
    }
    const warning = ep.kind === "local" ? Promise.race([localWarning(ep), new Promise<undefined>((r) => setTimeout(() => r(undefined), budgetMs).unref())]) : undefined;
    if (ep.api !== "host") {
      const state = await this.answers(ep, budgetMs);
      this.seen(ep, state === "up", userId);
      const w = await warning;
      return w ? { state, warning: w } : { state };
    }
    try {
      const status = await this.hostCall(ep, "GET", "/host/v1/status", undefined, undefined, budgetMs);
      this.unpaired.delete(ep.id);
      // Updating counts as down: it pauses and restarts on its way.
      const state = (status as { state?: string }).state === "running" && !updating(status) ? "up" : "down";
      if (state === "up") this.awayStatus.delete(ep.id); else this.awayStatus.set(ep.id, status);
      this.seen(ep, state === "up", userId);
      const w = await warning;
      return { state, status, ...(w ? { warning: w } : {}) };
    } catch (e) {
      this.seen(ep, false, userId);
      // A host restarts while it updates: the page keeps showing the update.
      const prior = this.awayStatus.get(ep.id);
      if (prior && updating(prior)) return { state: "down", status: prior };
      this.awayStatus.delete(ep.id);
      return { state: "down", error: (e as Error).message, ...unpaired() };
    }
  }

  /** Pauses, resumes or restarts a host, and answers its whole status after. A shared host needs an administrator. */
  async hostControl(actor: User, id: string, action: "pause" | "resume" | "restart"): Promise<unknown> {
    const ep = this.needHost(actor.id, id);
    if (ep.shared && !this.users.get(actor.id)?.admin) throw new Forbidden("only an administrator can manage a shared model host");
    if (!["pause", "resume", "restart"].includes(action)) throw new Error("a host can be paused, resumed or restarted");
    await this.hostCall(ep, "POST", `/host/v1/${action}`);
    // The host answers only its state; the page needs its GPUs and models too.
    const status = await this.hostCall(ep, "GET", "/host/v1/status");
    if ((status as { state?: string }).state === "running") {
      this.awayStatus.delete(ep.id);
      this.health.delete(ep.id);
    } else {
      this.awayStatus.set(ep.id, status);
      this.reportDown(ep.id);
    }
    return status;
  }

  /**
   * Asks a model host to update itself to a release, Lyrica's own running one
   * (host/README.md, "Updates"). The host's updater checks the tag again; the
   * host pauses while it updates and reports its progress in its status.
   */
  async hostUpdate(actor: User, id: string, tag: string): Promise<unknown> {
    const ep = this.needHost(actor.id, id);
    if (ep.shared && !this.users.get(actor.id)?.admin) throw new Forbidden("only an administrator can manage a shared model host");
    if (!/^update\/[A-Za-z0-9._-]{1,64}$/.test(tag)) throw new Error("a host updates to an update/… tag");
    await this.hostCall(ep, "POST", "/host/v1/update", { tag });
    const status = await this.hostCall(ep, "GET", "/host/v1/status");
    // It pauses and restarts as it updates: chats go elsewhere meanwhile.
    this.awayStatus.set(ep.id, status);
    this.reportDown(ep.id);
    return status;
  }

  /**
   * Asks a model host to move to another models folder, a path on the host
   * machine (host/README.md, "The models folder"). The host's updater checks
   * the folder as root, pauses the host and restarts it on the new folder.
   */
  async hostModelsFolder(actor: User, id: string, path: string): Promise<unknown> {
    const ep = this.needHost(actor.id, id);
    if (ep.shared && !this.users.get(actor.id)?.admin) throw new Forbidden("only an administrator can manage a shared model host");
    if (!path.startsWith("/")) throw new Error("the models folder is an absolute path on the host machine");
    await this.hostCall(ep, "POST", "/host/v1/models-folder", { path });
    const status = await this.hostCall(ep, "GET", "/host/v1/status");
    // It pauses and restarts as it moves: chats go elsewhere meanwhile.
    this.awayStatus.set(ep.id, status);
    this.reportDown(ep.id);
    return status;
  }

  private needHost(userId: string, id: string): Endpoint {
    const ep = this.endpoint(userId, id);
    if (!ep || ep.api !== "host") throw new NoModel(`no model host ${id}`);
    return ep;
  }

  /** One call to a host's API, with its error as a plain reason. */
  private async hostCall(ep: Endpoint, method: string, path: string, body?: unknown, headers?: Record<string, string>, timeoutMs = 30_000): Promise<unknown> {
    const res = await this.fetchFor(ep)!(`${hostOrigin(ep.addresses![0]!)}${path}`, {
      method, signal: AbortSignal.timeout(timeoutMs),
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).catch((e: Error) => {
      // A host that can't be reached, or doesn't answer in time, is a plain reason, not an internal error.
      throw new HostRefused("unreachable", `${ep.name} can't be reached${e.name === "TimeoutError" ? " (it didn't answer in time)" : ""}.`);
    });
    const err = await hostError(res);
    if (err) throw new HostRefused(err.code, err.message);
    if (!res.ok) throw new HostRefused("error", `${ep.name} answered ${res.status}`);
    return res.json();
  }

  /** Up when the host answers its status and is running; paused, pausing and restarting count as down. */
  private async hostUp(ep: Endpoint, timeoutMs = 5000): Promise<"up" | "down"> {
    try {
      const res = await this.fetchFor(ep)!(`${hostOrigin(ep.addresses![0]!)}/host/v1/status`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return "down";
      return ((await res.json()) as { state?: string }).state === "running" ? "up" : "down";
    } catch {
      return "down";
    }
  }

  /** A host's text models, from its library (host/API.md "Models"). */
  private async hostModels(ep: Endpoint): Promise<DiscoveredModel[]> {
    const list = listIn<{
      id: string; kind?: string; sha256?: string | null; contextLength?: number | null; parallel?: number | null; size?: number; downloaded?: boolean; identity?: ModelIdentity | null; sampling?: Record<string, unknown> | null;
      capabilities?: { tools?: boolean; vision?: boolean; embedding?: boolean; reasoning?: string[] | null; opensThinking?: boolean; transcribe?: boolean; speak?: { voices?: unknown } | null };
    }>(await this.hostCall(ep, "GET", "/host/v1/models"), "models");
    if (!list) throw new Error(`${ep.name} didn't return a model list`);
    // Image and video models are recipes: only confirmed ones become offerings, so a proposal never resolves.
    // A recipe that does nothing Lyrica can ask for isn't one, so it never shows as a chat model.
    const recipes = (listIn<{ id: string; name: string; state: string; does?: string[]; useFor?: Offering["useFor"]; mask?: boolean }>(await this.hostCall(ep, "GET", "/host/v1/recipes?state=confirmed").catch(() => []), "recipes") ?? [])
      .filter((r) => r?.state === "confirmed" && r.does?.some((a) => RECIPE_ACTIONS.includes(a))).map((r) => ({
        modelId: `recipe/${r.id}`, recipe: r.name, useFor: r.useFor ?? "both", ...(r.does?.includes("create") ? { image: true } : {}), ...(r.does?.includes("edit") ? { edit: true, ...(typeof r.mask === "boolean" ? { mask: r.mask } : {}) } : {}), ...(r.does?.includes("upscale") ? { upscale: true } : {}),
        ...(r.does?.includes("video") ? { video: true } : {}), ...(r.does?.includes("animate") ? { animate: true } : {}),
        ...(r.does?.includes("motion") ? { motion: true } : {}),
      } as DiscoveredModel));
    return [...list.filter((m) => typeof m?.id === "string" && m.kind !== "image").map((m) => {
      const levels = (m.capabilities?.reasoning ?? []).filter((l) => l !== "off");
      // A thinking switch in the chat template is on or off: one level.
      const reasoning = levels.filter((l): l is "low" | "medium" | "high" => ["low", "medium", "high"].includes(l));
      return {
        modelId: m.id,
        ...(m.contextLength ? { servedContext: m.contextLength } : {}),
        ...(m.parallel ? { servedParallel: m.parallel } : {}),
        ...(m.capabilities?.tools !== undefined ? { tools: !!m.capabilities.tools } : {}),
        ...(m.capabilities?.vision !== undefined ? { vision: !!m.capabilities.vision } : {}),
        ...(m.capabilities?.embedding || m.kind === "embedding" ? { embedding: true } : {}),
        ...(m.capabilities?.transcribe || m.kind === "transcribe" ? { transcribe: true } : {}),
        ...(m.capabilities?.speak ? { speak: { voices: hostVoices(m.capabilities.speak.voices) } } : {}),
        ...(levels.length ? { reasoning: reasoning.length ? reasoning : ["medium"] as "medium"[] } : {}),
        ...(m.capabilities?.opensThinking ? { opensThinking: true } : {}),
        ...(m.sha256 ? { digest: m.sha256 } : {}),
        ...(m.identity ? { identity: m.identity } : {}),
        ...(m.downloaded !== undefined ? { downloaded: !!m.downloaded } : {}),
        ...(m.size ? { size: m.size } : {}),
        ...(m.sampling ? { defaults: modelDefaults((k) => m.sampling![k]) } : {}),
      } as DiscoveredModel;
    }), ...recipes];
  }

  /**
   * A plan answered that its usage limit is reached, until it resets
   * (`until`, or an hour). The router still picks it for every task: a model
   * set to a plan is set so for a reason, so its callers wait for the reset
   * rather than falling back, unless the user chooses to (`fallBackFromLimit`).
   * True when it wasn't already known, so the owner is told once.
   */
  reportPlanLimit(endpointId: string, until?: number): boolean {
    const known = this.planLimitedUntil(endpointId) !== undefined;
    if (!known) this.fallingBack.delete(endpointId);
    const now = Date.now();
    if (until && until > now) {
      this.guessed.delete(endpointId);
      this.limited.set(endpointId, until);
      return !known;
    }
    // No reset given: still limited right after the last guess ran out waits twice as long, so waiting threads don't retry every hour.
    const last = this.guessed.get(endpointId);
    const ms = known ? last?.ms ?? PLAN_LIMIT_MS
      : last && now - last.until < PLAN_LIMIT_AGAIN_MS ? Math.min(PLAN_LIMIT_MAX_MS, last.ms * 2) : PLAN_LIMIT_MS;
    const at = known ? this.limited.get(endpointId)! : now + ms;
    this.guessed.set(endpointId, { ms, until: at });
    this.limited.set(endpointId, at);
    return !known;
  }

  /**
   * The user chose to fall back from a limited plan: until it resets, the
   * router skips it, as for a machine that is away. False when it isn't
   * limited now.
   */
  fallBackFromLimit(endpointId: string): boolean {
    if (this.planLimitedUntil(endpointId) === undefined) return false;
    this.fallingBack.add(endpointId);
    return true;
  }

  /** Whether the router skips a limited plan for the user's choice, until it resets. */
  planFallingBack(endpointId: string): boolean {
    if (this.planLimitedUntil(endpointId) !== undefined) return this.fallingBack.has(endpointId);
    this.fallingBack.delete(endpointId);
    return false;
  }

  /** When a plan that reached its usage limit resets, while it is limited. */
  planLimitedUntil(endpointId: string): number | undefined {
    const until = this.limited.get(endpointId);
    return until !== undefined && until > Date.now() ? until : undefined;
  }

  /** A call to the endpoint failed to connect or was refused as away: the router skips it for HEALTH_MS. */
  reportDown(endpointId: string): void {
    this.health.set(endpointId, { up: false, at: Date.now() });
  }

  /** Other offerings of the same model, by name, on endpoints of the same kind: suggested fallbacks and replacements. */
  sameModel(userId: string, offeringId: string): { offeringId: string }[] {
    const c = this.catalog(userId);
    const o = c.offerings.get(offeringId);
    if (!o) return [];
    const kind = c.endpoints.get(o.endpointId)!.kind;
    const name = baseName(o.modelId);
    return [...c.offerings.values()]
      .filter((x) => x.id !== o.id && x.endpointId !== o.endpointId && x.status !== "gone" && c.endpoints.get(x.endpointId)!.kind === kind && !c.endpoints.get(x.endpointId)!.stale && baseName(x.modelId) === name)
      .map((x) => ({ offeringId: x.id }));
  }

  // --- Groups ---

  /** The user's own groups, then the shared ones. */
  groups(userId: string): Group[] {
    return [...this.catalog(userId).groups.values()];
  }

  group(userId: string, id: string): Group | undefined {
    return this.catalog(userId).groups.get(id);
  }

  /**
   * Declares offerings from different endpoints the same model, in order.
   * A shared group (administrators only) takes shared offerings only.
   */
  addGroup(actor: User, input: { name: string; members: string[] }, opts: { shared?: boolean } = {}): Group {
    const members = this.checkMembers(actor.id, input.members, !!opts.shared);
    const name = checkGroupName(input.name);
    const id = randomUUID();
    this.place(actor, !!opts.shared, (db) => {
      db.prepare("INSERT INTO model_groups (id, name, members, created_at) VALUES (?, ?, ?, ?)").run(id, name, JSON.stringify(members), new Date().toISOString());
    });
    if (!opts.shared) this.withUser(actor.id, (db) => this.index(actor.id, db));
    return this.group(actor.id, id)!;
  }

  /** Renames a group, or reorders, adds or removes its members. */
  editGroup(actor: User, id: string, change: { name?: string; members?: string[] }): Group {
    const g = this.group(actor.id, id);
    if (!g) throw new NoModel(`no group ${id}`);
    const members = change.members && this.checkMembers(actor.id, change.members, g.shared);
    const name = change.name === undefined ? g.name : checkGroupName(change.name);
    this.place(actor, g.shared, (db) => {
      db.prepare("UPDATE model_groups SET name = ?, members = ? WHERE id = ?").run(name, JSON.stringify(members ?? g.members), id);
    });
    if (!g.shared) this.withUser(actor.id, (db) => this.index(actor.id, db));
    return this.group(actor.id, id)!;
  }

  /** Undoes a group. Lists that named it drop it, through a tombstone like a removed model. */
  removeGroup(actor: User, id: string): void {
    const g = this.group(actor.id, id);
    if (!g) throw new NoModel(`no group ${id}`);
    this.retire(actor, g.shared, () => [[id, null]], (db) => { db.prepare("DELETE FROM model_groups WHERE id = ?").run(id); });
  }

  /**
   * A group's members side by side, with warnings where they differ in a way
   * that matters: kind, context window, tools, vision, thinking, or a member
   * that is missing, gone or on a stale endpoint.
   */
  groupDetail(userId: string, id: string): { group: Group; members: (Offering & { label: string; kind: "cloud" | "local"; stale: boolean })[]; warnings: string[] } {
    const c = this.catalog(userId);
    const group = c.groups.get(id);
    if (!group) throw new NoModel(`no group ${id}`);
    const members = group.members.flatMap((m) => {
      const o = c.offerings.get(m);
      if (!o) return [];
      const ep = c.endpoints.get(o.endpointId)!;
      return [{ ...o, label: labelOf(ep, o), kind: ep.kind, stale: ep.stale }];
    });
    const warnings: string[] = [];
    const differ = (what: string, f: (m: (typeof members)[number]) => unknown) => {
      if (new Set(members.map((m) => JSON.stringify(f(m) ?? null))).size > 1) warnings.push(`Its copies differ in ${what}.`);
    };
    if (new Set(members.map((m) => m.kind)).size > 1) warnings.push("It mixes local and cloud copies, so as a whole it can only be used in a general preset or a Custom column; elsewhere only the copies of the right kind are used.");
    differ("context window", (m) => m.contextWindow);
    differ("tool support", (m) => m.tools);
    differ("vision", (m) => m.vision);
    differ("thinking", (m) => m.reasoning);
    for (const m of members) {
      if (m.status !== "listed") warnings.push(`${m.label} is ${m.status}.`);
      if (m.stale) warnings.push(`${m.label}'s endpoint hasn't answered for ${STALE_DAYS} days.`);
    }
    if (!members.length) warnings.push("It has no members left.");
    return { group, members, warnings };
  }

  /**
   * Suggested groups, never made automatically: copies on different
   * endpoints of the same kind with the same file checksum (strong) or the
   * same name (weak), not already grouped together.
   */
  groupSuggestions(userId: string): { name: string; members: string[]; strength: "strong" | "weak" }[] {
    const c = this.catalog(userId);
    const live = [...c.offerings.values()].filter((o) => o.status !== "gone" && !c.endpoints.get(o.endpointId)!.stale);
    const out: { name: string; members: string[]; strength: "strong" | "weak" }[] = [];
    const covered = (ids: string[]) => [...c.groups.values()].some((g) => ids.every((id) => g.members.includes(id)));
    const bucket = (key: (o: Offering) => string | undefined, strength: "strong" | "weak") => {
      const by = new Map<string, Offering[]>();
      for (const o of live) {
        const k = key(o);
        if (!k) continue;
        const b = `${c.endpoints.get(o.endpointId)!.kind}\u0000${k}`;
        by.set(b, [...(by.get(b) ?? []), o]);
      }
      for (const list of by.values()) {
        // One copy per endpoint: the first.
        const one = list.filter((o, i) => list.findIndex((x) => x.endpointId === o.endpointId) === i);
        const ids = one.map((o) => o.id);
        if (one.length > 1 && !covered(ids) && !out.some((s) => ids.every((id) => s.members.includes(id)))) out.push({ name: baseName(one[0]!.modelId), members: ids, strength });
      }
    };
    bucket((o) => o.digest, "strong");
    // Same entry in the library, never a flagged or separated copy: a finetune is never suggested for its base's group.
    bucket((o) => { const id = copyIdentity(o); return id.flagged || id.key.startsWith("copy:") ? undefined : id.key; }, "weak");
    return out;
  }

  // --- Clean up, redirects and tombstones ---

  /**
   * Stale endpoints, gone models and empty groups this user can see, with
   * where their own lists (and shared groups) use them and how many other
   * users' lists do.
   */
  cleanup(userId: string): CleanupItem[] {
    const c = this.catalog(userId);
    const uses = this.uses(userId);
    for (const [id, list] of collectRefs(this.self())) uses.set(id, [...(uses.get(id) ?? []), ...list]);
    const others = (ids: string[]) => {
      const shared = ids.filter((id) => c.endpoints.get(c.offerings.get(id)?.endpointId ?? "")?.shared || c.groups.get(id)?.shared);
      if (!shared.length) return 0;
      return (this.self().prepare(`SELECT count(DISTINCT user) AS n FROM shared_refs WHERE user != ? AND ref IN (${shared.map(() => "?").join(",")})`)
        .get(userId, ...shared) as { n: number }).n;
    };
    const items: CleanupItem[] = [];
    for (const endpoint of c.endpoints.values()) {
      if (!endpoint.stale) continue;
      const ids = [...c.offerings.values()].filter((o) => o.endpointId === endpoint.id).map((o) => o.id);
      items.push({ endpoint, label: endpoint.shared ? SHARED + endpoint.name : endpoint.name, usedIn: ids.flatMap((id) => uses.get(id) ?? []), otherUsers: others(ids) });
    }
    for (const offering of c.offerings.values()) {
      const endpoint = c.endpoints.get(offering.endpointId)!;
      if (offering.status !== "gone" || endpoint.stale) continue;
      const same = this.sameModel(userId, offering.id)[0];
      items.push({
        endpoint, offering, label: labelOf(endpoint, offering), usedIn: uses.get(offering.id) ?? [], otherUsers: others([offering.id]),
        ...(same ? { suggestion: { offeringId: same.offeringId, label: this.label(userId, same.offeringId)! } } : {}),
      });
    }
    for (const group of c.groups.values()) {
      if (group.members.length) continue;
      items.push({ group, label: this.label(userId, group.id)!, usedIn: uses.get(group.id) ?? [], otherUsers: others([group.id]) });
    }
    return items;
  }

  /**
   * Replaces a model everywhere: it is deleted, and a redirect sends every
   * list and group that named it to the replacement. The replacement must be
   * of the same kind, and for a shared model, shared too.
   */
  replace(actor: User, fromId: string, toId: string): void {
    const from = this.offering(actor.id, fromId);
    const to = this.offering(actor.id, toId);
    if (!from) throw new NoModel(`no model ${fromId}`);
    if (!to) throw new NoModel(`no model ${toId}`);
    if (fromId === toId) throw new Error("a model can't replace itself");
    if (from.endpoint.kind !== to.endpoint.kind) throw new CloudModelForbidden(`a ${from.endpoint.kind} model can only be replaced by another ${from.endpoint.kind} model`);
    if (from.endpoint.shared && !to.endpoint.shared) throw new Error("a shared model can only be replaced by another shared model");
    this.retire(actor, from.endpoint.shared, () => [[fromId, toId]], (db) => { db.prepare("DELETE FROM offerings WHERE id = ?").run(fromId); });
  }

  /** Removes a model. A tombstone makes every list and group that named it drop it. */
  removeOffering(actor: User, offeringId: string): void {
    const o = this.offering(actor.id, offeringId);
    if (!o) throw new NoModel(`no model ${offeringId}`);
    this.retire(actor, o.endpoint.shared, () => [[offeringId, null]], (db) => { db.prepare("DELETE FROM offerings WHERE id = ?").run(offeringId); });
  }

  /** Gives an endpoint and its models fresh IDs, for a server to be treated as new. Redirects keep every list working. */
  resetIds(actor: User, endpointId: string): string {
    const fresh = randomUUID();
    const map = new Map<string, string>();
    this.retire(actor, this.isShared(endpointId), (db) => {
      if (!db.prepare("SELECT 1 FROM endpoints WHERE id = ?").get(endpointId)) throw new Error(`no endpoint ${endpointId}`);
      for (const r of db.prepare("SELECT id FROM offerings WHERE endpoint = ?").all(endpointId) as { id: string }[]) map.set(r.id, randomUUID());
      return [...map];
    }, (db) => {
      db.pragma("defer_foreign_keys = ON");
      db.prepare("UPDATE endpoints SET id = ?, down_since = NULL WHERE id = ?").run(fresh, endpointId);
      const move = db.prepare("UPDATE offerings SET id = ?, endpoint = ? WHERE id = ?");
      for (const [old, id] of map) move.run(id, fresh, old);
    });
    return fresh;
  }

  /**
   * Merges an endpoint into another that turned out to be the same server.
   * A model both list redirects to the one on `into`; the rest move over
   * with their IDs. `from` is then removed.
   */
  merge(actor: User, fromId: string, intoId: string): void {
    const from = this.endpoint(actor.id, fromId);
    const into = this.endpoint(actor.id, intoId);
    if (!from || !into) throw new Error(`no endpoint ${from ? intoId : fromId}`);
    if (fromId === intoId) throw new Error("an endpoint can't be merged into itself");
    if (from.shared !== into.shared) throw new Error("a shared endpoint can only be merged with another shared endpoint");
    if (from.kind !== into.kind) throw new CloudModelForbidden("a cloud endpoint and a local endpoint can't be merged");
    if ((isPlan(from.api) || isPlan(into.api)) && from.api !== into.api) throw new Error("a plan merges only with another plan of the same kind");
    const moved: string[] = [];
    this.retire(actor, from.shared, (db) => {
      const target = new Map((db.prepare("SELECT id, model FROM offerings WHERE endpoint = ?").all(intoId) as { id: string; model: string }[]).map((r) => [r.model, r.id]));
      const pairs: [string, string][] = [];
      for (const r of db.prepare("SELECT id, model FROM offerings WHERE endpoint = ?").all(fromId) as { id: string; model: string }[]) {
        const same = target.get(r.model);
        if (same) pairs.push([r.id, same]); else moved.push(r.id);
      }
      return pairs;
    }, (db) => {
      const move = db.prepare("UPDATE offerings SET endpoint = ? WHERE id = ?");
      for (const id of moved) move.run(intoId, id);
      db.prepare("DELETE FROM endpoints WHERE id = ?").run(fromId);
    });
  }

  /**
   * Housekeeping, run nightly: removes gone models nothing refers to. For a
   * shared model that means no user's lists and no shared group name it,
   * which needs every user to have been indexed; a user's own gone models go
   * while they are unlocked. A shared model gone for SHARED_GONE_DAYS goes
   * even while lists name it, leaving a tombstone that locked users' lists
   * catch up with at their next unlock. Old call records are trimmed too.
   */
  prune(now = Date.now()): void {
    const self = this.self();
    const gone = (db: Db) => (db.prepare("SELECT * FROM offerings WHERE missing_since IS NOT NULL").all() as OfferingRow[]).filter((r) => toOffering(r, now).status === "gone");
    const expired = gone(self).filter((r) => now - Date.parse(r.missing_since!) >= (GONE_DAYS + SHARED_GONE_DAYS) * DAY).map((r) => r.id);
    if (expired.length) this.retireShared(() => expired.map((id) => [id, null]), (db) => { for (const id of expired) db.prepare("DELETE FROM offerings WHERE id = ?").run(id); });
    const allIndexed = this.users.all().every((u) => self.prepare("SELECT 1 FROM shared_refs_indexed WHERE user = ?").get(u.id));
    if (allIndexed) {
      const inGroups = collectRefs(self);
      for (const r of gone(self)) if (!inGroups.has(r.id) && !self.prepare("SELECT 1 FROM shared_refs WHERE ref = ?").get(r.id)) self.prepare("DELETE FROM offerings WHERE id = ?").run(r.id);
    }
    // After the shared models are pruned, so their settings, and users' layers over them, go the same night.
    self.prepare("DELETE FROM offering_settings WHERE offering NOT IN (SELECT id FROM offerings)").run();
    const sharedIds = new Set((self.prepare("SELECT id FROM offerings").all() as { id: string }[]).map((r) => r.id));
    for (const u of this.users.all()) {
      if (!this.keyring.hasUserKey(u.id)) continue;
      this.withUser(u.id, (db) => {
        for (const r of db.prepare("SELECT offering FROM offering_settings WHERE offering NOT IN (SELECT id FROM offerings)").all() as { offering: string }[]) {
          if (!sharedIds.has(r.offering)) db.prepare("DELETE FROM offering_settings WHERE offering = ?").run(r.offering);
        }
        const used = collectRefs(db);
        for (const r of gone(db)) if (!used.has(r.id)) db.prepare("DELETE FROM offerings WHERE id = ?").run(r.id);
        db.transaction(() => {
          const cutoff = (db.prepare("SELECT id FROM model_calls ORDER BY id DESC LIMIT 1 OFFSET ?").get(CALLS_KEPT) as { id: number } | undefined)?.id;
          if (cutoff === undefined) return;
          db.prepare(`INSERT INTO call_totals (pool, thread, label, kind, tokens, input_tokens, output_tokens, gpu_ms, calls)
            SELECT pool, thread, label, kind,
              sum(coalesce(read_tokens, prompt_tokens, 0) + coalesce(output_tokens, 0)), sum(coalesce(read_tokens, prompt_tokens, 0)), sum(coalesce(output_tokens, 0)),
              sum(CASE WHEN kind = 'local' THEN coalesce(ttft_ms, 0) + coalesce(gen_ms, 0) ELSE 0 END), count(*)
            FROM model_calls WHERE id <= ? AND task IN ('chat', 'code') AND (prompt_tokens IS NOT NULL OR read_tokens IS NOT NULL OR output_tokens IS NOT NULL)
            GROUP BY pool, thread, label, kind
            ON CONFLICT (pool, thread, label, kind) DO UPDATE SET
              tokens = tokens + excluded.tokens, input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens,
              gpu_ms = gpu_ms + excluded.gpu_ms, calls = calls + excluded.calls`).run(cutoff);
          db.prepare("DELETE FROM model_calls WHERE id <= ?").run(cutoff);
        })();
      });
    }
  }

  /** The one-time notice about lists rewritten since the user last looked, if any. */
  notice(userId: string): string[] {
    return this.withUser(userId, (db) => {
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(NOTICE) as { value: string } | undefined;
      return row ? JSON.parse(row.value) : [];
    });
  }

  dismissNotice(userId: string): void {
    this.withUser(userId, (db) => db.prepare("DELETE FROM settings WHERE key = ?").run(NOTICE));
  }

  // --- Presets, the two columns, and thread choices ---

  /** Every preset, built-ins first then by name. */
  presets(userId: string): Preset[] {
    return this.withUser(userId, (db) => (db.prepare("SELECT id, name, scope, builtin, entries, updated_at FROM model_presets ORDER BY builtin IS NOT NULL, lower(name)")
      .all() as PresetRow[]).map((r) => this.toPreset(r)));
  }

  preset(userId: string, id: string): Preset | undefined {
    return this.withUser(userId, (db) => this.presetRow(db, id));
  }

  /** One column's state: the preset it follows (or null when Custom), the preset a Custom table came from, and its entries. */
  column(userId: string, column: Column): ColumnState {
    return this.withUser(userId, (db) => {
      const c = this.readColumn(db, column);
      return { column, preset: c.preset, fromPreset: c.fromPreset, entries: c.entries };
    });
  }

  /** Adds a preset from a column's table: private holds local models only. Returns it. */
  addPreset(userId: string, input: { name: string; scope: PresetScope }, from: Column): Preset {
    const name = checkPresetName(input.name);
    if (input.scope !== "private" && input.scope !== "general") throw new Error("a preset is private or general");
    let id = "";
    this.withUser(userId, (db) => {
      db.transaction(() => {
        if (db.prepare("SELECT 1 FROM model_presets WHERE lower(name) = lower(?)").get(name)) throw new Error(`a preset called ${name} already exists`);
        const checked = this.checkedTable(userId, this.readColumn(db, from).entries, input.scope === "private" ? "local" : undefined);
        id = randomUUID();
        db.prepare("INSERT INTO model_presets (id, name, scope, builtin, entries, updated_at) VALUES (?, ?, ?, NULL, ?, ?)")
          .run(id, name, input.scope, JSON.stringify(checked), new Date().toISOString());
        syncLegacy(db);
      })();
      this.index(userId, db);
    });
    return this.preset(userId, id)!;
  }

  /** Renames a user preset. The built-ins keep their names. */
  editPreset(userId: string, id: string, change: { name: string }): Preset {
    const name = checkPresetName(change.name);
    this.withUser(userId, (db) => {
      const r = db.prepare("SELECT id, builtin FROM model_presets WHERE id = ?").get(id) as { id: string; builtin: string | null } | undefined;
      if (!r) throw new NoModel(`no preset ${id}`);
      if (r.builtin) throw new Error("the built-in presets keep their names");
      db.transaction(() => {
        if (db.prepare("SELECT 1 FROM model_presets WHERE lower(name) = lower(?) AND id != ?").get(name, id)) throw new Error(`a preset called ${name} already exists`);
        db.prepare("UPDATE model_presets SET name = ?, updated_at = ? WHERE id = ?").run(name, new Date().toISOString(), id);
        syncLegacy(db);
      })();
      this.index(userId, db);
    });
    return this.preset(userId, id)!;
  }

  /** Save to: writes a column's table into a preset and makes the column follow it. The built-ins' lists can be saved over. */
  savePreset(userId: string, id: string, column: Column): void {
    this.withUser(userId, (db) => {
      db.transaction(() => {
        const r = db.prepare("SELECT id, scope FROM model_presets WHERE id = ?").get(id) as { id: string; scope: PresetScope } | undefined;
        if (!r) throw new NoModel(`no preset ${id}`);
        if (column === "private" && r.scope !== "private") throw new CloudModelForbidden("the Private column can use only private presets");
        const checked = this.checkedTable(userId, this.readColumn(db, column).entries, r.scope === "private" ? "local" : undefined);
        db.prepare("UPDATE model_presets SET entries = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(checked), new Date().toISOString(), id);
        db.prepare("UPDATE model_columns SET preset = ?, from_preset = NULL, entries = '{}' WHERE column = ?").run(id, column);
        syncLegacy(db);
      })();
      this.index(userId, db);
    });
  }

  /**
   * Deletes a user preset. Each column that followed it keeps its lists as
   * Custom, and each thread that chose it follows its column again.
   */
  removePreset(userId: string, id: string): void {
    this.withUser(userId, (db) => {
      db.transaction(() => {
        const r = db.prepare("SELECT id, builtin, entries FROM model_presets WHERE id = ?").get(id) as { id: string; builtin: string | null; entries: string } | undefined;
        if (!r) throw new NoModel(`no preset ${id}`);
        if (r.builtin) throw new Error("the built-in presets stay");
        db.prepare("UPDATE model_columns SET preset = NULL, from_preset = NULL, entries = ? WHERE preset = ?").run(r.entries, id);
        db.prepare("UPDATE thread_choices SET preset = NULL, profile = NULL WHERE preset = ?").run(id);
        db.prepare("DELETE FROM model_presets WHERE id = ?").run(id);
        db.prepare("DELETE FROM settings WHERE key = ? AND value = ?").run(MIXED_PRESET, id);
        syncLegacy(db);
      })();
      this.index(userId, db);
    });
  }

  /** Makes a column follow a preset. The Private column can follow only a private preset. */
  useColumnPreset(userId: string, column: Column, id: string): void {
    this.withUser(userId, (db) => {
      db.transaction(() => {
        const r = db.prepare("SELECT id, scope FROM model_presets WHERE id = ?").get(id) as { id: string; scope: PresetScope } | undefined;
        if (!r) throw new NoModel(`no preset ${id}`);
        if (column === "private" && r.scope !== "private") throw new CloudModelForbidden("the Private column can use only private presets");
        db.prepare("UPDATE model_columns SET preset = ?, from_preset = NULL, entries = '{}' WHERE column = ?").run(id, column);
        syncLegacy(db);
      })();
      this.index(userId, db);
    });
  }

  /**
   * Edits one task in a column's table, first copying the followed preset's
   * table into the column (which becomes Custom, remembering that preset), so
   * a preset never changes by accident. A single model is a one-model list;
   * `same` names a task of the same capability that doesn't itself follow
   * another; with no value the entry is cleared.
   */
  setColumnTask(userId: string, column: Column, task: Task, value?: Entry | ModelRef): void {
    const kind = column === "private" ? "local" : undefined;
    this.withUser(userId, (db) => {
      db.transaction(() => {
        const c = this.readColumn(db, column);
        const current: Profiles = Object.keys(c.entries).length ? c.entries : { ...NEW_PRESET };
        const stored = this.entryFor(userId, current, task, value, kind);
        const next: Profiles = { ...current };
        if (!stored) delete next[task]; else next[task] = stored;
        db.prepare("UPDATE model_columns SET preset = NULL, from_preset = ?, entries = ? WHERE column = ?")
          .run((c.preset ?? c.fromPreset)?.id ?? null, JSON.stringify(next), column);
        syncLegacy(db);
      })();
      this.index(userId, db);
    });
  }

  /** Checks a whole table against a scope: private takes local models only; `{ same }` entries pass as they were checked when written. */
  private checkedTable(userId: string, table: Profiles, kind: "local" | undefined): Profiles {
    const out: Profiles = {};
    for (const [task, e] of Object.entries(table)) {
      if (isList(e)) {
        const list = this.checkList(userId, e, { kind, task: task as Task });
        if (list.length) out[task as Task] = list;
      } else {
        out[task as Task] = e;
      }
    }
    return out;
  }

  /**
   * Checks and normalizes one edit to a table: a list (or one model) for
   * `task`, `{ same }` one level deep, or undefined to clear. `kind` local
   * takes local models only.
   */
  private entryFor(userId: string, current: Profiles, task: Task, value: Entry | ModelRef | undefined, kind: "local" | undefined): Entry | undefined {
    const entry: Entry | undefined = value && !Array.isArray(value) && !("same" in value) ? [value] : value as Entry | undefined;
    let stored: Entry | undefined = entry;
    if (entry && !isList(entry)) {
      const target = checkTask(entry.same);
      if (target === task) throw new Error(`${task} can't follow itself`);
      if (capability(target) !== capability(task)) throw new Error(`${task} can only follow a task that uses the same kind of model`);
      const t = current[target];
      if (t && !isList(t)) throw new Error(`${target} already follows ${t.same}, and Same as goes one level deep`);
      stored = { same: target };
    } else if (entry) {
      stored = this.checkList(userId, entry, { kind, task });
    }
    if (stored && isList(stored) && !stored.length) stored = undefined;
    const followers = Object.entries(current).filter(([, e]) => e && !isList(e) && e.same === task).map(([t]) => t as Task);
    if (stored && !isList(stored) && followers.length) throw new Error(`${followers.join(" and ")} already follow ${task}, and Same as goes one level deep`);
    return stored;
  }

  /** A preset's or a column's stored entries, with the default a table made before later tasks gets on read. */
  private readTable(entries: string | undefined): Profiles {
    const table: Profiles = entries ? JSON.parse(entries) as Profiles : {};
    if (Object.keys(table).length) {
      for (const task of LATER_TASKS) {
        const d = NEW_PRESET[task]!;
        const target = table[d.same];
        if (!(task in table) && (!target || isList(target))) table[task] = d;
      }
    }
    return table;
  }

  private toPreset(r: PresetRow): Preset {
    return { id: r.id, name: r.name, scope: r.scope, builtin: r.builtin, entries: this.readTable(r.entries), updatedAt: r.updated_at };
  }

  private presetRow(db: Db, id: string): Preset | undefined {
    const r = db.prepare("SELECT id, name, scope, builtin, entries, updated_at FROM model_presets WHERE id = ?").get(id) as PresetRow | undefined;
    return r && this.toPreset(r);
  }

  /** A column's followed preset (or null), the preset a Custom column came from (or null), and its effective table. */
  private readColumn(db: Db, column: Column): { preset: Preset | null; fromPreset: Preset | null; entries: Profiles } {
    const r = db.prepare("SELECT preset, from_preset, entries FROM model_columns WHERE column = ?").get(column) as { preset: string | null; from_preset: string | null; entries: string } | undefined;
    const preset = r?.preset ? this.presetRow(db, r.preset) ?? null : null;
    const fromPreset = r?.from_preset ? this.presetRow(db, r.from_preset) ?? null : null;
    return { preset, fromPreset, entries: preset ? preset.entries : this.readTable(r?.entries) };
  }

  /** What to call the column a context resolves from: its preset's name, or Custom. */
  private columnName(ctx: CallContext): string {
    return this.withUser(ctx.userId, (db) => this.readColumn(db, isRestricted(ctx) ? "private" : "general").preset?.name ?? "Custom");
  }

  /** The thinking level threads use unless they choose. Medium by default. */
  defaultThinking(userId: string): ThinkingLevel {
    const v = this.setting(userId, "thinking") as ThinkingLevel | undefined;
    return v && THINKING_LEVELS.includes(v) ? v : DEFAULT_THINKING;
  }

  setDefaultThinking(userId: string, level: ThinkingLevel): void {
    this.setSetting(userId, "thinking", checkThinking(level));
  }

  /** Read aloud while agent writes: whether Read aloud is offered on the reply she is still writing. Off by default. */
  defaultReadAloudLive(userId: string): boolean {
    return this.setting(userId, "read_aloud_live") === "on";
  }

  setDefaultReadAloudLive(userId: string, on: boolean): void {
    if (typeof on !== "boolean") throw new Error("readAloudLive is true or false");
    this.setSetting(userId, "read_aloud_live", on ? "on" : "off");
  }

  /** Fallback: whether a later model in a list may answer when the first can't, unless a thread says otherwise. On by default. */
  defaultFallback(userId: string): boolean {
    return this.setting(userId, "fallback") !== "off";
  }

  setDefaultFallback(userId: string, on: boolean): void {
    if (typeof on !== "boolean") throw new Error("fallback is true or false");
    this.setSetting(userId, "fallback", on ? "on" : "off");
  }

  /** Free models only: lists skip a model whose price is known and isn't free. Off by default. */
  freeOnly(userId: string): boolean {
    return this.setting(userId, "free_only") === "on";
  }

  setFreeOnly(userId: string, on: boolean): void {
    if (typeof on !== "boolean") throw new Error("freeOnly is true or false");
    this.setSetting(userId, "free_only", on ? "on" : "off");
  }

  /** Read model lists daily: `rereadDaily` reads each of the user's endpoints again once a day. On by default. */
  readDaily(userId: string): boolean {
    return this.setting(userId, "read_daily") !== "off";
  }

  setReadDaily(userId: string, on: boolean): void {
    if (typeof on !== "boolean") throw new Error("readDaily is true or false");
    this.setSetting(userId, "read_daily", on ? "on" : "off");
  }

  /** A thread's own Fallback switch; null follows the user's default. */
  setThreadFallback(userId: string, threadId: string, on: boolean | null): void {
    if (on !== null && typeof on !== "boolean") throw new Error("fallback is true, false or null");
    this.threadChoice(userId, threadId, "fallback", on === null ? null : on ? 1 : 0);
  }

  /** The most context a thread plans for, below its model's window; null for the whole window. Child threads inherit it. */
  setContextLimit(userId: string, threadId: string, tokens: number | null): void {
    if (tokens !== null && (!Number.isInteger(tokens) || tokens < 1024)) throw new Error("a context limit is a whole number of tokens, 1024 or more");
    this.threadChoice(userId, threadId, "context", tokens);
  }

  threadFallback(userId: string, threadId: string): boolean | null {
    const v = this.withUser(userId, (db) => (db.prepare("SELECT fallback FROM thread_choices WHERE thread = ?").get(threadId) as { fallback: number | null } | undefined)?.fallback);
    return v === 1 ? true : v === 0 ? false : null;
  }

  /** Sets (or clears) one thread's ordered list for a task. A private or local-only thread takes local models only. */
  setThreadModel(userId: string, pool: Pool, threadId: string, task: Task, list?: ModelRef[] | ModelRef): void {
    const refs = list === undefined ? undefined : Array.isArray(list) ? list : [list];
    const stored = refs?.length ? this.checkThreadList(this.callContext(userId, pool, threadId), task, refs) : undefined;
    this.withUser(userId, (db) => {
      if (!stored) db.prepare("DELETE FROM thread_models WHERE pool = ? AND thread = ? AND task = ?").run(pool, threadId, task);
      else db.prepare("INSERT OR REPLACE INTO thread_models (pool, thread, task, entry) VALUES (?, ?, ?, ?)").run(pool, threadId, task, JSON.stringify(stored));
      this.index(userId, db);
    });
  }

  /**
   * Checks a thread's list for a task against the thread's context, without
   * saving it: local models only in a private or local-only thread.
   */
  checkThreadList(ctx: CallContext, task: Task, list: ModelRef[]): ModelRef[] {
    return this.checkList(ctx.userId, list, { kind: isRestricted(ctx) ? "local" : undefined, task });
  }

  /** Switches a thread to a preset, or back to its column. Private and local-only threads may choose only a private preset. */
  setThreadPreset(userId: string, pool: Pool, threadId: string, preset: string | null): void {
    this.withUser(userId, (db) => {
      if (preset !== null) {
        const r = db.prepare("SELECT scope FROM model_presets WHERE id = ?").get(preset) as { scope: PresetScope } | undefined;
        if (!r) throw new NoModel(`no preset ${preset}`);
        const localOnly = pool === "private" || !!db.prepare("SELECT 1 FROM local_only_threads WHERE thread = ?").get(threadId);
        if (localOnly && r.scope !== "private") throw new CloudModelForbidden("a private or local-only thread can use only private presets");
      }
      // Keep the legacy profile mirror in step, so a rollback keeps the thread's choice: Cloud writes cloud, the migrated Mixed preset writes custom.
      const mixed = (db.prepare("SELECT value FROM settings WHERE key = ?").get(MIXED_PRESET) as { value: string } | undefined)?.value;
      const profile = preset === "builtin.cloud" ? "cloud" : preset === mixed ? "custom" : null;
      db.prepare("INSERT OR IGNORE INTO thread_choices (thread) VALUES (?)").run(threadId);
      db.prepare("UPDATE thread_choices SET preset = ?, profile = ? WHERE thread = ?").run(preset, profile, threadId);
    });
  }

  /** The preset a thread chose, if it chose one rather than following its column. */
  threadPreset(userId: string, threadId: string): string | null {
    const v = this.withUser(userId, (db) => (db.prepare("SELECT preset FROM thread_choices WHERE thread = ?").get(threadId) as { preset: string | null } | undefined)?.preset);
    return v ?? null;
  }

  /** Sets (or with null, clears) a thread's thinking level. */
  setThinking(userId: string, threadId: string, level: ThinkingLevel | null): void {
    this.threadChoice(userId, threadId, "thinking", level === null ? null : checkThinking(level));
  }

  /** Switches a general thread to local-only, or back. Private threads are always local-only. */
  setLocalOnly(userId: string, pool: Pool, threadId: string, on: boolean): void {
    if (pool === "private" && !on) throw new CloudModelForbidden("a private thread is always local-only");
    if (pool === "private") return;
    this.withUser(userId, (db) => {
      if (on) db.prepare("INSERT OR IGNORE INTO local_only_threads (thread) VALUES (?)").run(threadId);
      else db.prepare("DELETE FROM local_only_threads WHERE thread = ?").run(threadId);
    });
  }

  /** A forgotten thread's model choices and call records go with it. */
  forgetThread(userId: string, pool: Pool, threadId: string): void {
    this.withUser(userId, (db) => db.transaction(() => {
      db.prepare("DELETE FROM thread_models WHERE pool = ? AND thread = ?").run(pool, threadId);
      db.prepare("DELETE FROM model_calls WHERE pool = ? AND thread = ?").run(pool, threadId);
      db.prepare("DELETE FROM call_totals WHERE pool = ? AND thread = ?").run(pool, threadId);
      db.prepare("DELETE FROM thread_choices WHERE thread = ?").run(threadId);
      db.prepare("DELETE FROM local_only_threads WHERE thread = ?").run(threadId);
      this.index(userId, db);
    })());
  }

  /** The thread's CallContext: its local-only switch, preset, thinking level and model overrides. */
  callContext(userId: string, pool: Pool, threadId: string): CallContext {
    return this.withUser(userId, (db) => {
      const rows = db.prepare("SELECT task, entry FROM thread_models WHERE pool = ? AND thread = ?").all(pool, threadId) as { task: Task; entry: string }[];
      const localOnly = pool === "private" || !!db.prepare("SELECT 1 FROM local_only_threads WHERE thread = ?").get(threadId);
      const choice = db.prepare("SELECT preset, thinking, fallback, context FROM thread_choices WHERE thread = ?").get(threadId) as { preset: string | null; thinking: string | null; fallback: number | null; context: number | null } | undefined;
      const setting = (key: string) => (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
      const chosen = choice?.thinking ?? setting("thinking");
      const thinking = (chosen ?? DEFAULT_THINKING) as ThinkingLevel;
      const fallback = choice?.fallback !== null && choice?.fallback !== undefined ? choice.fallback === 1 : setting("fallback") !== "off";
      return {
        userId, pool, localOnly, ...(choice?.preset ? { preset: choice.preset } : {}), thinking: THINKING_LEVELS.includes(thinking) ? thinking : DEFAULT_THINKING, ...(chosen ? {} : { thinkingUnset: true }), fallback,
        ...(choice?.context ? { contextLimit: choice.context } : {}),
        overrides: Object.fromEntries(rows.map((r) => [r.task, JSON.parse(r.entry) as ModelRef[]])),
      };
    });
  }

  /**
   * The CallContext for a child thread, such as a subagent's. It keeps the
   * parent's local-only switch, preset and model choices, and its chat list
   * is the parent's `subagent.<tier>` list, or a named model the parent's
   * context allows. Throws CloudModelForbidden or NoModel before changing anything.
   */
  childContext(parent: CallContext, childThreadId: string, pick: { tier: "cheap" | "strong" } | { model: ModelRef }): CallContext {
    let chat: ModelRef[];
    if ("tier" in pick) {
      this.resolve(`subagent.${pick.tier}`, parent);
      chat = this.listFor(`subagent.${pick.tier}`, parent)!.list;
    } else {
      this.check(parent.userId, pick.model, isRestricted(parent));
      chat = [pick.model];
    }
    this.inheritContext(parent, childThreadId, { chat: false });
    this.setThreadModel(parent.userId, parent.pool, childThreadId, "chat", chat);
    return this.callContext(parent.userId, parent.pool, childThreadId);
  }

  /**
   * Gives a child thread (a branch, a subagent) its parent's local-only
   * switch, preset, thinking level, Fallback, context limit and model lists, the chat list too unless
   * `chat: false`.
   */
  inheritContext(parent: CallContext, childThreadId: string, opts: { chat?: boolean } = {}): CallContext {
    const { userId, pool } = parent;
    if (parent.localOnly) this.setLocalOnly(userId, pool, childThreadId, true);
    // Copied verbatim, not through setThreadPreset, so a local-only parent's (ignored) general preset passes on without throwing.
    if (parent.preset) this.threadChoice(userId, childThreadId, "preset", parent.preset);
    if (parent.thinking && !parent.thinkingUnset) this.setThinking(userId, childThreadId, parent.thinking);
    // A child starts with its parent's Fallback, whatever the default becomes; a subagent can't change it.
    if (parent.fallback !== undefined) this.setThreadFallback(userId, childThreadId, parent.fallback);
    if (parent.contextLimit) this.setContextLimit(userId, childThreadId, parent.contextLimit);
    for (const [task, r] of Object.entries(parent.overrides ?? {})) {
      if (task !== "chat" || opts.chat !== false) this.setThreadModel(userId, pool, childThreadId, task as Task, r);
    }
    return this.callContext(userId, pool, childThreadId);
  }

  // --- The router ---

  /** The model for a task, as `resolve` chooses it. */
  resolveModel(task: Task, ctx: CallContext, need: Need = {}): { offeringId: string } {
    return this.resolve(task, ctx, need).ref;
  }

  /**
   * The model for a task: the first usable one in the thread's list for it,
   * else its preset's, else its column's (private when restricted, general
   * otherwise), following `same` one level. A task with neither uses the
   * chat list, except embeddings and images.
   *
   * Groups expand in place into their members. Redirects are followed, and a
   * removed model counts as not there. A model is skipped when it is gone,
   * its endpoint is stale or known to be down, or it can't handle the call
   * (tools, context window, images). A general preset mixes freely, each
   * model marked; in a private or local-only context, a group's cloud
   * members are skipped and a cloud model named directly throws
   * CloudModelForbidden. With Fallback off (`ctx.fallback === false`) only
   * the list's first entry can answer: a group there keeps its copies, and
   * nothing after it is tried. With Free models only on, a model whose price
   * is known and isn't free is skipped.
   */
  resolve(task: Task, ctx: CallContext, need: Need = {}, opts: ResolveOptions = {}): Resolution {
    const c = this.catalog(ctx.userId);
    const restricted = isRestricted(ctx);
    const found = this.listFor(task, ctx, c);
    if (!found) throw new NoModel(`no model is set for ${TASK_NAMES[task]} in ${this.columnName(ctx)}`);
    const candidates: { id: string; grouped: boolean }[] = [];
    const cut = ctx.fallback === false && found.list.length > 1;
    for (const ref of cut ? found.list.slice(0, 1) : found.list) {
      if ("offeringId" in ref) candidates.push({ id: ref.offeringId, grouped: false });
      else for (const m of c.groups.get(ref.groupId)?.members ?? []) { const id = this.follow(m); if (id) candidates.push({ id, grouped: true }); }
    }
    const seen = new Set<string>();
    const unique = candidates.filter((x) => !seen.has(x.id) && !!seen.add(x.id));
    const skipped: { label: string; reason: string }[] = [];
    const freeOnly = this.freeOnly(ctx.userId);
    let away = false;
    let free: { label: string; reason: string } | undefined;
    for (let i = 0; i < unique.length; i++) {
      const { id, grouped } = unique[i]!;
      const o = c.offerings.get(id);
      if (!o) { skipped.push({ label: id, reason: "it no longer exists" }); continue; }
      const ep = c.endpoints.get(o.endpointId)!;
      const label = labelOf(ep, o);
      if (restricted && ep.kind !== "local") {
        if (!grouped) throw new CloudModelForbidden(`${label} is a cloud model, and only local models are allowed here`);
        continue;
      }
      // Unfit first: a model that couldn't take the call even with its machine up doesn't make the task offline.
      const why = this.unfit(task, o, ep, need) ?? (freeOnly && o.price && !o.price.free ? "it costs money, and Free models only is on" : undefined);
      const reason = why ?? this.away(ep, opts, o);
      if (reason) {
        skipped.push({ label, reason });
        if (!why) away = true;
        if (!free && (ep.kind === "local" || o.price?.free)) free = { label, reason };
        continue;
      }
      const paidAfter = free && o.price && !o.price.free ? { paidAfter: free } : {};
      return { ref: { offeringId: o.id }, endpoint: ep, offering: o, label, profile: found.profile, source: found.source, skipped, remaining: unique.length - i - 1, ...paidAfter };
    }
    // Something would answer once its machine is back: offline, not unset.
    if (away) throw new Offline(task, skipped);
    const reasons = skipped.map((s) => `${s.label}: ${s.reason}`).join("; ");
    throw new NoModel(`no model for ${TASK_NAMES[task]} can answer now${reasons ? ` (${reasons})` : ""}${cut ? ", and Fallback is off" : ""}`);
  }

  /**
   * Like `resolve`, but first probes a chosen endpoint whose health isn't
   * known lately, when there is a later model to fall back to (or always, with
   * `probeLast`), so a machine that is off is passed over before the call
   * rather than after. When the health cache says every machine is away, it
   * asks them again, once, in order, so one that has just come back answers.
   * Throws Offline when none does.
   */
  async resolveLive(task: Task, ctx: CallContext, need: Need = {}, opts: { probeMs?: number; probeLast?: boolean } = {}): Promise<Resolution> {
    const ms = opts.probeMs ?? PROBE_MS;
    let revived = false;
    for (;;) {
      let r: Resolution;
      try {
        r = this.resolve(task, ctx, need);
      } catch (err) {
        if (!(err instanceof Offline) || revived) throw err;
        revived = true;
        if (!(await this.revive(task, ctx, need, ms))) throw err;
        continue;
      }
      const h = this.health.get(r.endpoint.id);
      if ((!r.remaining && !opts.probeLast) || (h && Date.now() - h.at < HEALTH_MS)) return r;
      // Only whether it answers, never the address check: a slow resolver mustn't hold up a turn.
      const up = (await this.answers(r.endpoint, ms)) === "up";
      this.seen(r.endpoint, up, ctx.userId);
      if (up) return r;
    }
  }

  /** Asks the task's machines that the health cache calls down, in order, until one answers. */
  private async revive(task: Task, ctx: CallContext, need: Need, ms: number): Promise<boolean> {
    const except = new Set<string>();
    for (;;) {
      let r: Resolution;
      try {
        r = this.resolve(task, ctx, need, { evenIfDown: true, except });
      } catch {
        return false;
      }
      except.add(r.endpoint.id);
      const up = (await this.answers(r.endpoint, ms)) === "up";
      this.seen(r.endpoint, up, ctx.userId);
      if (up) return true;
    }
  }

  /**
   * Whether an endpoint answers, within `ms`. Never throws. A plan is
   * up while it is signed in: its token is for the Responses API, so there is
   * nothing to probe; a failed call marks it down like any other.
   */
  private answers(ep: Endpoint, ms?: number): Promise<"up" | "down"> {
    if (isPlan(ep.api)) return Promise.resolve(ep.signedOut ? "down" : "up");
    return (ep.api === "host" ? this.hostUp(ep, ms) : probeUrl(ep.baseUrl, ep.apiKey, ms)).catch(() => "down" as const);
  }

  /**
   * One call, on the task's models in turn: a model whose machine can't be
   * reached or is away (`isUnreachable`) is marked down and the next one
   * tries; so does one too big for its machine's GPU. Any other failure is the call's own and is thrown as is. When none
   * answers, throws Offline naming every model tried. The call records itself.
   */
  async callWithFallback<T>(task: Task, ctx: CallContext, need: Need, call: (r: Resolution) => Promise<T>, opts: { probeMs?: number } = {}): Promise<T> {
    const tried: { label: string; reason: string }[] = [];
    const used = new Set<string>();
    for (;;) {
      let r: Resolution;
      try {
        r = await this.resolveLive(task, ctx, need, opts);
      } catch (err) {
        if (err instanceof Offline && tried.length) throw new Offline(task, [...tried, ...err.tried.filter((t) => !tried.some((x) => x.label === t.label))]);
        throw err;
      }
      // A machine that answers its probe but fails every call: don't go round again.
      if (used.has(r.offering.id)) throw new Offline(task, tried);
      used.add(r.offering.id);
      try {
        const out = await call(r);
        this.reportUp(ctx.userId, r.endpoint.id);
        return out;
      } catch (err) {
        // A model too big for its machine's GPU never fits there: the next one answers, and the machine stays up.
        if (err instanceof HostRefused && err.code === "too_big") {
          this.modelDown.set(r.offering.id, Date.now());
          tried.push({ label: r.label, reason: "it's too big for that machine's GPU, so retrying won't help" });
          continue;
        }
        if (!isUnreachable(err)) throw err;
        // A host that answered but couldn't run this one model stays up for its others.
        if (err instanceof HostRefused && err.code === "model_unavailable") this.modelDown.set(r.offering.id, Date.now());
        else this.reportDown(r.endpoint.id);
        tried.push({ label: r.label, reason: "it couldn't be reached" });
      }
    }
  }

  /** The next eligible image model on a different endpoint, without probing or sending. */
  nextImageModel(ctx: CallContext, action: "create" | "edit" | "upscale", need: Need, afterEndpoint: string, noCloud = false): Resolution | undefined {
    const task = `image.${action}` as Task;
    const catalog = this.catalog(ctx.userId), found = this.listFor(task, ctx, catalog);
    if (!found) return undefined;
    const list = ctx.fallback === false ? found.list.slice(0, 1) : found.list;
    const ids = list.flatMap(ref => "offeringId" in ref ? [ref.offeringId] : catalog.groups.get(ref.groupId)?.members ?? []);
    let passed = false;
    for (const raw of ids) {
      const id = this.follow(raw), offering = id ? catalog.offerings.get(id) : undefined;
      if (!offering) continue;
      const endpoint = catalog.endpoints.get(offering.endpointId);
      if (!endpoint) continue;
      if (endpoint.id === afterEndpoint) { passed = true; continue; }
      if (!passed || (isRestricted(ctx) || noCloud) && endpoint.kind !== "local") continue;
      if (this.unfit(task, offering, endpoint, need) || this.away(endpoint, {}, offering)) continue;
      return { ref: { offeringId: offering.id }, endpoint, offering, label: labelOf(endpoint, offering),
        profile: found.profile, source: found.source, skipped: [], remaining: 0 };
    }
    return undefined;
  }

  /**
   * A signed-in ChatGPT plan that has no image model yet (it was added
   * before plans had one) is discovered, which reads no network for a plan
   * and moves its image lists over. The Models page and every image call do this.
   */
  async planImages(userId: string): Promise<void> {
    const actor = this.users.get(userId);
    if (!actor) return;
    for (const e of this.endpoints(userId)) {
      if (e.api === "chatgpt" && !e.signedOut && !this.offerings(userId, e.id).some((o) => o.modelId === PLAN_IMAGE_MODEL)) await this.discover(actor, e.id).catch(() => {});
    }
  }

  /** Images stay in memory; the caller stores results and records the call. */
  /** `onProgress`: how far a model host's job has got (cloud models report none). */
  async image(ctx: CallContext, request: ImageRequest, opts: { signal?: AbortSignal; beforeSend?: (resolution: Resolution) => Promise<void>; onProgress?: (p: JobProgress) => void } = {}): Promise<{ images: GeneratedImage[]; resolution: Resolution }> {
    validateImageRequest(request);
    await this.planImages(ctx.userId);
    return this.callWithFallback(`image.${request.action}`, ctx, request.action === "create" ? { imageTier: request.tier } : request.action === "edit" ? { imageMask: !!request.mask } : {}, async (r) => {
      opts.signal?.throwIfAborted();
      await opts.beforeSend?.(r);
      opts.signal?.throwIfAborted();
      const ep = r.endpoint;
      // ChatGPT Images is made by the user's own Codex, not over the plan's sign-in, which OpenAI refuses for images.
      const codex = ep.api === "chatgpt" && this.codexImages ? this.codexImages.bind(this, ctx.userId) : undefined;
      const images = await imageAt({ fetch: this.fetchFor(ep) ?? fetch, baseUrl: ep.api === "host" ? hostOrigin(ep.addresses![0]!) : ep.baseUrl,
        host: ep.api === "host", api: ep.api, modelId: r.offering.modelId, apiKey: ep.api === "chatgpt" ? undefined : ep.apiKey, codex }, request, opts.signal, opts.onProgress);
      return { images, resolution: r };
    });
  }

  /**
   * One clip from the context's Videos list, in memory; the caller stores it and records the call.
   * Local models only: a cloud video model is never resolved, whatever the list holds.
   */
  async video(ctx: CallContext, request: VideoRequest, opts: { signal?: AbortSignal; beforeSend?: (resolution: Resolution) => Promise<void>; onProgress?: (p: JobProgress) => void } = {}): Promise<{ video: GeneratedVideo; resolution: Resolution }> {
    validateVideoRequest(request);
    return this.callWithFallback("video", ctx, request.drive ? { motion: true } : { animate: !!request.image }, async (r) => {
      opts.signal?.throwIfAborted();
      await opts.beforeSend?.(r);
      opts.signal?.throwIfAborted();
      const ep = r.endpoint;
      const video = await videoAt({ fetch: this.fetchFor(ep) ?? fetch, baseUrl: hostOrigin(ep.addresses![0]!), modelId: r.offering.modelId }, request, opts.signal, opts.onProgress);
      return { video, resolution: r };
    });
  }

  // --- Speech ---

  /**
   * Transcribes a WAV clip with the context's Dictation model: the only way
   * a user's audio reaches a model. A cloud model answers only when the
   * thread picked it (`voiceContext`); otherwise the Private column's list. An endpoint that can't answer is marked down and the next model
   * in the list is tried, within the list's kind (`callWithFallback`); when
   * none can, Offline.
   * The audio is held in memory only. The caller records the call.
   */
  async transcribe(ctx: CallContext, wav: Uint8Array, opts: { language?: string; signal?: AbortSignal } = {}): Promise<{ text: string; resolution: Resolution; audioSeconds?: number }> {
    if (opts.language !== undefined && !LANGUAGE.test(opts.language)) throw new Error("language is a tag such as en or zh");
    if (wav.length > MAX_CLIP_BYTES) throw new Error(`a clip is at most ${MAX_CLIP_SECONDS / 60} minutes`);
    const seconds = wavSeconds(wav);
    if (seconds === undefined) throw new Error("the clip isn't PCM WAV audio");
    return this.callWithFallback("speech.transcribe", voiceContext(ctx), {}, async (r) => {
      const text = await transcribeAt(this.speechTarget(r), wav, opts);
      return { text, resolution: r, audioSeconds: seconds };
    });
  }

  /**
   * Speaks one piece of text (a sentence of a message) with the context's
   * Read aloud model, as raw PCM (SPEECH_FORMAT). The voice is `voice`,
   * else this user's setting for `language`, else the model's first voice
   * for that language, else its first voice; the speed likewise. Falls back
   * like `transcribe`, up to the first bytes of audio. Cancelling the stream
   * (or `signal`) cancels the request. The caller records the call.
   */
  async speak(ctx: CallContext, text: string, opts: { voice?: string; speed?: number; language?: string; signal?: AbortSignal } = {}): Promise<{ audio: ReadableStream<Uint8Array>; resolution: Resolution; voice?: string }> {
    if (!text.trim()) throw new Error("there is nothing to read");
    if (text.length > MAX_SPEAK_CHARS) throw new Error(`a piece of text to speak is at most ${MAX_SPEAK_CHARS} characters`);
    if (opts.speed !== undefined && !(opts.speed >= 0.25 && opts.speed <= 4)) throw new Error("speed is a number from 0.25 to 4");
    return this.callWithFallback("speech.speak", ctx, {}, async (r) => {
      const settings = this.offeringSettings(ctx.userId, r.offering.id).values;
      const voices = r.offering.speak?.voices ?? [];
      const lang = opts.language?.toLowerCase();
      const voice = opts.voice ?? (lang ? settings.voices?.[lang] ?? voices.find((v) => v.language === lang)?.id : undefined) ?? voices[0]?.id;
      const speed = opts.speed ?? settings.speed;
      const audio = await speakAt(this.speechTarget(r), text, { ...(voice ? { voice } : {}), ...(speed !== undefined ? { speed } : {}), ...(opts.signal ? { signal: opts.signal } : {}) });
      return { audio, resolution: r, ...(voice ? { voice } : {}) };
    });
  }

  /**
   * Whether a context has a model for a speech task now, without calling it:
   * the model's label and kind, or the plain reason it has none.
   */
  speechModel(task: SpeechTask, ctx: CallContext): { label: string; kind: "cloud" | "local" } | { reason: "none" | "down"; problem: string } {
    if (task === "speech.transcribe") ctx = voiceContext(ctx);
    try {
      const r = this.resolve(task, ctx);
      return { label: r.label, kind: r.endpoint.kind };
    } catch (e) {
      if (e instanceof Offline) return { reason: "down", problem: `${TASK_NAMES[task]} can't be reached now` };
      if (e instanceof CloudModelForbidden) return { reason: "none", problem: e.message };
      if (!(e instanceof NoModel)) throw e;
      if (!this.listFor(task, ctx)?.list.length) return { reason: "none", problem: `No ${TASK_NAMES[task]} model is set${isRestricted(ctx) ? " in the Private column" : ""}` };
      return { reason: "none", problem: e.message };
    }
  }

  private speechTarget(r: Resolution): SpeechTarget {
    const ep = r.endpoint;
    return { fetch: this.fetchFor(ep) ?? fetch, baseUrl: ep.baseUrl, ...(ep.apiKey ? { apiKey: ep.apiKey } : {}), modelId: r.offering.modelId, name: ep.name };
  }

  /** The level a model thinks at when it can't turn thinking off: medium, or the nearest it has. Undefined when it can't think. */
  mandatoryThinking(o: Pick<Offering, "reasoning">): Exclude<ThinkingLevel, "off"> | undefined {
    return nearestLevel(o.reasoning ?? [], "medium");
  }

  /**
   * Records that a model refused a request with thinking off (some providers
   * require it), so it thinks at mandatoryThinking from then on. Kept for the
   * daemon's run: after a restart the first such request learns it again.
   */
  mustThink(offeringId: string): void {
    this.alwaysThinks.add(offeringId);
  }

  /**
   * Records that a model with no thinking levels thought anyway (a plain
   * llama-server running a model whose template thinks by default), and
   * clears the "can't think" note on the thread's latest call to it. Kept
   * for the daemon's run, like mustThink.
   */
  sawThinking(userId: string, offeringId: string, at: { pool: Pool; threadId: string; task: Task }): void {
    this.thinksUnasked.add(offeringId);
    this.withUser(userId, (db) => {
      db.prepare("UPDATE model_calls SET note = NULL WHERE id = (SELECT max(id) FROM model_calls WHERE pool = ? AND thread = ? AND task = ?) AND offering = ?")
        .run(at.pool, at.threadId, at.task, offeringId);
    });
  }

  /** Whether a model with no thinking levels was seen thinking anyway. */
  thinksOnItsOwn(offeringId: string): boolean {
    return this.thinksUnasked.has(offeringId);
  }

  /**
   * The thinking level a model runs at for a requested one, and a note when it
   * thinks at another level. A model that can't think answers without thinking,
   * saying so unless `unset` (nobody chose a level) or it was seen thinking on
   * its own (sawThinking); one that can't turn
   * thinking off thinks at medium, or the nearest level it has.
   */
  thinkingFor(r: Pick<Resolution, "offering" | "label"> & { endpoint?: Pick<Endpoint, "api"> }, asked: ThinkingLevel = DEFAULT_THINKING, unset = false): { level: ThinkingLevel; note?: string } {
    const levels = r.offering.reasoning ?? [];
    if (!levels.length) return asked === "off" || unset || this.thinksUnasked.has(r.offering.id) ? { level: "off" } : { level: "off", note: `${r.label} can't think, so it answered without thinking` };
    if (asked === "off") {
      if (!r.offering.alwaysThinks && !this.alwaysThinks.has(r.offering.id)) return { level: "off" };
      const level = this.mandatoryThinking(r.offering)!;
      return { level, note: `${r.label} can't turn thinking off, so it thought at ${level}` };
    }
    if ((levels as string[]).includes(asked)) return { level: asked };
    // A host's or LM Studio's thinking switch (one level) is simply on.
    if (levels.length === 1 && (r.endpoint?.api === "host" || r.offering.lmStudio || r.offering.llamaServer)) return { level: levels[0]! };
    const level = nearestLevel(levels, asked)!;
    return { level, note: `${r.label} doesn't think at ${asked}, so it thought at ${level}` };
  }

  /**
   * Records which model answered a call. Never any of the conversation's
   * text. A retry within the turn (`retry`) rewrites that turn's record, so
   * a turn is one call.
   */
  recordCall(userId: string, call: { pool: Pool; threadId: string; task: Task; resolution: Resolution; note?: string; audioSeconds?: number }, opts: { retry?: boolean } = {}): void {
    const r = call.resolution;
    const first = r.skipped[0];
    const fallback = first && `${first.label} was skipped (${first.reason.replace(/^it /, "")}), so ${r.label} answered${r.endpoint.kind === "cloud" && r.profile === "Custom" ? ", a cloud model" : ""}`;
    this.withUser(userId, (db) => {
      const last = opts.retry ? (db.prepare("SELECT max(id) AS id FROM model_calls WHERE pool = ? AND thread = ? AND task = ?").get(call.pool, call.threadId, call.task) as { id: number | null }).id : null;
      if (last !== null) {
        db.prepare("UPDATE model_calls SET offering = ?, label = ?, endpoint = ?, kind = ?, fallback = ?, note = ? WHERE id = ?")
          .run(r.offering.id, r.label, r.endpoint.name, r.endpoint.kind, fallback ?? null, call.note ?? null, last);
        return;
      }
      const seconds = call.audioSeconds !== undefined && Number.isFinite(call.audioSeconds) ? Math.max(0, Math.round(call.audioSeconds * 10) / 10) : null;
      db.prepare("INSERT INTO model_calls (at, pool, thread, task, offering, label, endpoint, kind, fallback, note, audio_seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(new Date().toISOString(), call.pool, call.threadId, call.task, r.offering.id, r.label, r.endpoint.name, r.endpoint.kind, fallback ?? null, call.note ?? null, seconds);
    });
  }

  /**
   * Adds a finished turn's counts and times to its call record (the thread's
   * latest for the task). Never text, so a "Do not log" thread records it too.
   */
  recordPace(userId: string, threadId: string, pace: Omit<Pace, "tokPerSec" | "promptTokPerSec">, task: Task = "chat", pool?: Pool): void {
    const n = (v: number) => Math.max(0, Math.round(Number.isFinite(v) ? v : 0));
    this.withUser(userId, (db) => db.prepare(`UPDATE model_calls SET read_tokens = ?, prompt_tokens = ?, output_tokens = ?, window = ?, ttft_ms = ?, gen_ms = ?, processed = ?
      WHERE id = (SELECT max(id) FROM model_calls WHERE thread = ? AND task = ? AND (? IS NULL OR pool = ?))`)
      .run(pace.readTokens === undefined ? null : n(pace.readTokens), n(pace.promptTokens), n(pace.outputTokens), n(pace.window), n(pace.ttftMs), n(pace.genMs), n(pace.processed), threadId, task, pool ?? null, pool ?? null));
  }

  /** The user's recent calls, newest first. With a thread, that thread's only; with `speech: false`, no Dictation or Read aloud. */
  recentCalls(userId: string, opts: { limit?: number; threadId?: string; threadIds?: string[]; pool?: Pool; speech?: false } = {}): CallRecord[] {
    const where = [...(opts.pool ? ["pool = @pool"] : []), ...(opts.threadId ? ["thread = @thread"] : []), ...(opts.threadIds ? ["thread IN (SELECT value FROM json_each(@threads))"] : []),
      ...(opts.speech === false ? ["task NOT LIKE 'speech.%'"] : [])];
    const rows = this.withUser(userId, (db) => db.prepare(`SELECT * FROM model_calls ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT @limit`)
      .all({ ...(opts.pool ? { pool: opts.pool } : {}), ...(opts.threadId ? { thread: opts.threadId } : {}), ...(opts.threadIds ? { threads: JSON.stringify(opts.threadIds) } : {}), limit: opts.limit ?? 50 })) as CallRow[];
    return rows.map(toCall);
  }

  /** How many times each endpoint answered, counted over `model_calls` in these pools rather than over any preview list,
   * and how fast it wrote lately: output tokens over generation time (and prompt tokens read over time to first token)
   * across its last SPEED_CALLS measured turns of the past day, `speedCalls` of them. No measured turn, no speeds.
   * Endpoints with no calls aren't listed; a call to an endpoint since removed counts nowhere. */
  endpointUses(userId: string, pools: Pool[], now = Date.now()): EndpointUse[] {
    if (!pools.length) return [];
    const params = { pools: JSON.stringify(pools), since: new Date(now - SPEED_WINDOW_MS).toISOString(), last: SPEED_CALLS };
    const [rows, paced] = this.withUser(userId, (db) => [
      db.prepare("SELECT endpoint, kind, count(*) AS calls FROM model_calls WHERE pool IN (SELECT value FROM json_each(@pools)) GROUP BY endpoint, kind").all(params),
      db.prepare(`SELECT endpoint, kind, count(*) AS n, sum(output_tokens) AS out, sum(gen_ms) AS gen, sum(processed) AS processed, sum(ttft_ms) AS ttft FROM (
          SELECT endpoint, kind, output_tokens, gen_ms, coalesce(processed, 0) AS processed, coalesce(ttft_ms, 0) AS ttft_ms,
            row_number() OVER (PARTITION BY endpoint, kind ORDER BY id DESC) AS rn
          FROM model_calls WHERE pool IN (SELECT value FROM json_each(@pools)) AND at >= @since AND gen_ms >= 50 AND output_tokens > 0
        ) WHERE rn <= @last GROUP BY endpoint, kind`).all(params),
    ]) as [{ endpoint: string; kind: "local" | "cloud"; calls: number }[], { endpoint: string; kind: "local" | "cloud"; n: number; out: number; gen: number; processed: number; ttft: number }[]];
    const byName = new Map(rows.map((r) => [`${r.kind}/${r.endpoint}`, r.calls]));
    const paceByName = new Map(paced.map((r) => [`${r.kind}/${r.endpoint}`, r]));
    return this.endpoints(userId).flatMap((e) => {
      const calls = byName.get(`${e.kind}/${e.name}`);
      if (!calls) return [];
      const p = paceByName.get(`${e.kind}/${e.name}`);
      const s = p && speeds({ promptTokens: 0, outputTokens: p.out, window: 0, ttftMs: p.ttft, genMs: p.gen, processed: p.processed });
      return [{ endpointId: e.id, calls, ...(s?.tokPerSec !== undefined ? { tokPerSec: s.tokPerSec, speedCalls: p!.n } : {}),
        ...(s?.tokPerSec !== undefined && s.promptTokPerSec !== undefined ? { promptTokPerSec: s.promptTokPerSec } : {}) }];
    });
  }

  /** Paged call metadata, restricted to the displayed pools before counting. */
  callHistory(userId: string, opts: { limit: number; offset: number; q: string; pools: Pool[]; threadIds?: string[] }) {
    const where = "pool IN (SELECT value FROM json_each(@pools)) AND instr(lower(label || ' ' || endpoint || ' ' || task || ' ' || thread || ' ' || at || ' ' || coalesce(fallback, '') || ' ' || coalesce(note, '')), lower(@q)) > 0" +
      (opts.threadIds ? " AND thread IN (SELECT value FROM json_each(@threads))" : "");
    const params = { pools: JSON.stringify(opts.pools), q: opts.q, ...(opts.threadIds ? { threads: JSON.stringify(opts.threadIds) } : {}) };
    return this.withUser(userId, (db) => {
      const total = (db.prepare(`SELECT count(*) AS n FROM model_calls WHERE ${where}`).get(params) as { n: number }).n;
      const rows = db.prepare(`SELECT * FROM model_calls WHERE ${where} ORDER BY id DESC LIMIT @limit OFFSET @offset`).all({ ...params, limit: opts.limit, offset: opts.offset }) as CallRow[];
      return { total, entries: rows.map(toCall) };
    });
  }

  /**
   * Adds one call's tokens to a thread's running totals, for calls Lyrica
   * doesn't make herself (Claude Code in her sandbox, counted by its relay):
   * no call record, only the count the usage view sums.
   */
  addCallTotals(userId: string, pool: Pool, threadId: string, label: string, kind: "local" | "cloud", input: number, output: number): void {
    const n = (v: number) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
    const [i, o] = [n(input), n(output)];
    if (!i && !o) return;
    this.withUser(userId, (db) => db.prepare(`INSERT INTO call_totals (pool, thread, label, kind, tokens, input_tokens, output_tokens, gpu_ms, calls) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1)
      ON CONFLICT (pool, thread, label, kind) DO UPDATE SET tokens = tokens + excluded.tokens, input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens, calls = calls + 1`).run(pool, threadId, label, kind, i + o, i, o));
  }

  /**
   * Turns and recursively nested subagents, filtered by both pool and thread. A subagent's own turns count through its run, never its call records,
   * so a project tree that lists it isn't counted twice; Claude Code run from a subagent's thread, which its run doesn't count, still counts there.
   * `input` and `output` split `tokens` where it is known: totals folded before user step 17 count in `tokens` alone.
   */
  usage(userId: string, pool: Pool, threadIds: string[]): UsageRow[] {
    const rows = this.withUser(userId, (db) => db.prepare(`
      SELECT thread AS threadId, label, kind, sum(tokens) AS tokens, sum(input) AS input, sum(output) AS output, sum(gpu_ms) AS gpuMs FROM (
        SELECT thread, label, kind, coalesce(read_tokens, prompt_tokens, 0) + coalesce(output_tokens, 0) AS tokens,
          coalesce(read_tokens, prompt_tokens, 0) AS input, coalesce(output_tokens, 0) AS output,
          CASE WHEN kind = 'local' THEN coalesce(ttft_ms, 0) + coalesce(gen_ms, 0) ELSE 0 END AS gpu_ms
        FROM model_calls WHERE pool = @pool AND thread IN (SELECT value FROM json_each(@threads)) AND task IN ('chat', 'code')
          AND (prompt_tokens IS NOT NULL OR read_tokens IS NOT NULL OR output_tokens IS NOT NULL) AND thread NOT IN (SELECT thread FROM subagent_runs WHERE pool = @pool)
        UNION ALL SELECT thread, label, kind, tokens, input_tokens, output_tokens, gpu_ms FROM call_totals
          WHERE pool = @pool AND thread IN (SELECT value FROM json_each(@threads))
            AND (label = 'Claude Code' OR label LIKE 'Claude Code/%' OR thread NOT IN (SELECT thread FROM subagent_runs WHERE pool = @pool))
      ) GROUP BY thread, label, kind`).all({ pool, threads: JSON.stringify(threadIds) })) as
      { threadId: string; label: string; kind: "local" | "cloud"; tokens: number; input: number; output: number; gpuMs: number }[];
    const result: UsageRow[] = rows.map(r => ({ threadId: r.threadId, label: r.label, kind: r.kind, tokens: r.tokens, input: r.input, output: r.output, ...(r.kind === "local" ? { gpuMs: r.gpuMs } : {}) }));
    const runs = this.withUser(userId, db => db.prepare(`WITH RECURSIVE descendants(root, thread) AS (
      SELECT value, value FROM json_each(@threads)
      UNION SELECT d.root, r.thread FROM descendants d JOIN subagent_runs r ON r.parent = d.thread AND r.pool = @pool
    ) SELECT d.root AS threadId, r.model AS label, r.offering, r.input_tokens AS input, r.output_tokens AS output
      FROM descendants d JOIN subagent_runs r ON r.thread = d.thread AND r.pool = @pool
      WHERE d.thread != d.root`).all({ pool, threads: JSON.stringify(threadIds) })) as { threadId: string; label: string; offering: string | null; input: number; output: number }[];
    for (const r of runs) {
      const kind = r.offering ? this.offering(userId, r.offering)?.endpoint.kind : undefined;
      const existing = result.find(x => x.threadId === r.threadId && x.label === r.label && x.kind === kind);
      if (existing) { existing.tokens += r.input + r.output; existing.input += r.input; existing.output += r.output; }
      else result.push({ threadId: r.threadId, label: r.label, ...(kind ? { kind } : {}), tokens: r.input + r.output, input: r.input, output: r.output });
    }
    // The cache's share, from call records that measured it, counted where their tokens are: a subagent's under its parent. Folded totals never measured it.
    const cache = this.withUser(userId, db => db.prepare(`WITH RECURSIVE descendants(root, thread) AS (
      SELECT value, value FROM json_each(@threads)
      UNION SELECT d.root, r.thread FROM descendants d JOIN subagent_runs r ON r.parent = d.thread AND r.pool = @pool
    ) SELECT d.root AS threadId, c.label, c.kind, sum(max(c.read_tokens - c.processed, 0)) AS cached, sum(c.read_tokens) AS measured
      FROM descendants d JOIN model_calls c ON c.thread = d.thread AND c.pool = @pool
      WHERE c.task IN ('chat', 'code') AND c.read_tokens > 0 AND c.processed IS NOT NULL
        AND (d.thread != d.root OR d.thread NOT IN (SELECT thread FROM subagent_runs WHERE pool = @pool))
      GROUP BY d.root, c.label, c.kind`).all({ pool, threads: JSON.stringify(threadIds) })) as { threadId: string; label: string; kind: "local" | "cloud"; cached: number; measured: number }[];
    for (const c of cache) {
      const row = result.find(x => x.threadId === c.threadId && x.label === c.label && (x.kind === undefined || x.kind === c.kind));
      if (row) { row.cached = (row.cached ?? 0) + c.cached; row.measured = (row.measured ?? 0) + c.measured; }
    }
    return result;
  }

  /** Each copy's median speeds over its last twenty measured calls, for this user. */
  speedsByOffering(userId: string): Map<string, { tokPerSec?: number; promptTokPerSec?: number }> {
    const rows = this.withUser(userId, (db) => db.prepare(`SELECT * FROM (
      SELECT *, row_number() OVER (PARTITION BY offering ORDER BY id DESC) AS k FROM model_calls WHERE gen_ms IS NOT NULL
    ) WHERE k <= 20`).all()) as CallRow[];
    const by = new Map<string, Pace[]>();
    for (const r of rows) { const p = toCall(r).pace; if (p) by.set(r.offering, [...(by.get(r.offering) ?? []), p]); }
    const median = (xs: (number | undefined)[]) => {
      const v = xs.filter((x): x is number => x !== undefined).sort((a, b) => a - b);
      return v.length ? (v.length % 2 ? v[(v.length - 1) / 2]! : Math.round(((v[v.length / 2 - 1]! + v[v.length / 2]!) / 2) * 10) / 10) : undefined;
    };
    return new Map([...by].map(([id, ps]) => {
      const tok = median(ps.map((p) => p.tokPerSec));
      const prompt = median(ps.map((p) => p.promptTokPerSec));
      return [id, { ...(tok !== undefined ? { tokPerSec: tok } : {}), ...(prompt !== undefined ? { promptTokPerSec: prompt } : {}) }];
    }));
  }

  /**
   * The chat models a context may use, by label, for her to name: listed, and not image, speech or embedding models.
   * `paid` when its price is known and isn't free.
   */
  textModels(ctx: CallContext): (Named & { local: boolean; vision: boolean; paid: boolean })[] {
    return this.allowed(ctx).flatMap(({ endpoint, offerings }) => offerings
      .filter((o) => o.status === "listed" && o.tools !== false && !o.embedding && !o.image && !o.transcribe && !o.speak && !o.recipe)
      .map((o) => ({ id: o.id, label: labelOf(endpoint, o), local: endpoint.kind === "local", vision: !!o.vision, paid: !!o.price && !o.price.free })));
  }

  /** Every endpoint and model a context may use. For a restricted context, local endpoints only. */
  allowed(ctx: CallContext): { endpoint: Endpoint; offerings: Offering[] }[] {
    const c = this.catalog(ctx.userId);
    return [...c.endpoints.values()]
      .filter((e) => !isRestricted(ctx) || e.kind === "local")
      .map((endpoint) => ({ endpoint, offerings: [...c.offerings.values()].filter((o) => o.endpointId === endpoint.id) }));
  }

  /**
   * The list that decides a task, after `same` and the chat fallback, with
   * tombstoned entries dropped: the thread's own list, else its preset's,
   * else its column's. A restricted context ignores a general preset and
   * reads the Private column. `profile` names the preset the list came
   * from, or "Custom" for a column's own table.
   */
  private listFor(task: Task, ctx: CallContext, c = this.catalog(ctx.userId)): { list: ModelRef[]; source: "thread" | "preset" | "column"; profile: string } | undefined {
    const restricted = isRestricted(ctx);
    const column = restricted ? "private" : "general";
    return this.withUser(ctx.userId, (db) => {
      const col = this.readColumn(db, column);
      const chosen = ctx.preset ? this.presetRow(db, ctx.preset) : undefined;
      const honored = chosen && (!restricted || chosen.scope === "private") ? chosen : undefined;
      const columnPreset = col.preset && (!restricted || col.preset.scope === "private") ? col.preset : null;
      const table = honored?.entries ?? columnPreset?.entries ?? col.entries;
      const profile = honored?.name ?? columnPreset?.name ?? "Custom";
      const live = (list: ModelRef[] | undefined) => list?.flatMap((r): ModelRef[] => {
        const id = this.follow(refId(r));
        if (!id) return [];
        return "groupId" in r ? (c.groups.has(id) ? [{ groupId: id }] : []) : [{ offeringId: id }];
      });
      const of = (t: Task, threadOverride = true): { list: ModelRef[]; source: "thread" | "preset" | "column"; profile: string } | undefined => {
        const own = threadOverride ? live(ctx.overrides?.[t]) : undefined;
        if (own?.length) return { list: own, source: "thread", profile };
        let e = table[t];
        if (e && !isList(e)) e = table[e.same];
        const listed = live(isList(e) ? e : undefined);
        return listed?.length ? { list: listed, source: honored ? "preset" : "column", profile } : undefined;
      };
      return of(task) ?? (OWN_LIST_ONLY.includes(task) ? undefined : of("chat", task !== "code"));
    });
  }

  /** Why a model's machine is away now, if it is: stale, or down in the health cache. */
  private away(ep: Endpoint, opts: ResolveOptions, o: Offering): string | undefined {
    if (ep.stale) return `${ep.name} hasn't answered for ${STALE_DAYS} days`;
    if (ep.signedOut) return `${ep.name} is signed out`;
    if (ep.pausedAt) return `${ep.name} is paused`;
    if (this.planFallingBack(ep.id)) return `${ep.name} has reached its plan's limit`;
    const m = this.modelDown.get(o.id);
    if (m !== undefined && Date.now() - m < HEALTH_MS) return `${ep.name} couldn't run it`;
    if (opts.except?.has(ep.id)) return `${ep.name} is down`;
    const h = this.health.get(ep.id);
    if (!opts.evenIfDown && h && !h.up && Date.now() - h.at < HEALTH_MS) return `${ep.name} is down`;
    return undefined;
  }

  /** Why a model can't take this call now, if it can't. */
  private unfit(task: Task, o: Offering, ep: Endpoint, need: Need): string | undefined {
    if (o.status === "gone") return `it has been missing from ${ep.name} for ${GONE_DAYS} days`;
    if (task === "image.create" && !o.image) return "it doesn't make images";
    // Only a model host makes clips, and only one whose recipe does what the call needs.
    if (task === "video" && ep.api !== "host") return "only a model host makes videos";
    if (task === "video" && need.motion && !o.motion) return "it doesn't move an image as a clip does";
    if (task === "video" && !need.motion && (need.animate ? !o.animate : !o.video)) return need.animate ? "it doesn't animate images" : "it doesn't make videos from a prompt";
    if (task === "vision" && !o.vision) return "it can't see images";
    // Cloud adapters constrain their tasks; local endpoints keep capability-based routing.
    if (task.startsWith("image.") && ep.kind === "cloud") {
      const provider = CLOUD_IMAGE_PROVIDERS[ep.api];
      if (!provider || task === "image.upscale" || (task === "image.create" && !provider.create) || (task === "image.edit" && !provider.edit)) return "this endpoint has no image provider for the task";
      if (task === "image.edit" && need.imageMask && !provider.mask) return "this image provider does not accept masks";
    }
    if (task === "image.create" && need.imageTier
      && o.useFor && o.useFor !== "both" && o.useFor !== need.imageTier) return `it is for ${o.useFor} images`;
    if (task === "image.upscale" && !o.upscale) return "it doesn't upscale images";
    if (task === "image.edit" && !o.edit) return "it doesn't edit images";
    // A host recipe whose template takes no mask; one listed before hosts said so is tried.
    if (task === "image.edit" && need.imageMask && o.mask === false) return "it doesn't take a mask";
    if (task === "speech.transcribe" && !o.transcribe) return "it doesn't transcribe speech";
    if (task === "speech.speak" && !o.speak?.voices.length) return "it doesn't speak";
    if (need.tools && o.tools === false) return "it can't use tools";
    if (need.tokens && o.contextWindow && o.contextWindow < need.tokens) return `its context window (${o.contextWindow} tokens) is smaller than the conversation`;
    return undefined;
  }

  /**
   * Checks a list before it is saved: every entry exists; `kind` local takes
   * local models only (a group needs a member of it); image and speech tasks
   * take models that can do the job.
   */
  private checkList(userId: string, list: ModelRef[], opts: { kind?: "local"; task: Task }): ModelRef[] {
    const c = this.catalog(userId);
    const out: ModelRef[] = [];
    const fits = (o: Offering) => (opts.task === "vision" ? !!o.vision : opts.task === "image.create" ? !!o.image : opts.task === "image.edit" ? !!o.edit : opts.task === "image.upscale" ? !!o.upscale
      : opts.task === "video" ? !!(o.video || o.animate || o.motion) : opts.task === "speech.transcribe" ? !!o.transcribe : opts.task === "speech.speak" ? !!o.speak?.voices.length : true);
    for (const ref of list) {
      const id = ref && typeof ref === "object" ? refId(ref) : undefined;
      if (!id || typeof id !== "string") throw new NoModel("a list holds models or groups");
      if (out.some((r) => refId(r) === id)) continue;
      if ("groupId" in ref) {
        const g = c.groups.get(ref.groupId);
        if (!g) throw new NoModel(`no group ${ref.groupId}`);
        const members = g.members.map((m) => c.offerings.get(m)).filter((o): o is Offering => !!o);
        if (opts.kind === "local" && !members.some((o) => c.endpoints.get(o.endpointId)!.kind === "local")) {
          throw new CloudModelForbidden(`the group ${g.name} has no local copy, and only local models are allowed here`);
        }
        if (!members.some(fits)) throw new Error(`no copy in the group ${g.name} can do ${opts.task}`);
        out.push({ groupId: g.id });
      } else {
        const o = c.offerings.get(ref.offeringId);
        if (!o) throw new NoModel(`no model ${ref.offeringId}`);
        const ep = c.endpoints.get(o.endpointId)!;
        if (opts.kind === "local" && ep.kind !== "local") throw new CloudModelForbidden(`${labelOf(ep, o)} is a cloud model, and only local models are allowed here`);
        if (!fits(o)) throw new Error(`${labelOf(ep, o)} can't do ${opts.task}`);
        out.push({ offeringId: o.id });
      }
    }
    return out;
  }

  private check(userId: string, ref: ModelRef, localOnly: boolean): void {
    this.checkList(userId, [ref], { kind: localOnly ? "local" : undefined, task: "chat" });
  }

  /** Follows redirects. Undefined for a removed model or group. */
  private follow(id: string): string | undefined {
    const db = this.self();
    for (let hops = 0; hops < 16; hops++) {
      const r = db.prepare("SELECT to_id FROM offering_redirects WHERE from_id = ?").get(id) as { to_id: string | null } | undefined;
      if (!r) return id;
      if (!r.to_id) return undefined;
      id = r.to_id;
    }
    return undefined;
  }

  // --- Storage ---

  private catalog(userId: string): Catalog {
    const now = Date.now();
    const read = (db: Db, shared: boolean) => ({
      endpoints: (db.prepare("SELECT * FROM endpoints ORDER BY name").all() as EndpointRow[]).map((r) => toEndpoint(r, shared, now)),
      offerings: (db.prepare("SELECT * FROM offerings ORDER BY model").all() as OfferingRow[]).map((r) => toOffering(r, now)),
      groups: (db.prepare("SELECT * FROM model_groups ORDER BY name").all() as GroupRow[]).map((r) => toGroup(r, shared)),
    });
    const own = this.withUser(userId, (db) => read(db, false));
    const shared = read(this.self(), true);
    // A plan's chat models don't make images, whatever an older switch set: its image model does.
    const plans = new Set([...own.endpoints, ...shared.endpoints].filter((e) => isPlan(e.api)).map((e) => e.id));
    for (const o of [...own.offerings, ...shared.offerings]) {
      if (plans.has(o.endpointId) && o.modelId !== PLAN_IMAGE_MODEL) { delete o.image; delete o.edit; delete o.upscale; delete o.video; delete o.animate; delete o.motion; delete o.useFor; }
    }
    return {
      endpoints: new Map([...own.endpoints, ...shared.endpoints].map((e) => [e.id, e])),
      offerings: new Map([...own.offerings, ...shared.offerings].map((o) => [o.id, o])),
      groups: new Map([...own.groups, ...shared.groups].map((g) => [g.id, g])),
    };
  }

  /** Members must exist, be on different endpoints, and for a shared group be shared. */
  private checkMembers(userId: string, members: string[], shared: boolean): string[] {
    const c = this.catalog(userId);
    const endpoints = new Set<string>();
    const out: string[] = [];
    for (const id of members) {
      const o = c.offerings.get(id);
      if (!o) throw new NoModel(`no model ${id}`);
      const ep = c.endpoints.get(o.endpointId)!;
      if (shared && !ep.shared) throw new Error("a shared group takes shared models only");
      if (endpoints.has(ep.id)) throw new Error(`a group holds one copy per endpoint, and ${ep.name} is already in it`);
      endpoints.add(ep.id);
      out.push(id);
    }
    return out;
  }

  /**
   * A call to the endpoint succeeded: it isn't down, so it can't go stale.
   * Stale counts only failures with no success since.
   */
  reportUp(userId: string, endpointId: string): void {
    this.health.set(endpointId, { up: true, at: Date.now() });
    const sql = "UPDATE endpoints SET down_since = NULL WHERE id = ? AND down_since IS NOT NULL";
    if (this.isShared(endpointId)) this.self().prepare(sql).run(endpointId);
    else this.withUser(userId, (db) => db.prepare(sql).run(endpointId));
  }

  private isShared(endpointId: string): boolean {
    return !!this.self().prepare("SELECT 1 FROM endpoints WHERE id = ?").get(endpointId);
  }

  /**
   * A saved workflow's models as offering IDs, so renaming an endpoint breaks
   * nothing and the IDs are indexed and rewritten like any list. A name that
   * isn't one of the user's models is refused.
   */
  workflowSpec<T>(userId: string, spec: T): T {
    const name = (v: unknown) => {
      const ref = typeof v === "string" ? this.find(userId, v) : undefined;
      if (!ref) throw new NoModel(`no model ${String(v)}; name it as <endpoint>/<model>`);
      return refId(ref);
    };
    const s = JSON.parse(JSON.stringify(spec ?? {})) as { chain?: { model?: string }[]; council?: { models?: string[] } };
    for (const step of s.chain ?? []) if (step.model) step.model = name(step.model);
    if (s.council?.models) s.council.models = s.council.models.map(name);
    return s as T;
  }

  /** Records this user's shared references again, after something outside the router (a saved workflow) changed them. */
  reindex(userId: string): void {
    this.withUser(userId, (db) => this.index(userId, db));
  }

  /** Records whether an endpoint answered, for stale and for the router's health cache. */
  private seen(ep: Endpoint, up: boolean, userId: string): void {
    this.health.set(ep.id, { up, at: Date.now() });
    const sql = up ? "UPDATE endpoints SET down_since = NULL WHERE id = ?" : "UPDATE endpoints SET down_since = ? WHERE id = ? AND down_since IS NULL";
    const args = up ? [ep.id] : [new Date().toISOString(), ep.id];
    if (ep.shared) this.self().prepare(sql).run(...args);
    else this.withUser(userId, (db) => db.prepare(sql).run(...args));
  }

  private setting(userId: string, key: string): string | undefined {
    return this.withUser(userId, (db) => (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value);
  }

  private setSetting(userId: string, key: string, value: string): void {
    this.withUser(userId, (db) => db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value));
  }

  private threadChoice(userId: string, threadId: string, column: "preset" | "thinking" | "fallback" | "context", value: string | number | null): void {
    this.withUser(userId, (db) => {
      db.prepare("INSERT OR IGNORE INTO thread_choices (thread) VALUES (?)").run(threadId);
      db.prepare(`UPDATE thread_choices SET ${column} = ? WHERE thread = ?`).run(value, threadId);
    });
  }

  private self(): Db { return this.keyring.self(); }

  private withUser<T>(userId: string, fn: (db: Db) => T): T {
    const self = this.self();
    const db = this.users.openUserDb(userId);
    try {
      this.sync(userId, db, self);
      if (!this.ready.has(userId)) { this.index(userId, db); this.ready.add(userId); }
      return fn(db);
    } finally {
      db.close();
    }
  }

  /** Applies the shared redirects this user hasn't applied yet, then drops redirects nobody still needs. */
  private sync(userId: string, db: Db, self: Db): void {
    const pending = self.prepare("SELECT r.from_id, r.label FROM redirect_pending p JOIN offering_redirects r ON r.from_id = p.from_id WHERE p.user = ?")
      .all(userId) as { from_id: string; label: string }[];
    if (!pending.length) return;
    const map = new Map(pending.map((r) => [r.from_id, this.follow(r.from_id) ?? null]));
    const labels = new Map(pending.map((r) => [r.from_id, r.label]));
    // The rewrite and its notice together; if anything stops before the pending rows go, the rewrite runs again and changes nothing.
    db.transaction(() => {
      const lines = rewrite(db, map, (id) => labels.get(id) ?? id, (id) => this.labelIn(self, id));
      if (lines.length) addNotice(db, lines);
    })();
    const done = self.prepare("DELETE FROM redirect_pending WHERE from_id = ? AND user = ?");
    const unused = self.prepare("DELETE FROM offering_redirects WHERE from_id = ? AND NOT EXISTS (SELECT 1 FROM redirect_pending WHERE from_id = ?)");
    self.transaction(() => { for (const r of pending) { done.run(r.from_id, userId); unused.run(r.from_id, r.from_id); } })();
    this.index(userId, db);
  }

  /** Records which shared models and groups this user's lists name: shared offerings and groups, and redirected IDs, only. */
  private index(userId: string, db: Db): void {
    const self = this.self();
    const shared = new Set((self.prepare("SELECT id FROM offerings UNION SELECT id FROM model_groups UNION SELECT from_id FROM offering_redirects").all() as { id: string }[]).map((r) => r.id));
    const refs = [...collectRefs(db).keys()].filter((id) => shared.has(id));
    self.transaction(() => {
      self.prepare("DELETE FROM shared_refs WHERE user = ?").run(userId);
      const add = self.prepare("INSERT OR IGNORE INTO shared_refs (user, ref) VALUES (?, ?)");
      for (const r of refs) add.run(userId, r);
      self.prepare("INSERT OR IGNORE INTO shared_refs_indexed (user) VALUES (?)").run(userId);
    })();
  }

  /** Where this user's own lists use each offering or group. */
  private uses(userId: string): Map<string, Use[]> {
    return this.withUser(userId, (db) => collectRefs(db));
  }

  /** A model's or group's label as stored in `db`, with `prefix` (`shared.` for self.db). */
  private labelIn(db: Db, id: string, prefix = SHARED): string | undefined {
    const o = db.prepare("SELECT e.name, o.model FROM offerings o JOIN endpoints e ON e.id = o.endpoint WHERE o.id = ?").get(id) as { name: string; model: string } | undefined;
    if (o) return `${prefix}${o.name}/${o.model}`;
    const g = db.prepare("SELECT name FROM model_groups WHERE id = ?").get(id) as { name: string } | undefined;
    return g && `the group ${prefix}${g.name}`;
  }

  /**
   * Retires offerings or groups: `pairs` lists each from → to (null for
   * removed), then `change` runs in the same transaction. A personal one's
   * owner rewrites their lists at once; a shared one's redirects are followed
   * at once and wait for each user, who rewrites their lists at their next
   * open. Shared groups are rewritten at once.
   */
  private retire(actor: User, shared: boolean, pairs: (db: Db) => [string, string | null][], change: (db: Db) => void): void {
    if (shared) {
      if (!this.users.get(actor.id)?.admin) throw new Forbidden("only an administrator can change shared endpoints and groups");
      this.retireShared(pairs, change);
      return;
    }
    this.withUser(actor.id, (db) => {
      db.transaction(() => {
        const list = pairs(db);
        const labels = new Map(list.map(([from]) => [from, this.labelIn(db, from, "") ?? from]));
        change(db);
        rewrite(db, new Map(list), (id) => labels.get(id) ?? id, (id) => this.labelIn(db, id, "") ?? this.labelIn(this.self(), id));
      })();
      this.index(actor.id, db);
    });
  }

  /** The shared half of retire: redirects every user's lists catch up with, and shared groups rewritten now. */
  private retireShared(pairs: (db: Db) => [string, string | null][], change: (db: Db) => void): void {
    const self = this.self();
    const users = this.users.all();
    self.transaction(() => {
      const list = pairs(self);
      const now = new Date().toISOString();
      for (const [from, to] of list) {
        // Earlier redirects to `from` now point straight at its target, so chains stay one hop long and can't loop.
        self.prepare("UPDATE offering_redirects SET to_id = ? WHERE to_id = ?").run(to, from);
        self.prepare("INSERT OR REPLACE INTO offering_redirects (from_id, to_id, label, created_at) VALUES (?, ?, ?, ?)").run(from, to, this.labelIn(self, from) ?? from, now);
        for (const u of users) self.prepare("INSERT OR IGNORE INTO redirect_pending (from_id, user) VALUES (?, ?)").run(from, u.id);
      }
      change(self);
      const map = new Map(list);
      moveSettings(self, map);
      for (const g of self.prepare("SELECT id, members FROM model_groups").all() as { id: string; members: string }[]) {
        const next = mapMembers(JSON.parse(g.members), map);
        if (next) self.prepare("UPDATE model_groups SET members = ? WHERE id = ?").run(JSON.stringify(next), g.id);
      }
    })();
  }

  /** Shared endpoints change only with an administrator; own endpoints, only as their user. */
  private write(actor: User, endpointId: string, fn: (db: Db) => void): void {
    if (this.isShared(endpointId)) {
      if (!this.users.get(actor.id)?.admin) throw new Forbidden("only an administrator can change shared endpoints");
      return fn(this.self());
    }
    this.withUser(actor.id, (db) => {
      if (!db.prepare("SELECT 1 FROM endpoints WHERE id = ?").get(endpointId)) throw new Error(`no endpoint ${endpointId}`);
      fn(db);
    });
  }

  private place(actor: User, shared: boolean, fn: (db: Db) => void): void {
    if (!shared) return this.withUser(actor.id, fn);
    if (!this.users.get(actor.id)?.admin) throw new Forbidden("only an administrator can change shared endpoints and groups");
    fn(this.self());
  }
}

/** A plan's sign-in must carry its tokens and expiry; anything else is refused before it's saved. */
function checkCredential(c: PlanCredential): PlanCredential {
  if (typeof c?.access !== "string" || !c.access || typeof c.refresh !== "string" || !c.refresh || typeof c.expires !== "number") {
    throw new Error("a plan's sign-in needs its access and refresh tokens and when it expires");
  }
  const { type: _t, ...rest } = c;
  return rest as PlanCredential;
}

/** Tasks a hand-set switch can take away from a model, and the capability each needs. */
const DROPPABLE: [Task, (o: Offering) => boolean][] = [
  ["image.create", (o) => !!o.image], ["image.edit", (o) => !!o.edit], ["image.upscale", (o) => !!o.upscale], ["speech.transcribe", (o) => !!o.transcribe],
];
/** What to call a model: an image model (a host recipe, or a plan's image tool) by its name, anything else by its model ID. */
export const modelName = (o: { modelId: string; recipe?: string }) => o.recipe ?? o.modelId;
const labelOf = (ep: Endpoint, o: Offering) => `${ep.shared ? SHARED : ""}${ep.name}/${modelName(o)}`;

function checkName(name: string): void {
  if (!NAME.test(name)) throw new Error("endpoint names use letters, digits and '-'");
}

function checkAddresses(addresses: string[]): string[] {
  const list = (Array.isArray(addresses) ? addresses : []).map((a) => String(a).trim()).filter(Boolean);
  if (!list.length) throw new Error("a model host needs at least one address");
  for (const a of list) hostOrigin(a);
  return list;
}

function checkGroupName(name: string): string {
  const n = String(name ?? "").trim();
  if (!n || n.length > 80) throw new Error("a group needs a name of up to 80 characters");
  return n;
}

function checkPresetName(name: string): string {
  const n = String(name ?? "").trim();
  if (!n || n.length > 40) throw new Error("a preset needs a name of up to 40 characters");
  if (n.toLowerCase() === "custom") throw new Error("a preset can't be called Custom");
  return n;
}

/** The level in `levels` nearest `asked`; between two equally near, the lower. */
function nearestLevel(levels: readonly Exclude<ThinkingLevel, "off">[], asked: ThinkingLevel): Exclude<ThinkingLevel, "off"> | undefined {
  const at = THINKING_LEVELS.indexOf(asked);
  return [...levels].sort((a, b) => Math.abs(THINKING_LEVELS.indexOf(a) - at) - Math.abs(THINKING_LEVELS.indexOf(b) - at) || THINKING_LEVELS.indexOf(a) - THINKING_LEVELS.indexOf(b))[0];
}

function checkThinking(level: string): ThinkingLevel {
  if (!THINKING_LEVELS.includes(level as ThinkingLevel)) throw new Error("thinking is off, low, medium or high");
  return level as ThinkingLevel;
}

/** A speech model's voices, set by hand: each an ID and a language tag, at most 200. */
function checkVoices(voices: unknown): Voice[] {
  if (!Array.isArray(voices) || voices.length > 200) throw new Error("voices is a list of up to 200 { id, language }");
  return voices.map((v) => {
    const { id, language } = (v ?? {}) as { id?: unknown; language?: unknown };
    if (typeof id !== "string" || !id || id.length > 100) throw new Error("a voice's id is up to 100 characters");
    if (typeof language !== "string" || !LANGUAGE.test(language)) throw new Error("a voice's language is a tag such as en or zh");
    return { id, language: language.toLowerCase() };
  });
}

/** A host's voices, as discovery reports them; anything malformed is left out. */
function hostVoices(voices: unknown): Voice[] {
  return (Array.isArray(voices) ? voices : []).flatMap((v) => { try { return checkVoices([v]); } catch { return []; } }).slice(0, 200);
}

/**
 * A base URL as it is stored. One without a scheme gets http:// for a local
 * endpoint and https:// for a cloud one; one with no path gets /v1, the
 * OpenAI-compatible root, so "10.0.0.5:1234" saves as http://10.0.0.5:1234/v1.
 * A path that is given is kept as written.
 */
function checkUrl(baseUrl: string, kind: "cloud" | "local"): string {
  let raw = baseUrl.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `${kind === "cloud" ? "https" : "http"}://${raw}`;
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("the base URL isn't a valid URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("the base URL must be http or https");
  raw = raw.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)\/*(?=[?#]|$)/i, "$1/v1");
  return raw.replace(/\/+$/, "");
}

const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** A download request checked as the host would (host/API.md "Downloads"), so a bad one is refused here with the reason. */
function downloadBody(b: unknown): { source: Hub; repo: string; revision?: string; files: string[] } | { source: "url"; url: string; sha256?: string } {
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error("send { source, repo, files } or { source: \"url\", url }");
  const d = b as Record<string, unknown>;
  if (d.source === "url") {
    const url = typeof d.url === "string" ? d.url : "";
    let u: URL;
    try { u = new URL(url); } catch { throw new Error("that isn't a link"); }
    if (u.protocol !== "https:") throw new Error("a link must be https");
    if (url.length > 1024) throw new Error("a link is at most 1024 characters");
    if (u.username || u.password) throw new Error("a link can't carry a user name or password");
    if (d.sha256 !== undefined && (typeof d.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(d.sha256))) throw new Error("sha256 is 64 hex characters");
    return { source: "url", url, ...(d.sha256 ? { sha256: d.sha256 as string } : {}) };
  }
  if (d.source !== "huggingface" && d.source !== "modelscope") throw new Error("source is huggingface, modelscope or url");
  if (typeof d.repo !== "string" || !d.repo.trim()) throw new Error("say which repository");
  if (!Array.isArray(d.files) || !d.files.length || !d.files.every((f) => typeof f === "string" && f)) throw new Error("say which files");
  if (d.revision !== undefined && (typeof d.revision !== "string" || !d.revision)) throw new Error("revision is a branch, tag or commit");
  return { source: d.source, repo: d.repo.trim(), files: d.files as string[], ...(d.revision ? { revision: d.revision as string } : {}) };
}

/** Whether a file in the download record belongs to a copy: its file, a file in its folder, or another shard of a split GGUF. */
function copyFile(modelId: string, path: string): boolean {
  if (path === modelId || path.startsWith(`${modelId}/`)) return true;
  const split = /^(.*)-00001-of-(\d{5})\.gguf$/.exec(modelId);
  return !!split && new RegExp(`^${split[1]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d{5}-of-${split[2]}\\.gguf$`).test(path);
}

type CallRow = {
  at: string; pool: Pool; thread: string; task: Task; offering: string; label: string; endpoint: string; kind: "cloud" | "local"; fallback: string | null; note: string | null;
  read_tokens: number | null; prompt_tokens: number | null; output_tokens: number | null; window: number | null; ttft_ms: number | null; gen_ms: number | null; processed: number | null;
  audio_seconds?: number | null;
};

const toCall = (r: CallRow): CallRecord => ({
  at: r.at, pool: r.pool, threadId: r.thread, task: r.task, offeringId: r.offering, label: r.label, endpointName: r.endpoint, kind: r.kind,
  ...(r.fallback ? { fallback: r.fallback } : {}), ...(r.note ? { note: r.note } : {}),
  ...(typeof r.audio_seconds === "number" ? { audioSeconds: r.audio_seconds } : {}),
  ...(r.gen_ms !== null ? { pace: speeds({ ...(r.read_tokens != null ? { readTokens: r.read_tokens } : {}), promptTokens: r.prompt_tokens ?? 0, outputTokens: r.output_tokens ?? 0, window: r.window ?? 0, ttftMs: r.ttft_ms ?? 0, genMs: r.gen_ms, processed: r.processed ?? 0 }) } : {}),
});

/** A host status whose updater is at work (host/API.md, "POST /host/v1/update"). */
function updating(status: unknown): boolean {
  return ["requested", "fetching", "draining", "building", "rolling-back"].includes((status as { update?: { state?: string } }).update?.state ?? "");
}
