// lyricad's HTTP and SSE API. Every request, response and event type is here;
// the web UI imports these types only. Routes are listed beside their types.
//
// Conventions:
// - JSON in and out, except uploads (raw bytes) and the event stream (SSE).
// - Errors are `ApiError` with a status: 400 refused (with the reason), 401 not
//   logged in, 403 not allowed, 404 not found, 409 conflict, 413 too large,
//   429 slowed down, 503 locked.
// - Every state-changing request (POST, PUT, PATCH, DELETE) needs the session
//   cookie and an `Origin` header matching the host. Unlock and login need only
//   the Origin.
// - A browser session can hold several users (a person's personas). Everything a user
//   owns is under `/api/u/:userId/…`, and that user must be logged in on this
//   browser session.
// - Path segments are URI-encoded: thread IDs contain "/" (`web/3f7a2c`), so
//   `/threads/general/web%2F3f7a2c`.

// --- Shared vocabulary (mirrors @lyrica/core, kept here so the UI needs no core import) ---

export type Pool = "general" | "private";
export type Interface = "web" | "cli" | "matrix" | "forum" | "sleep";
/** What a model preset may hold: private is local models only; general mixes freely. */
export type PresetScope = "private" | "general";
/** The Models page's two columns. */
export type Column = "private" | "general";
export type Task =
  | "chat" | "subagent.cheap" | "subagent.strong" | "compaction"
  | "title" | "watching" | "embedding" | "sleep.consolidate" | "sleep.dream" | "sleep.wake"
  | "image.create" | "image.edit" | "image.upscale" | "speech.transcribe" | "speech.speak";
/** The tasks a thread can choose models for. Compaction isn't one: Pi compacts with the thread's chat model. */
export const THREAD_TASKS = ["chat", "subagent.cheap", "subagent.strong", "title", "watching", "image.create", "image.edit", "image.upscale", "speech.transcribe", "speech.speak"] as const satisfies readonly Task[];
export type ThreadTask = (typeof THREAD_TASKS)[number];

/** One model on one endpoint, by its permanent offering ID, or a model group, which expands into its members in order. */
export type ModelRef = { offeringId: string } | { groupId: string };
export type ThinkingLevel = "off" | "low" | "medium" | "high";
/** A preset's entry for a task: an ordered list, or another task's list (Same as). */
export type Entry = ModelRef[] | { same: Task };
export interface Pronouns { subj: string; obj: string; poss: string; possPro: string; refl: string }
export type Theme = "device" | "light" | "dark";
/** "auto" works freely inside the grants; "acceptEdits" asks before bash; "ask" before bash, write and edit; "plan" only reads. */
export type PermissionMode = "auto" | "acceptEdits" | "ask" | "plan";
/** The modes an approved plan can go ahead in. */
export type GoAhead = "ask" | "acceptEdits" | "auto";
export interface Network { internet: boolean; services: boolean; hosts: string[] }
export interface Grant { path: string; writable: boolean }

export interface ApiError { error: string }
export interface Ok { ok: true }

// --- State, unlock and login ---

/** A user as the persona switcher shows them. */
export interface UserCard {
  id: string;
  login: string;
  displayName: string;
  pronouns: Pronouns;
  accent?: string;
  monogram?: string;
  admin: boolean;
}

/** GET /api/state. Answers while locked and while setting up. */
export interface State {
  locked: boolean;
  /** Setting up: there is no self.db yet, and only this and POST /api/setup answer. `locked` is true too. */
  setup?: boolean;
  /** Her name for this deployment (default Lyrica), in every state. */
  name: string;
  /** Setting up: whether this machine can save the passphrase (Start unlocked), and why not. */
  credentials?: { available: boolean; reason?: string };
  /** Users logged in on this browser session. Empty while locked. */
  users: UserCard[];
  /** lyricad's version (package.json) and build (the git commit it was built from, or "dev"). Shown in the header; absent while locked. */
  version?: string;
  build?: string;
}

/** POST /api/unlock → State. Only while locked. */
export interface UnlockRequest { passphrase: string }

/**
 * POST /api/setup → LoginResponse. Only while setting up: creates self.db, the persona, her name and the
 * first administrator, unlocks, and logs that administrator in. `code` is the one-time setup code
 * (`lyrica admin setup-code`); a wrong one is 403 and counts like a wrong passphrase. `saveCredentials`
 * saves the passphrase so lyricad starts unlocked ("Start unlocked").
 */
export interface SetupRequest {
  code: string;
  passphrase: string;
  saveCredentials?: boolean;
  /** Her name, default Lyrica. */
  name?: string;
  admin: { login: string; password: string; displayName: string; pronouns?: Pronouns };
}

/**
 * POST /api/login → LoginResponse. Adds the user to this browser session (creating it if needed).
 * One browser, one person: if the session holds users this one isn't linked to, it ends first and a new one starts.
 */
export interface LoginRequest { login: string; password: string }
export interface LoginResponse {
  user: UserCard;
  /** This browser held users not linked to this one; they were logged out of it (they aren't named). */
  replaced: boolean;
}

/**
 * POST /api/logout → LogoutResponse. Ends the cookie session, or with `userId` removes only that user from it
 * (a session left empty ends).
 * A user's key stays in memory unless they turned "stay unlocked" off and no other browser session holds them.
 */
export interface LogoutRequest { userId?: string }
/** POST /api/logout → LogoutResponse */
export interface LogoutResponse {
  ok: true;
  /** Users who left but stay unlocked, because another browser session still holds them. */
  stillUnlocked: string[];
}

/** POST /api/u/:userId/lock → Ok. Drops the user's key and every session of theirs, in every browser. */

// --- The signed-in user: /api/u/:userId/me ---

/** How the sidebar orders threads: by date (grouped Today, Yesterday, …), last activity, start date, title, or the user's own groups. */
export type ThreadSort = "date" | "activity" | "started" | "title" | "groups";

export interface Display {
  theme: Theme;
  showGeneral: boolean;
  showPrivate: boolean;
  showHidden: boolean;
  sort: ThreadSort;
  /** The thread list's third part: every thread, only projects (with their threads), or none of them. */
  projects: "all" | "only" | "none";
  /** Her threads keep a checklist the cards show (`threads steps`). Off, she isn't offered it and cards show none. */
  checklists: boolean;
}

/** GET /api/u/:userId/me */
export interface Me {
  user: UserCard;
  previousNames: { name: string; until: string }[];
  display: Display;
  /** Whether this user's key is saved with systemd credentials, so it's unlocked at startup. */
  savedCredentials: boolean;
  /** Whether logging out keeps the key in memory, so sleep can run. On by default; Lock always drops it. */
  stayUnlocked: boolean;
  /** Something the user should know, in plain words: saved credentials with stay-unlocked off; an administrator set their password. */
  warning?: string;
}

/** PUT /api/u/:userId/me/stay-unlocked → Me */
export interface StayUnlockedChange { stayUnlocked: boolean }

/**
 * Linked users belong to the same person: one browser may hold them together.
 * GET /api/u/:userId/links → UserCard[]
 * POST /api/u/:userId/links → UserCard[]. Needs both passwords: this user's and the other's.
 * DELETE /api/u/:userId/links/:otherId → UserCard[]. Sessions holding both keep only this user.
 */
export interface LinkRequest { password: string; login: string; otherPassword: string }

/**
 * A persona proposal from this user's conversations or dreams, kept in their own
 * encrypted user.db until they send it on. Administrators never see drafts.
 * GET /api/u/:userId/proposals → ProposalDraft[]
 * PATCH /api/u/:userId/proposals/:id (ProposalDraftChange) → ProposalDraft
 * DELETE /api/u/:userId/proposals/:id → Ok
 * POST /api/u/:userId/proposals/:id/send → Ok: copied to the administrators' list, and the draft goes.
 */
export interface ProposalDraft { id: number; path: string; text: string; reason: string; author: string; createdAt: string }
export interface ProposalDraftChange { text?: string; reason?: string }

/** PATCH /api/u/:userId/me/profile → Me. Accent is "#rrggbb"; the monogram is one or two letters. */
export interface ProfileChange {
  displayName?: string;
  pronouns?: Pronouns;
  accent?: string | null;
  monogram?: string | null;
}

/** PATCH /api/u/:userId/me/display → Me */
export type DisplayChange = Partial<Display>;

/** POST /api/u/:userId/me/password → Ok */
export interface PasswordChange { oldPassword: string; newPassword: string }

/** PUT /api/u/:userId/me/credentials → Me. Saves or forgets this user's key in systemd credentials. */
export interface CredentialsChange { save: boolean }

// --- Endpoints and model presets ---

/** What a model can do: discovered where the endpoint says, else set by hand. */
export interface Capabilities {
  useFor?: "fast" | "quality" | "both";
  contextWindow?: number; tools?: boolean; vision?: boolean; embedding?: boolean; image?: boolean; edit?: boolean; upscale?: boolean;
  /** The thinking levels it offers, besides off. */
  reasoning?: ("low" | "medium" | "high")[];
  /** Speech to text (Dictation). */
  transcribe?: boolean;
  /** Text to speech (Read aloud): its voices, each with the language it speaks ("en", "zh"). */
  speak?: { voices: Voice[] };
}
/** One of a speech model's voices, with the language it speaks: a primary tag such as "en" or "zh". */
export interface Voice { id: string; language: string }

/** One model an endpoint offers. */
export interface OfferingInfo extends Capabilities {
  /** Permanent. */
  id: string;
  /** The endpoint's own model ID. */
  modelId: string;
  /** `<endpoint>/<model>`, with `shared.` before a shared endpoint's name; a host recipe by its name. */
  label: string;
  manual: boolean;
  /** missing: the endpoint stopped listing it; gone: missing for 30 days, so fallbacks skip it. */
  status: "listed" | "missing" | "gone";
  missingSince?: string;
  /** The file's checksum, from a host: the strong group suggestion. */
  digest?: string;
  /** What the model is, from a host's GGUF metadata or the hub's model card. */
  identity?: {
    basename?: string | null; sizeLabel?: string | null; finetune?: string | null;
    baseModels?: { name?: string; organization?: string; repoUrl?: string }[] | null;
    card?: { baseModel?: string[]; baseModelRelation?: string | null } | null;
  };
  /** The host downloaded it itself, so it can be deleted. */
  downloaded?: boolean;
  /** Bytes, from a host. */
  size?: number;
  /** An image model on a host: the confirmed recipe's name. */
  recipe?: string;
  /** Moved to a library entry of its own (Not this model). */
  separate?: boolean;
}

export interface EndpointInfo {
  /** Permanent. Editing the endpoint never changes it. */
  id: string;
  /** A label that can change. */
  name: string;
  kind: "cloud" | "local";
  /** A plain OpenAI-compatible server, a paired model host (always local), or a ChatGPT or Grok plan (always cloud, never shared). */
  api: "openai-compatible" | "host" | "chatgpt" | "grok";
  /** Query values named like a credential show as •••; sent back unchanged in a PATCH, they keep the stored value. */
  baseUrl: string;
  /** A host's addresses, tried in order. */
  addresses?: string[];
  /** A host's pinned key fingerprint. */
  fingerprint?: string;
  /** Full API keys are never sent back. */
  hasApiKey: boolean;
  /** Masked display only: the last four characters, omitted for short keys and plans. */
  keyLast4?: string;
  /** Explicit account label returned by plan sign-in, if supplied; never a token. */
  planAccount?: string;
  /** Cloud row pills; Image includes adapter support and an API key where required. */
  cloudCapabilities?: ("Text" | "Vision" | "Image")[];
  shared: boolean;
  /** A local endpoint over plain HTTP outside this machine and the tailnet. */
  unencrypted: boolean;
  /** Unreachable for 14 days. Fallbacks skip it. */
  stale: boolean;
  downSince?: string;
  /** A plan whose sign-in lapsed: Sign in again. Fallbacks skip it. */
  signedOut?: boolean;
  /** When a plain endpoint or plan was paused by hand. Fallbacks skip it until it is resumed. */
  pausedAt?: string;
  models: OfferingInfo[];
}

/** GET /api/u/:userId/endpoints → EndpointInfo[] (own, then shared) */
/** POST /api/u/:userId/endpoints → EndpointInfo. `shared` needs an administrator. */
export interface EndpointInput { name: string; kind: "cloud" | "local"; baseUrl: string; apiKey?: string; shared?: boolean }
/** PATCH /api/u/:userId/endpoints/:endpointId → EndpointInfo. Keeps every ID. `apiKey: null` removes the key. */
/** `paused` pauses or resumes a plain endpoint or plan: fallbacks skip it while paused. A host pauses itself (…/hosts/:endpointId/pause). */
export interface EndpointChange { name?: string; baseUrl?: string; apiKey?: string | null; paused?: boolean }
/** DELETE /api/u/:userId/endpoints/:endpointId → Ok. Its models leave tombstones. */
/** POST /api/u/:userId/endpoints/:endpointId/discover → EndpointInfo. Re-reads /v1/models; models no longer listed are marked missing. */
/** POST /api/u/:userId/endpoints/:endpointId/models → OfferingInfo. Adds a model by hand. */
export interface ModelInput extends Capabilities { modelId: string }
/** GET /api/u/:userId/endpoints/:endpointId/probe → Probe */
/**
 * POST /api/u/:userId/plans/sign-in → PlanSignInStarted. Starts a plan's sign-in for a new plan
 * (`plan` and `name`) or one that is signed out (`endpointId`). One at a time per user, for 10 minutes.
 * `url` is the provider's page to open; Grok's `code` is the code that page asks for.
 */
export interface PlanSignInStart { plan?: "chatgpt" | "grok"; name?: string; endpointId?: string }
export interface PlanSignInStarted { id: string; url: string; code?: string }
/**
 * POST /api/u/:userId/plans/sign-in/:signInId → EndpointInfo, once the provider confirms. ChatGPT's
 * `redirectUrl` is the address the browser was sent to after approving
 * (http://127.0.0.1:1455/auth/callback?…); Grok needs none. DELETE cancels it → Ok.
 */
export interface PlanSignInFinish { redirectUrl?: string }
/**
 * POST /api/u/:userId/openrouter/sign-in → PlanSignInStarted (`id`, `url`). Starts OpenRouter's sign-in for a
 * new cloud endpoint (`name`, and `shared` for an administrator). One at a time per user, for 10 minutes.
 * POST …/:signInId (`OpenRouterSignInFinish`, the `code` its page showed) → EndpointInfo; the key it
 * returns is stored like any API key. DELETE cancels it → Ok.
 */
export interface OpenRouterSignInStart { name: string; shared?: boolean }
export interface OpenRouterSignInFinish { code: string }
export interface Probe { state: "up" | "down"; warning?: string }
/** POST /api/u/:userId/endpoints/:endpointId/reset-ids → EndpointInfo. Fresh IDs, with redirects from the old ones. */
/** POST /api/u/:userId/endpoints/:endpointId/merge → EndpointInfo (the one merged into). */
export interface MergeInput { into: string }

/**
 * POST /api/u/:userId/hosts → EndpointInfo. Pairs a model host with the code
 * its dashboard shows (host/PAIRING.md), pins its key and reads its models.
 * `shared` needs an administrator. Unpair with DELETE …/endpoints/:endpointId.
 */
export interface HostInput { name: string; addresses: string[]; code: string; shared?: boolean }
/** POST /api/u/:userId/hosts/:endpointId/pair → EndpointInfo. Pairs again after the host's key changed; every ID stays. */
export interface HostRepair { code: string }
/** PUT /api/u/:userId/hosts/:endpointId/addresses → EndpointInfo. Trust stays with the key. */
export interface HostAddresses { addresses: string[] }
/** A host's status, as it reports it (host/API.md, GET /host/v1/status). */
export interface HostStatus {
  name: string; version: string; fingerprint: string;
  /** The commit the host runs, as its installer recorded it; absent on a host from before updates. */
  commit?: string;
  /** Its updater: absent on a host from before updates. */
  update?: HostUpdate;
  state: "running" | "pausing" | "paused" | "restarting";
  gpus: {
    index: number; name: string; vendor: string; role: "vllm" | "shared";
    vram: { total: number; used: number };
    models: { id: string; kind: string; state: string; pinned: boolean; busy: boolean; vram: number | null; lastUsed: string | null }[];
    queue: { chat: number; image: number; background: number };
  }[];
  downloads: { active: number };
  modelsFolder: { path: string; free: number };
}
/** GET /api/u/:userId/hosts/:endpointId/status → HostStatus */
/** POST /api/u/:userId/hosts/:endpointId/pause|resume|restart → HostStatus. A shared host needs an administrator. */
/** POST /api/u/:userId/hosts/:endpointId/update → HostStatus. Asks the host to update to the release Lyrica runs (409 when she runs none). A shared host needs an administrator. */

/** A model host's updater (host/API.md, "POST /host/v1/update"). */
export interface HostUpdate {
  available: boolean;
  /** Why not, in words for the person. */
  reason?: string;
  state: "idle" | "requested" | "fetching" | "draining" | "building" | "rolling-back" | "failed";
  since?: string;
  tag?: string;
  /** The step that failed: fetch, drain, probation, … */
  error?: string;
  last?: { tag: string; commit: string; at: string; ok: boolean };
}

/** How a model answers. Unset values aren't sent, so the server's default applies. */
export interface AnswerSettings {
  temperature?: number; topP?: number; topK?: number; minP?: number; repeatPenalty?: number;
  presencePenalty?: number; frequencyPenalty?: number; maxTokens?: number; seed?: number; stop?: string[];
  /** A speech model's voice per language tag, from its `speak.voices`: { en: "af_heart", zh: "zf_xiaobei" }. Yours for one language leaves the shared one for another. */
  voices?: Record<string, string>;
  /** A speech model's speed, 0.25 to 4. */
  speed?: number;
}
/** GET /api/u/:userId/offerings/:offeringId/settings → OfferingSettings: each value with its source. */
export interface OfferingSettings {
  values: AnswerSettings;
  /** shared: the shared model's value; yours: your own, which wins for you only. Anything absent is the server's default. */
  sources: Partial<Record<keyof AnswerSettings, "shared" | "yours">>;
  /** Saved values this endpoint's API doesn't take (OpenAI's has no top-k, for one), so they aren't sent. */
  dropped: (keyof AnswerSettings)[];
  /** The context window Lyrica plans by: a host's serving settings, else set by hand, else discovered. */
  contextWindow?: { value: number; source: "host" | "hand" | "discovered" };
}
/**
 * PUT /api/u/:userId/offerings/:offeringId/settings → OfferingSettings.
 * `shared` sets a shared model's values for everyone (administrators);
 * `mine` (the default) sets your own. null clears a value.
 */
export interface OfferingSettingsChange { scope?: "shared" | "mine"; values: { [K in keyof AnswerSettings]?: AnswerSettings[K] | null } }

// --- The model libraries, downloads and host management ---

export type Hub = "huggingface" | "modelscope";
/** One model in the text library, with its copies on every endpoint. */
export interface LibraryEntry {
  key: string; name: string;
  /** For a finetune, merge or adapter, or a copy flagged as maybe one: the model it derives from. */
  base?: { key: string; name: string };
  starred: boolean; groups: string[];
  copies: {
    offeringId: string; label: string;
    /** The file under the models folder, or the endpoint's model ID. */
    rawName: string;
    endpointId: string; endpointName: string; kind: "cloud" | "local"; shared: boolean;
    status: "listed" | "missing" | "gone";
    /** Lyrica downloaded it, so it can be deleted. */
    downloaded: boolean;
    capabilities: Capabilities; groups: string[];
    /** Why it may not be this model. */
    flagged?: string;
    size?: number;
    /** Its median speeds over the user's last twenty measured calls to it. */
    speed?: { tokPerSec?: number; promptTokPerSec?: number };
  }[];
}
/** GET /api/u/:userId/library/text?search=&kind=&endpoint=&capability=&groups=1&offset=&limit= → TextLibrary. Starred first. */
export interface TextLibrary { total: number; entries: LibraryEntry[] }
/** PUT /api/u/:userId/offerings/:offeringId/star { starred } → Ok. Per user. */
/** PUT /api/u/:userId/offerings/:offeringId/separate { separate } → Ok. "Not this model"; an administrator for a shared endpoint. */
/** POST /api/u/:userId/offerings/:offeringId/delete-copy { confirm? } → DeleteCopy. Without confirm, only where it's used. */
export interface DeleteCopy {
  usedIn: ModelUse[];
  deleted?: string[];
  /** Shards of a split file the host wouldn't delete (say, in use), with its reason. The copy is gone from every list anyway. */
  left?: { files: string[]; reason: string };
}
/** A hub token as the API shows it: never more than its last four characters. */
export interface HubTokenInfo { hub: Hub; shared: boolean; last4: string }
/** GET /api/u/:userId/hub-tokens → HubTokenInfo[]. PUT …/hub-tokens/:hub → HubTokenInfo[]. DELETE …/hub-tokens/:hub?shared=1 → HubTokenInfo[]. */
export interface HubTokenInput { token: string; shared?: boolean }
/** GET /api/u/:userId/hosts/:endpointId/hub/files?source=&repo=&revision= → the host's answer (host/API.md). A shared host needs an administrator. */
/** POST /api/u/:userId/hosts/:endpointId/downloads → the host's answer. GET lists them (a finished one becomes an offering at once); DELETE …/downloads/:id cancels or clears. */
export type DownloadInput = { source: Hub; repo: string; revision?: string; files: string[] } | { source: "url"; url: string; sha256?: string };
/** GET /api/u/:userId/hosts/:endpointId/images → { recipes, parts by role }, as the host reports them. */
/** POST /api/u/:userId/hosts/:endpointId/recipes/:recipeId → the host's answer. Confirmed recipes become image offerings. */
export type RecipeUseFor = "fast" | "quality" | "both";
/** change { op: "useFor", useFor } saves a recipe's create tiers on the host; absent defaults to both. */
export type RecipeAction = { do: "confirm" | "ignore" | "download-parts" | "delete" } | { do: "change"; change: Record<string, unknown> & { useFor?: RecipeUseFor } } | { do: "copy"; name: string };
/** GET /api/u/:userId/hosts/:endpointId/starters → { starters }: the host's starter recipes (host/API.md), each part `present` when it is on the host. */
export interface HostStarter {
  id: string; name: string; template: string;
  parts: { role: string; slot?: string; source: string; repo: string; path: string; sha256: string; size?: number; present: boolean }[];
  loras: { file: string; strength: number }[];
  defaults: Record<string, string | number>;
}
// POST /api/u/:userId/hosts/:endpointId/starters/:starterId/install → { recipe, downloads }: downloads what is missing, with the user's hub token, and confirms the recipe.
/** POST /api/u/:userId/hosts/:endpointId/manage → the host's answer. Loading, pinning, GPU settings, placements, scan, usage only. */
export interface HostManage { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; body?: unknown }
/** GET /api/u/:userId/hosts/:endpointId/dashboard → { url } */
/**
 * A host model's placement and serving settings, as host/API.md defines them:
 * `settings.stretch` is { type: "yarn", factor, originalContext } when set;
 * `maxContextLength` is the trained length times the stretch (Context
 * length's "of N"); `recommended` is what the model's card says, or null.
 */
export interface ServingSettings {
  model: string;
  settings: Record<string, unknown>;
  contextLength: number;
  maxContextLength: number | null;
  /** Original context's placeholder; null when the host couldn't read it, and then nothing can be stretched. */
  trainedContextLength: number | null;
  kvBytes: number | null;
  recommended: { native: number | null; stretched?: number; factor?: number; originalContext?: number; source: { hub: Hub; repo: string; revision: string; at: string } } | null;
  stretchUntested: boolean;
  /** What the drawer's Vision and MTP switches can turn off: a vision projector, and an MTP file or the model's own MTP layers. */
  extras?: { vision: boolean; mtp: "file" | "built-in" | null };
}
/**
 * GET /api/u/:userId/offerings/:offeringId/serving → ServingSettings. PUT { settings, anyway? } → the host's model entry; a placement that
 * can't work is refused with the host's reason, and a stretch above the card's with code "above_recommended" unless anyway is true (Save anyway).
 */
/**
 * POST /api/u/:userId/offerings/:offeringId/lookup { repo? } → ServingSettings with `recommended` read from the model's card. Code "need_repo":
 * the host doesn't know the repository, so name it (owner/name, modelscope:owner/name or a link). Administrator (shared host) or owner.
 */
/** POST /api/u/:userId/offerings/:offeringId/reload → the host's answer: applies saved settings now. A shared host needs an administrator. */
/** GET /api/u/:userId/models/page → ModelsPage: what the Models page shows, endpoints with live status. An endpoint seen down in the last 30 s isn't asked again; a cloud endpoint whose provider takes a real probe is asked at most every 90 s (local ones stay at 30 s); each gets 3 s. */
export interface ModelsPage {
  endpoints: (EndpointInfo & Probe)[];
  /** A host that is down says why; `unpaired` when it has revoked this server, so pairing again is the fix. */
  hosts: ({ endpointId: string; status: HostStatus } | { endpointId: string; error: string; unpaired?: true })[];
  presets: Presets;
  /** The newest call in the displayed pools; older ones come from /models/calls/history. */
  calls: CallInfo[];
  /** Each endpoint's call count over `model_calls` in the pools this page shows, not over `calls`; what ranks the sidebar's status panel. Endpoints with no calls aren't listed. */
  endpointUses: { endpointId: string; calls: number }[];
  notice: string[];
  /** How many items Clean up lists. */
  cleanup: number;
  /** The release Lyrica runs, when she runs one: a host whose commit differs can update to it. */
  release?: { tag: string; commit: string };
}

/** PATCH /api/u/:userId/offerings/:offeringId → OfferingInfo. Sets capabilities by hand; null clears one. */
export type CapabilitiesChange = { [K in keyof Capabilities]?: Capabilities[K] | null };
/** DELETE /api/u/:userId/offerings/:offeringId → Ok. Leaves a tombstone. */
/** POST /api/u/:userId/offerings/:offeringId/replace → Ok. Leaves a redirect to the replacement, of the same kind. */
export interface ReplaceInput { with: string }
/** GET /api/u/:userId/offerings/:offeringId/same → OfferingInfo[]: the same model on other endpoints of the same kind. */

/** Where one of the user's lists names a model. */
export type ModelUse =
  | { where: "preset"; presetId: string; name: string; task: Task }
  | { where: "column"; column: Column; task: Task }
  | { where: "thread"; pool: Pool; threadId: string; task: Task }
  | { where: "workflow"; name: string }
  | { where: "group"; groupId: string; name: string };

/** A stale endpoint (no offering), a gone model, or a group left empty, with where it is still used. */
export interface CleanupItem {
  endpoint?: { id: string; name: string; shared: boolean; downSince?: string };
  offering?: OfferingInfo;
  group?: { id: string; name: string; shared: boolean };
  label: string;
  usedIn: ModelUse[];
  /** How many other users' lists name it (shared only). */
  otherUsers: number;
  /** The same model on another endpoint, to pre-fill Replace with… */
  suggestion?: { offeringId: string; label: string };
}
/** GET /api/u/:userId/models/cleanup → CleanupItem[] */
/** GET /api/u/:userId/models/notice → ModelsNotice: lists rewritten since last dismissed. */
export interface ModelsNotice { lines: string[] }
/** DELETE /api/u/:userId/models/notice → Ok */

/** Offerings from different endpoints declared the same model, in order. */
export interface GroupInfo { id: string; name: string; shared: boolean; members: string[] }
/** GET /api/u/:userId/groups → GroupInfo[] (own, then shared) */
/** POST /api/u/:userId/groups → GroupInfo. `shared` needs an administrator and shared members. */
export interface GroupInput { name: string; members: string[]; shared?: boolean }
/** PATCH /api/u/:userId/groups/:groupId → GroupInfo. Rename, or reorder, add or remove members. */
export interface GroupChange { name?: string; members?: string[] }
/** DELETE /api/u/:userId/groups/:groupId → Ok. Lists that named it drop it. */
/** GET /api/u/:userId/groups/:groupId → GroupDetail: how its copies differ. */
export interface GroupDetail {
  group: GroupInfo;
  members: (OfferingInfo & { kind: "cloud" | "local"; stale: boolean })[];
  warnings: string[];
}
/** GET /api/u/:userId/groups/suggestions → GroupSuggestion[]. Never made automatically. */
export interface GroupSuggestion { name: string; members: string[]; strength: "strong" | "weak" }

/** A named model preset, as the Models page lists it. */
export interface PresetInfo {
  id: string;
  name: string;
  scope: PresetScope;
  /** local or cloud for the built-ins; null for a user preset. */
  builtin: "local" | "cloud" | null;
  entries: Partial<Record<Task, Entry>>;
  updatedAt: string;
}

/** One column's state on the Models page: the preset it follows, or Custom with its own entries and the preset they came from. */
export interface ColumnState {
  column: Column;
  preset: PresetInfo | null;
  fromPreset: PresetInfo | null;
  entries: Partial<Record<Task, Entry>>;
}

/** GET /api/u/:userId/presets → Presets */
export interface Presets {
  presets: PresetInfo[];
  columns: { private: ColumnState; general: ColumnState };
  /** The thinking level threads use unless they choose. */
  thinking: ThinkingLevel;
  /** Fallback, unless a thread chooses: whether a later model in a list may answer when the first can't. On by default. */
  fallback: boolean;
  /** Fallback for sleep's phases. On by default; off, a phase whose first model is away waits for the next night. */
  sleepFallback: boolean;
  /** Read aloud while agent writes: Read aloud is offered on the reply she is still writing (`messages/live/speech`). Off by default. */
  readAloudLive: boolean;
}
/**
 * PUT /api/u/:userId/columns/:column/:task → Presets. A private column takes
 * local models only, a general one both. `same` names a task of the same
 * kind that doesn't itself follow another. `model` sets a one-model list;
 * null or an empty list clears the entry.
 */
export type ColumnTaskChange = { models: ModelRef[] | null } | { same: Task } | { model: ModelRef | null };
/** PATCH /api/u/:userId/presets → Presets */
export interface PresetsChange { thinking?: ThinkingLevel; fallback?: boolean; sleepFallback?: boolean; readAloudLive?: boolean }

/**
 * One turn's counts and times. `promptTokens` is the whole prompt of its last
 * request; `readTokens` sums every request including cached reads;
 * `processed` is the prompt tokens read (not cached); times are in ms.
 */
export interface PaceInfo {
  promptTokens: number; readTokens?: number; outputTokens: number; window: number; ttftMs: number; genMs: number; processed: number;
  tokPerSec?: number; promptTokPerSec?: number;
}

/** A thread's context: used of window, Pi's compaction reserve, what's free before it, and the parts. */
export interface ContextInfo {
  tokens: number; window: number; percent: number; reserve: number; free: number;
  /** persona, about, memory, pinned, recall, tools, conversation (estimated, scaled to the measured total), then reserve and free. */
  parts: { name: "persona" | "about" | "memory" | "pinned" | "recall" | "tools" | "conversation" | "reserve" | "free"; tokens: number }[];
  measuredAt: string;
  /** The last turn's speed. */
  pace?: PaceInfo;
}

/** Which model answered a call. Never any of the conversation's text. */
export interface CallInfo {
  at: string; pool: Pool; threadId: string; task: Task; offeringId: string;
  /** Kept with the ID, so history reads correctly after the model is gone. */
  label: string; endpointName: string; kind: "cloud" | "local";
  /** Why the first model in the list didn't answer, when it didn't. */
  fallback?: string;
  /** Such as a model that couldn't think. */
  note?: string;
  /** The turn's counts, times and speeds (tok/s and prompt tok/s), once it ended. */
  pace?: PaceInfo;
  /** A speech call's seconds of audio, heard or spoken. */
  audioSeconds?: number;
}
/** GET /api/u/:userId/models/calls → CallInfo[], newest first. */

// --- Workspace defaults ---

/** GET /api/u/:userId/network → NetworkDefaults */
export type NetworkDefaults = Record<Pool, Network>;
/** PATCH /api/u/:userId/network/:pool → NetworkDefaults */
export type NetworkChange = Partial<Network>;

/** GET /api/u/:userId/mode → ModeDefault; PUT with a ModeDefault → ModeDefault. The mode new threads start in. */
export interface ModeDefault { mode: PermissionMode }

/** GET /api/u/:userId/paths → AllowedPaths: the folders this user may grant, set by an administrator. */
export type AllowedPaths = Record<Pool, string[]>;

/** The loosest mode she may use on a machine. */
export type MachineLimit = "ask" | "acceptEdits" | "auto";

export interface MachineInfo {
  name: string;
  kind: "ssh" | "proxmox";
  /** account@host or account@host:port; for Proxmox https://host:port. */
  address: string;
  /** Always null for Proxmox. */
  root: string | null;
  pool: Pool;
  limit: MachineLimit;
  /** SSH: for the machine's keys file, usable only from Lyrica's addresses. */
  keyLine?: string;
  /** Proxmox: the token's id (user@realm!tokenid). The token itself is never shown. */
  tokenId?: string;
  /**
   * The host key the user confirmed (SHA256:…), or for Proxmox the certificate's
   * fingerprint (AB:CD:…); null for a machine from before confirming, which
   * can't be used until it is.
   */
  hostKey: string | null;
  /** Its address resolved outside the LAN, loopback and tailnet at the last check. */
  offNetwork: boolean;
  lastUsed: string | null;
  /**
   * How the last connection went, for the row's state: online (she got in),
   * unreachable (it couldn't be reached or logged in to), or keyChanged (it
   * showed a host key other than the confirmed one). `since` is when that
   * outcome began. Absent before the first connection, and after the address
   * or host key changes.
   */
  state?: { kind: "online" | "unreachable" | "keyChanged"; since: string };
}
/** GET /api/u/:userId/machines → MachineInfo[] */
/**
 * POST /api/u/:userId/machines/probe → MachineProbe. The Test step of Add
 * machine, and of Replace key: makes a key pair for the machine and keeps it
 * in memory (pass `draft` back to keep using it), then reads the host key and
 * tries the login. Nothing is saved.
 */
/**
 * For Proxmox (`kind: "proxmox"`, address https://host:8006) the Test step
 * reads only the certificate's fingerprint and gives the pveum setup steps;
 * the token isn't sent until Confirm.
 */
export interface MachineProbeInput { kind?: "ssh" | "proxmox"; name: string; address: string; draft?: string }
export interface MachineProbe {
  /** SSH only. */
  draft?: string;
  /** SSH only. */
  keyLine?: string;
  /** The setup steps, to run as root on the machine (for Proxmox, on the node). */
  setup: string;
  /** The host key, or for Proxmox the certificate's SHA-256 fingerprint. */
  fingerprint?: string;
  /** Whether her key was accepted. Always false for Proxmox. */
  login: boolean;
  problem?: string;
  offNetwork: boolean;
}
/**
 * POST /api/u/:userId/machines → MachineInfo. Confirm: saves the machine with
 * its probe's key and the host key the user confirmed. A private machine off network
 * needs `offNetworkConfirmed` (the Add anyway dialog). New machines start at Ask.
 */
/**
 * For Proxmox: `kind: "proxmox"`, `token` (user@realm!tokenid=secret) in place
 * of `draft`, and the certificate's fingerprint as `hostKey`. The token is
 * tried against that certificate before saving, and the Proxmox that runs
 * Lyrica's own VM is refused (400, saying why).
 */
export interface MachineInput {
  kind?: "ssh" | "proxmox";
  name: string; address: string; root?: string; pool: Pool; limit?: MachineLimit;
  draft?: string; token?: string; hostKey: string; offNetworkConfirmed?: boolean;
}
/** PATCH /api/u/:userId/machines/:name → MachineInfo. A new pool takes the machine from every thread that granted it. */
export interface MachineChange { address?: string; root?: string | null; pool?: Pool; limit?: MachineLimit }
/**
 * POST /api/u/:userId/machines/:name/key → MachineInfo. Replace key: the host
 * key (or Proxmox certificate) the user confirmed after a probe. A Proxmox machine
 * may take a new `token`, tried against that certificate before saving.
 */
export interface MachineKey { hostKey: string; token?: string }
/** POST /api/u/:userId/machines/:name/confirm-off-network → MachineInfo. A private machine gone off network can be used again. */
/** DELETE /api/u/:userId/machines/:name → Ok. Every thread's grant of it goes too. */

/** What a Git account's host runs: GitHub, Forgejo, Gitea, or Other (plain git over HTTPS). */
export type GitKind = "github" | "forgejo" | "gitea" | "other";

/** GET /api/u/:userId/git-accounts → GitAccountInfo[]. The token is never sent back. */
export interface GitAccountInfo {
  name: string;
  kind: GitKind;
  /** host or host:port. */
  host: string;
  /** The account's name on the host. */
  account: string;
  /** A GitHub account is always general. */
  pool: Pool;
  /** Its host resolved outside the LAN, loopback and tailnet at the last check. */
  offNetwork: boolean;
  /** How the last use went, and since when: signedIn (the token worked), rejected (the host refused it), unreachable. Absent before the first. */
  state?: { kind: "signedIn" | "rejected" | "unreachable"; since: string };
  /**
   * A Forgejo/Gitea account whose host resolves into her own network gets the
   * tailnet webhook (docs/briefs/ci-wakes.md step 4): where the forge POSTs,
   * and the secret that signs it. Absent for GitHub (which is polled) and for
   * an account whose host is off her network.
   */
  webhook?: { url: string; secret: string };
}
/**
 * POST /api/u/:userId/git-accounts/probe (GitAccountInput) → Ok. Checks the
 * token against the host, saving nothing: 400 with why when it doesn't work.
 * POST /api/u/:userId/git-accounts (GitAccountInput) → GitAccountInfo. Checks
 * it again and saves it. A private account whose host resolves outside her
 * network needs `offNetworkConfirmed`; a GitHub account can't be private.
 */
export interface GitAccountInput { name: string; kind: GitKind; host: string; account: string; token: string; pool: Pool; offNetworkConfirmed?: boolean }
/** PATCH /api/u/:userId/git-accounts/:name → GitAccountInfo. A new pool takes its repositories from every thread; a new name follows into them. */
export interface GitAccountChange { name?: string; host?: string; account?: string; pool?: Pool; offNetworkConfirmed?: boolean }
/** POST /api/u/:userId/git-accounts/:name/token → GitAccountInfo. Replace token: checked against the host before it replaces the old one. */
export interface GitToken { token: string }
/** POST /api/u/:userId/git-accounts/:name/confirm-off-network → GitAccountInfo. A private account gone off network can be used again. */
/** DELETE /api/u/:userId/git-accounts/:name → Ok. Every thread's repositories that use it go too. */
/** GET /api/u/:userId/git-accounts/:name/repositories?q= → GitRepository[]. What the account can see, from its forge; none for Other. */
/** A repository a thread clones, and the Git account it uses. */
export interface GitRepository { name: string; account: string }

/** GET /api/u/:userId/mcp-servers → McpServerInfo[]. The token is never sent back. */
export interface McpServerInfo {
  name: string;
  /** Its streamable HTTP address. Query values named like a credential show as •••, as in EndpointInfo.baseUrl. */
  url: string;
  /** host or host:port, from the URL. */
  host: string;
  pool: Pool;
  /** Whether a token is sent with each request. */
  hasToken: boolean;
  /** How many tools it offered at the last check. */
  tools: number;
  /** The line she sees it listed with: the first line of its instructions, or its title. */
  description: string | null;
  /** Its host resolved outside the LAN, loopback and tailnet at the last check. */
  offNetwork: boolean;
  /** How the last connection went, and since when: online, rejected (the token), unreachable. Absent before the first. */
  state?: { kind: "online" | "rejected" | "unreachable"; since: string };
}
/**
 * POST /api/u/:userId/mcp-servers/probe (McpServerInput) → McpServerProbe. An
 * MCP `initialize` and `tools/list`, saving nothing: 400 with why when the
 * server doesn't answer as one. POST /api/u/:userId/mcp-servers
 * (McpServerInput) → McpServerInfo. Checks it again and saves it. Remote
 * (streamable HTTP) servers only. A private server whose host resolves
 * outside her network needs `offNetworkConfirmed`.
 */
export interface McpServerInput { name: string; url: string; token?: string; pool: Pool; offNetworkConfirmed?: boolean }
export interface McpServerProbe { tools: number; description: string | null }
/** PATCH /api/u/:userId/mcp-servers/:name → McpServerInfo. A new URL is checked first; a new pool takes it from every thread; a new name follows into them. */
export interface McpServerChange { name?: string; url?: string; pool?: Pool; offNetworkConfirmed?: boolean }
/** POST /api/u/:userId/mcp-servers/:name/token → McpServerInfo. Replace token: the server is checked with it first; empty sends none. */
export interface McpToken { token: string }
/** POST /api/u/:userId/mcp-servers/:name/confirm-off-network → McpServerInfo. A private server gone off network can be used again. */
/** DELETE /api/u/:userId/mcp-servers/:name → Ok. Every thread's grant of it goes too. */

// --- Threads ---

export interface ThreadSummary {
  question?: { n: number; asked: string };
  pool: Pool;
  id: string;
  interface: Interface;
  title?: string;
  parent?: string;
  subagent: boolean;
  hidden: boolean;
  unlogged: boolean;
  createdAt: string;
  /** When its last entry was written, or its creation time. The list is ordered by it. */
  updatedAt: string;
  /** A turn is running. */
  busy: boolean;
  /** Started by Lyrica from its parent (`threads start`). */
  child: boolean;
  /** A child thread's state: working, waiting for an approval, or idle. */
  status?: "working" | "waiting" | "idle";
  /** A child thread's updates to its parent that the user hasn't seen: opening the child sees them. */
  unseen?: number;
  /** Child threads (Lyrica's, branches, forks, copies), nested under their parent. Subagents aren't listed. */
  children: ThreadSummary[];
  /** The user's own group for it (GET …/thread-groups), when it is in one. Per user, never in the pool. */
  group?: string;
  /** Marked unread by the user; opening the thread clears it. */
  unread?: boolean;
  /** The user pinned it: it sits at the top of the list, whatever the sort. */
  pinned: boolean;
  /** A project chat; its threads are its children. */
  project?: true;
  /** A project's goal, in the user's words. */
  goal?: string;
  /** A project's instructions, in the user's words; kept on the project page apart from what sleep writes. */
  instructions?: string;
  /** A project's settings. */
  projectSettings?: ProjectSettingsInfo;
  /** A project's thread: the project chat's message it hangs off (an entry number), if that is still there. */
  anchor?: number;
  /** A project's thread: waiting covers an approval and a question for the user. */
  state?: "working" | "waiting" | "queued" | "idle" | "resolved";
  /** A project's thread is waiting on the user to decide something. */
  needsYou?: true;
  /** Its next wake-up, if one is waiting (her `threads later`). */
  wakeAt?: string;
  /** Her checklist for it (`threads steps`), in order; absent when it has none or Checklists is off. */
  steps?: ThreadStep[];
}

/** One step of a thread's checklist: done, under way, or not started. */
export interface ThreadStep { text: string; state: "done" | "doing" | "todo" }

export interface CommandRule { prefix: string; decision: "allow" | "ask" | "forbid" }

export interface ProjectSettingsInfo {
  draftGoal?: string;
  draftInstructions?: string;
  commandRules: CommandRule[];
  /** The project page's memory ID, for the memory browser. The page exists once instructions are saved or sleep writes it. */
  pageId: string;
  /** Paused: its threads stop, nothing new starts, and they take no messages. */
  paused: boolean;
  /** The chat model new threads of the project start with; none: the project chat's. */
  threadsModel?: ModelRef | ModelRef[];
  threadsThinking?: ThinkingLevel;
  /** Fallback for new threads of the project; none: the project chat's. */
  threadsFallback?: boolean;
  /** After the person writes in a thread, or a thread posts an update, the project chat looks and tells the threads it affects. */
  watchThreads: boolean;
}

/**
 * GET /api/u/:userId/threads?interface=web → ThreadSummary[]
 * One interface's threads (default `web`), most recently active first. Honours the user's
 * display filters (pools, hidden); `?all=1` ignores them. Child threads
 * appear only under their parent; subagents not at all (their delegate cards show them).
 */
/** POST /api/u/:userId/threads → ThreadSummary. Its interface is `web`. A new project starts pinned. */
export interface NewThread { pool: Pool; title?: string; project?: boolean; goal?: string }
/** GET /api/u/:userId/threads/:pool/:threadId → ThreadSummary */
/**
 * PATCH /api/u/:userId/threads/:pool/:threadId → ThreadSummary. Rename, hide or unhide; make a
 * top-level thread a project (`project: true`, no way back; it is pinned), and change a project's
 * goal, instructions and settings. Pausing or hiding a project stops its working threads.
 */
export interface ThreadChange {
  /** `group` and `unread` are the user's own view of the thread, kept in user.db; `null` takes it out of its group. */
  group?: string | null; unread?: boolean;
  /** Clears unsaved welcome drafts without changing Goal or Instructions. */
  discardDraft?: boolean;
  title?: string; hidden?: boolean; project?: true; goal?: string; instructions?: string;
  commandRules?: CommandRule[];
  paused?: boolean; threadsModel?: ModelRef | ModelRef[] | null; threadsThinking?: ThinkingLevel | null; threadsFallback?: boolean | null; watchThreads?: boolean;
}
/** PUT and DELETE /api/u/:userId/threads/:pool/:threadId/pin → ThreadSummary. The user's own pin, in user.db. */
/**
 * POST …/threads/:pool/:threadId/messages/:n/thread → ThreadSummary. Start a thread: in a project chat,
 * a thread of the project anchored at message n, with that message as its task. Queued past the limit.
 */
export interface StartThread { title?: string }
/**
 * POST …/threads/:pool/:projectId/plan (no body) → ThreadSummary. Starts the project's thread titled
 * "Plan", with a task the server writes: a plan for the project's goal. It has no anchor, so its card
 * sits under the chat's last message. A paused or hidden project is refused (409), creating nothing.
 */
export type StartPlanResult = ThreadSummary;
/** POST …/threads/:pool/:threadId/resolve and …/reopen → ThreadSummary. A project's thread only. */
/**
 * POST …/threads/:pool/:projectId/suggestions/:callId/start → ThreadSummary[]: starts one of a
 * Suggested threads card's threads (`index`), or all of them not yet started.
 */
export interface StartSuggestion { index?: number }
/** POST …/threads/:pool/:projectId/fold → ThreadSummary. Same-pool top-level work only. */
export interface FoldThread { threadId: string }
/** POST …/threads/:pool/:projectId/folds/:callId/apply → ThreadSummary[]. Index or all; idempotent. */
export interface ApplyFold { index?: number }
/**
 * POST …/threads/:pool/:threadId/continue-as-project → ThreadSummary. Source stays; children move.
 * GET …/threads/:pool/recent?top=10&project=:id → ThreadSummary[]. Logged top-level non-project work only.
 * GET …/threads/:pool/:projectId/overview → ProjectOverview
 */
export interface ProjectOverview {
  threads: ThreadSummary[];
  /** How many wait on the user: the project row's amber dot. */
  waiting: number;
  /** Tokens every call of the project chat and its threads read and wrote. */
  tokens: number;
  /** Which suggested threads were started, as `callId#index` → the thread made. */
  started: Record<string, string>;
}

/**
 * The user's own groups of threads, shown in the sidebar under "My groups" and in the thread menu's Move to group.
 * GET /api/u/:userId/thread-groups → ThreadGroup[]
 * POST /api/u/:userId/thread-groups (NewThreadGroup) → ThreadGroup
 * PATCH /api/u/:userId/thread-groups/:groupId (NewThreadGroup) → ThreadGroup
 * DELETE /api/u/:userId/thread-groups/:groupId → Ok. Its threads are in no group afterwards.
 */
export interface ThreadGroup { id: string; name: string }
export interface NewThreadGroup { name: string }
/**
 * DELETE /api/u/:userId/threads/:pool/:threadId → Ok. Forgets the thread (memory.md, "Deletion"),
 * with its subagents. Its child threads (Lyrica's, branches, copies) go too with `children`,
 * and are otherwise kept as threads of their own.
 */
export interface ForgetThread { children?: boolean; keepMemories?: boolean }

/**
 * GET /api/u/:userId/threads/:pool/:threadId/tombstone → ThreadTombstone. What a thread
 * deleted with "Keep memories" leaves: no text, not even its title, only its ID, when it
 * was deleted and the memories that cite it. 404 when the thread has no tombstone (or still exists).
 */
export interface ThreadTombstone {
  id: string;
  deletedAt: string;
  /** The notes and pages in this pool citing the thread or one of its messages. */
  memories: MemoryUse[];
  /** By each memory's ID, as in `MemoryDetail.links`. */
  links: Record<string, MemoryLink>;
  users: UserMap;
}

// --- Share with ---
// A copy of a thread sent to another user on this server (DESIGN.md, "Where things
// are"). It waits in self.db until they add it to General or Private, which copies
// the entries into a new thread of theirs, indexed there, or decline. Nothing of
// the sender's memory goes with it; the sender's later messages never reach the copy.

/** GET /api/u/:userId/people → Person[]: the other users on this server, to share with. */
export interface Person { id: string; displayName: string; /** A linked persona of this user. */ linked: boolean }
/** POST /api/u/:userId/threads/:pool/:threadId/share (ShareRequest) → Ok. Not a project chat or a subagent's thread. The copy is the conversation alone: her context, memory tools and citations stay behind, and so do the thread's files. */
export interface ShareRequest { to: string }
/** POST /api/u/:userId/shares/:shareId/accept (AcceptShare) → ThreadSummary: the new thread in that pool. A private thread is added only to Private (409 otherwise); a local-only thread's copy is local-only. */
export interface AcceptShare { pool: Pool }
/** DELETE /api/u/:userId/shares/:shareId → Ok: declined; nothing of it stays. */

// --- Notifications ---
// One list over everything waiting for the user (DESIGN.md, "Where things are"):
// threads shared with them, approvals a thread waits for, child thread updates,
// her items from the night, and, for administrators, persona changes to approve.
// Not yet in it: downloads, clean-up items, image models to review, host problems.

export type NotificationType = "question" | "share" | "permission" | "update" | "sleep" | "suggestion" | "approval" | "rollback";
/** An action on an item: a request the UI sends as it is. `opens`: the answer is a ThreadSummary to go to. */
export interface NotificationAction { label: string; method: "POST" | "DELETE"; path: string; body?: unknown; danger?: boolean; opens?: boolean }
export interface Notification {
  /** Unique across types: `<type>:<id>`. */
  id: string;
  type: NotificationType;
  title: string;
  detail?: string;
  /** Where it is: a pool, for now. */
  scope: Pool;
  /** The user has to decide something; a plain update isn't counted in the sidebar. */
  decision: boolean;
  /** Where it leads, if anywhere: a thread, or a section of Settings or Administration. */
  thread?: { pool: Pool; id: string };
  section?: "settings/suggestions" | "admin/persona" | "admin/updates";
  actions: NotificationAction[];
  at: string;
}
export type NotificationSort = "newest" | "oldest" | "type" | "scope";
/**
 * GET /api/u/:userId/notifications?type=&scope=&sort=newest&offset=0&limit=50 → NotificationPage.
 * `total` is the number matching the filters, `waiting` the decisions over everything (the sidebar's count), `types` which types exist now.
 * A pool the display has off, or a hidden thread while Show hidden is off, contributes nothing, not even to `waiting`.
 */
export interface NotificationPage { items: Notification[]; total: number; waiting: number; types: NotificationType[] }
/** POST /api/u/:userId/threads/:pool/:threadId/seen → Ok: a child thread's updates are seen without opening it. */

/** Where a thread's model for one task comes from. */
export interface TaskModel {
  /** The model set for the task, named even while its endpoint is down (what answers now is `speech` and the Models page's status). */
  model?: { offeringId: string };
  /** The thread's own list, when it has one. */
  list?: ModelRef[];
  /** `<endpoint>/<model>`, kept readable after the model is gone. */
  label?: string;
  modelId?: string;
  /** What to call it: a recipe's or plan image model's name, else its model ID. */
  name?: string;
  kind?: "cloud" | "local";
  endpointName?: string;
  /** "thread" when overridden here, "preset" or "column" when following one of those, "none" when nothing is set. */
  source: "thread" | "preset" | "column" | "none";
  /** Why nothing usable is set here (unset, or a cloud model in a private thread), in plain words. */
  problem?: string;
}

export interface ThreadSettings {
  models: Record<ThreadTask, TaskModel>;
  /** Wake-ups waiting, soonest first; the user may remove each (`DELETE …/wakeups/:id`). */
  wakeups: WakeupInfo[];
  /** Recurring schedules, including paused ones; never notes. */
  routines: RoutineInfo[];
  /** The preset that applies now, by name (or "Custom" for a column's own table). */
  profile: string;
  /** The preset the thread chose by id, or null when it follows its column. */
  preset: string | null;
  thinking: ThinkingLevel;
  /** The levels the current chat model offers (always including off). */
  thinkingLevels: ThinkingLevel[];
  /** The last call in this thread: which model answered, and any fallback. */
  answered?: CallInfo;
  /**
   * How full the context is. From the open session, with the breakdown; from
   * the last call record otherwise (no parts). Absent before the first measured turn.
   */
  context?: ContextInfo;
  /** Always true in a private thread. */
  localOnly: boolean;
  /** Overrides of the user's per-pool defaults; null follows the default. */
  internet: boolean | null;
  services: boolean | null;
  hosts: string[] | null;
  /** What applies now, defaults included. All off while the host's network self-test refuses network. */
  network: Network;
  /** The folders it may use: its own, less any an ancestor has since taken off, and read-only where an ancestor's is (`effective`). */
  grants: Grant[];
  /** The machines it may use besides the sandbox, by name: its own, less any an ancestor has since taken off (`effective`). */
  machines: string[];
  /** The repositories it clones into /workspace/repos, each with its Git account: its own, less any an ancestor has since taken off. */
  repositories: GitRepository[];
  /** The MCP servers it may use, by name: its own, less any an ancestor has since taken off (`effective`). */
  mcpServers: string[];
  mode: PermissionMode;
  /** Switches: web_search and web_fetch, and the image tool. Off removes them from the session. */
  webSearch: boolean;
  /** Whether the server has a SearXNG address: without one, the switch gives web_fetch alone. */
  searchProvider: boolean;
  images: boolean;
  /** Claude Code on the user's Claude plan in her sandbox runs: the switch along its ancestors (docs/workspace.md, "Claude Code"). */
  claudeCode: boolean;
  /** Whether the switch can do anything here: a general thread that isn't local-only, a saved token, and Claude Code installed. Without it, the drawer leaves the switch out. */
  claudeCodeOffered: boolean;
  /** "Do not log thread in memory". */
  unlogged: boolean;
  /** Fallback: the thread's choice, or null to follow the user's default. Off, only the first model in a list answers. */
  fallback: boolean | null;
  /** Fallback as it applies here, after the default. */
  fallbackOn: boolean;
  /** Whether Dictation and Read aloud can be used here now, and why not. */
  speech: Speech;
  /** Set for a subagent or a branch: its settings are its parent's or stricter. A subagent's UI shows them read-only. */
  parent: string | null;
  /** The endpoints and models this thread may choose from (local only when restricted). */
  allowed: EndpointInfo[];
}

/** GET /api/u/:userId/thread-defaults?pool=general|private → ThreadSettings (read-only, no thread created).
 * GET /api/u/:userId/threads/:pool/:threadId/settings → ThreadSettings */
/**
 * PATCH /api/u/:userId/threads/:pool/:threadId/settings → ThreadSettings.
 * Refused as a whole, with the reason, if the router or the workspace would
 * refuse any part: a cloud model in a private or local-only thread, a folder
 * outside the allowed paths, a subagent wider than its parent.
 */
export interface ThreadSettingsChange {
  /** A model or an ordered list; null clears the thread's choice, so the column's applies. */
  models?: Partial<Record<ThreadTask, ModelRef | ModelRef[] | null>>;
  /** The preset the thread uses by id; null follows its column. Private and local-only threads may choose only a private preset. */
  preset?: string | null;
  /** null follows the user's default. */
  thinking?: ThinkingLevel | null;
  localOnly?: boolean;
  internet?: boolean | null;
  services?: boolean | null;
  hosts?: string[] | null;
  grants?: Grant[];
  /** Machines of the thread's pool; a branch takes a subset of its parent's. */
  machines?: string[];
  /** Repositories of Git accounts of the thread's pool; a child takes a subset of its parent's. */
  repositories?: GitRepository[];
  /** MCP servers of the thread's pool, by name; a child takes a subset of its parent's. */
  mcpServers?: string[];
  mode?: PermissionMode;
  webSearch?: boolean;
  images?: boolean;
  claudeCode?: boolean;
  unlogged?: boolean;
  /** null follows the user's default. */
  fallback?: boolean | null;
}

// --- Speech: Dictation and Read aloud ---

/**
 * Whether a speech task can be used now: the model the router would pick,
 * or the plain reason there is none (no model set, a private thread with no
 * local one, every model down). Dictation uses the thread's own pick, else the Private column. The mic
 * or Read aloud is disabled with `problem` as its tooltip.
 */
export type SpeechState = { available: true; label: string; kind: "cloud" | "local" }
  /** reason: "none" nothing usable is set here; "down" every model set can't be reached now. */
  | { available: false; reason: "none" | "down"; problem: string };
/** `readAloudLive` is the user's Read aloud while agent writes setting (`Presets.readAloudLive`). */
export interface Speech { transcribe: SpeechState; speak: SpeechState; readAloudLive: boolean }
/** GET /api/u/:userId/speech?pool= → Speech: for the welcome page, before a thread exists (the user's defaults). */

/**
 * POST /api/u/:userId/threads/:pool/:threadId/transcribe?language= → Transcription
 * POST /api/u/:userId/transcribe?pool=&language= → Transcription (the welcome page)
 *
 * The body is the clip: `audio/wav`, 16 kHz mono 16-bit PCM, at most 10
 * minutes (413 beyond). `language` ("en", "zh") is optional; without it the
 * model detects it. Refusals, each with a plain sentence for the error line:
 * 400 CloudModelForbidden or NoModel (none set, or none allowed here), 502
 * Offline (`code: "offline"`) when every Dictation model set can't be reached now. The audio is
 * never stored; call records hold the model and the seconds only.
 */
export interface Transcription { text: string; seconds: number; model: string }

/**
 * GET /api/u/:userId/threads/:pool/:threadId/messages/:n/speech → audio
 * GET /api/u/:userId/threads/:pool/:threadId/messages/live/speech → audio (her message still streaming)
 *
 * Reads one of her messages aloud: lyricad reads it from the store (the
 * client never sends text), skips code, tables, links and markdown, and
 * speaks it sentence by sentence, one ahead. The body is raw PCM, signed
 * 16-bit little-endian mono at 24 kHz (`audio/pcm;rate=24000;encoding=s16le;channels=1`),
 * streamed as it is made; closing the connection stops it. `live` follows
 * the message being written to its end. Before any audio, refusals are JSON
 * as for transcribe (404 for no such message or no live message, 400 for
 * one that isn't hers or has nothing to read). A model that fails midway
 * ends the stream early.
 */

// --- Messages ---

/** One part of a stored message, as the UI draws it. */
export interface ImageRefusal { code: "image_refusal"; offeringId: string; endpointId: string }
export interface ImageRetryOptions { next?: { offeringId: string; label: string }; userMessage?: { n: number; text: string }; canEdit: boolean }
/** GET …/image-calls/:toolCallId: current retry choices. POST { next?: boolean }: retry the stored call. */
export interface ImagePart { type: "image"; paths: string[]; model: string; tier?: "fast" | "quality" }

export type MessagePart =
  | ImagePart
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; toolCallId: string; name: string; args: unknown; result?: string; isError?: boolean; threads?: ThreadRef[]; imageRefusal?: ImageRefusal }
  | { type: "recall"; ids: string[] }
  | { type: "remember"; ids: string[] }
  /**
   * Something a subagent run delivered into the thread: a background run's
   * result or question, a note, or what a user wrote to one of its subagents.
   * `status` says which ("finished", "question", "note", "user_message", …).
   */
  | { type: "delegation"; text: string; runId?: string; status?: string; threads?: ThreadRef[]; told?: Told[] }
  /** The thread was compacted: tokens before and (estimated) after, and the summary that replaced the older messages. */
  | { type: "compacted"; before: number; after?: number; summary: string };

/** A `delegate` call's subagent threads, so its card can open them. */
export interface ThreadRef { pool: Pool; id: string }

/** A thread a look at the project's threads told, and the line it sent. */
export interface Told { threadId: string; text: string }

export interface Message {
  /** The entry ID, `e:<thread>#<n>`. */
  id: string;
  /** Entry number in the thread, for paging. */
  n: number;
  /** "notice": something delivered into the thread, such as a background run's result. */
  role: "user" | "assistant" | "notice";
  /**
   * In a subagent's thread, who sent a "user" message: Lyrica, or a user who
   * wrote in the thread (with their current name). In a child thread, a
   * message from its parent thread.
   */
  /**
   * `thread`: another thread of the same project wrote it (Lyrica, from there).
   * `watching`: in a project chat, a look at its threads (watch.ts): the text names the threads it was
   * about (`In [t:<id>]: …` lines) and who it told; `told` is those threads with the line each was sent.
   * A look stored before looks were one model call has no `told`: her next turn's messages are what it led to.
   * `routine`: her recurring note, with its schedule in describe() words.
   * `wakeup`: her note to herself from `threads later`, set at `setAt`; `dueAt` when it fired late (the user was locked).
   */
  from?: { kind: "routine"; schedule: string } | { kind: "lyrica" } | { kind: "watching"; told?: Told[] } | { kind: "wakeup"; setAt: string; dueAt?: string } | { kind: "user"; userId: string; name: string } | { kind: "parent"; threadId: string } | { kind: "thread"; threadId: string };
  parts: MessagePart[];
  createdAt: string;
  /** The model that wrote an assistant message. */
  model?: string;
  error?: string;
  /** The user pinned it: it stays in her context word for word. */
  pinned?: boolean;
  /** Emoji on the message, in the order they first came, by the user (`you`), Lyrica (`her`) or both. */
  reactions?: Reaction[];
}

/** One emoji on a message and who put it there. Both can react with the same emoji; it is then one chip counting two. */
export interface Reaction { emoji: string; you: boolean; her: boolean }
/**
 * PUT /api/u/:userId/threads/:pool/:threadId/messages/:n/reactions/:emoji → Reactions puts the user's reaction on
 * message n, DELETE takes it off; `emoji` is URL-encoded. Any message, including her own; not in a subagent's thread.
 * She is told of it in her next turn, and she reacts herself with her `react` tool; every tab with the thread open
 * sees a `reactions` event.
 */
export interface Reactions { reactions: Reaction[] }

/** POST …/threads/:pool/:threadId/questions/:n/answer → 204; 404 unknown, 409 closed, 400 invalid option. */
export interface AnswerQuestion { option: number }
export interface QuestionState { n: number; asked: string; closed?: string; answer?: number | "words" | "withdrawn" }
/**
 * GET /api/u/:userId/threads/:pool/:threadId/messages?before=<n>&limit=<k> → MessagePage
 * Newest page by default, oldest first within the page. Tool results are folded into their calls.
 */
export interface MessagePage { messages: Message[]; hasMore: boolean; questions?: QuestionState[] }

/**
 * POST /api/u/:userId/threads/:pool/:threadId/messages → SendResponse.
 * Starts a turn, or waits as a follow-up while one runs. In a subagent's
 * thread it goes to the subagent, as Lyrica's `message` does (joining its
 * work, answering its question, or continuing it), marked as the user's, and
 * a note goes to the parent thread. A subagent that can't take it is `409`.
 */
export interface SendRequest {
  text: string;
  /** Selected recent work, at most ten IDs; project chat only, read in this turn alone. */
  recentThreadIds?: string[];
  /** With text `/sleep` in manual mode: the user confirmed. */
  confirm?: boolean;
}
/** `/sleep` sleeps the thread's pool instead of starting a turn (see SleepRequest), and answers `sleep`. */
export interface SendResponse { queued: boolean; sleep?: SleepStarted }

/**
 * GET /api/u/:userId/threads/:pool/:threadId/draft → DraftInfo, and PUT (DraftChange) to keep one.
 * The composer's unsent text, one per thread, in the thread's pool database; empty text clears it,
 * and so does sending a message. At most 64 KiB, or `413`.
 */
export interface DraftInfo { text: string; updatedAt?: string }
export interface DraftChange { text: string }

/**
 * GET /api/u/:userId/search?q=&pool=&limit=&before= → SearchResults: the user's messages and her
 * replies holding every word of `q` (2 characters at least), each as a word or a word's start, newest
 * first, 50 a page (`limit` lowers it; `before`, a hit's `at`, pages). Only the user's own pools, and
 * only what the thread list shows: a pool the display setting turns off is left out, hidden threads
 * too unless `showHidden` is on; `pool` narrows to one pool, never widens. Web threads, not subagents'.
 * Unlogged entries are never indexed, so never found.
 */
export interface SearchResults { hits: SearchHit[] }
export interface SearchHit {
  threadId: string;
  pool: Pool;
  /** The thread's title; none while it has none. */
  title?: string;
  /** The message's number in its thread (`Message.n`), to open the thread there. */
  n: number;
  /**
   * `you`, or `agent` for hers (what she sent from another thread and her wake-up notes too).
   * Another user's display name is reserved for a message another user wrote, which no
   * indexed thread holds yet.
   */
  who: "you" | "agent" | (string & {});
  /** The sentence that matched, at most 160 characters ("…" where it was cut). */
  snippet: string;
  /** Where the query's words are in `snippet`: [start, end) character offsets, in order. */
  marks: [number, number][];
  /** When the message was written. */
  at: string;
}

/**
 * POST /api/u/:userId/threads/:pool/:threadId/messages/:n/branch → ThreadSummary.
 * A child thread holding the conversation up to message `n` (and its tool
 * results), with the thread's settings; the thread itself is unchanged.
 */
export interface BranchRequest { title?: string }

/**
 * POST /api/u/:userId/threads/:pool/:threadId/messages/:n/rewind → RewindResponse.
 * Removes messages as forgetting does (memory.md, "Deletion"), while holding
 * the thread's turn: `409` while a turn runs. Notes written in them go, pages
 * citing them are flagged, and subagents started in them are stopped and
 * forgotten. Not in a subagent's thread.
 */
export interface RewindRequest {
  /**
   * "delete": message `n` and everything after it.
   * "regenerate": `n` is her reply; its turn goes and its user message is sent again.
   * "edit": `n` is the user's message; it and what followed go, and `text` is sent.
   */
  action: "delete" | "regenerate" | "edit";
  text?: string;
  /** With "regenerate": the thread's chat model from now on, checked by the router first. */
  model?: ModelRef;
  /** Only say what the removal would do (`RemovalPlan`); nothing changes. */
  preview?: boolean;
  /** Plan items the user unticked: left as they are. Everything else ticked in the plan is undone. */
  skip?: string[];
}

/**
 * What removing turns would undo, from `preview`. Files her write and edit
 * calls made are deleted, files they changed are put back, and either is kept
 * if something changed it since. Uploads only the removed messages mention are
 * deleted. Git branches made in those turns are deleted when they hold no
 * commits of their own (ticked) and listed otherwise. Commands are listed: what
 * they did isn't tracked.
 */
export interface RemovalPlan {
  messages: number;
  pins: number;
  subagents: number;
  files: PlanFile[];
  branches: PlanBranch[];
  /** The removed turns' commands, the first 20, each cut to 200 characters. */
  commands: string[];
}
export interface PlanFile {
  id: string;
  path: string;
  action: "delete" | "restore" | "keep";
  /** "changed since": by something else, so it's kept. "unreachable": the thread works elsewhere now, or its home is locked. */
  reason?: "changed since" | "unreachable" | "upload";
  ticked: boolean;
}
export interface PlanBranch { id: string; repo: string; branch: string; commits: boolean; ticked: boolean }
/** `pins`: how many of the removed messages were pinned; `files` and `branches`: how many were undone. */
export interface RewindResponse { removed: number; subagents: number; pins: number; files: number; branches: number }

/**
 * PUT /api/u/:userId/threads/:pool/:threadId/messages/:n/pin → Pin, and DELETE to unpin.
 * Only the user's messages and her replies can be pinned; not in a subagent's thread.
 */
/**
 * GET /api/u/:userId/threads/:pool/:threadId/pins → Pins: the thread's pinned
 * messages, oldest first. `shortened`: over the pinned budget, so the oldest
 * reach her as their first line only.
 */
export interface Pins { pins: Pin[]; shortened: boolean }
export interface Pin { id: string; n: number; role: "user" | "assistant"; text: string; createdAt: string }

/** POST /api/u/:userId/threads/:pool/:threadId/stop → Ok. Aborts the running turn. */

/**
 * POST /api/u/:userId/threads/:pool/:threadId/permissions/:requestId → Ok.
 * Approving a plan (`propose_plan`) says which mode to go ahead in; refusing it keeps planning.
 */
export interface PermissionAnswer {
  alwaysAllow?: true;
  allow: boolean;
  mode?: GoAhead;
  /** For a suspect command: that exact command stops asking in the thread it runs in, and nowhere else. */
  allowInThread?: boolean;
}

/**
 * POST /api/u/:userId/threads/:pool/:threadId/uploads?name=<file name> → UploadResponse.
 * The body is the file's bytes (any content type), up to the size limit. Saved under `uploads/`; an image gets a
 * random name with its extension (docs/workspace.md), so `path` is the name to use, not the one given.
 */
export interface UploadResponse { path: string }

// --- The Files panel (DESIGN, "Files and images"): the thread's folder and its grants, through the sandbox ---

/** One row of a listing; `path` is the file's path as she sees it. */
export interface FileEntry { name: string; path: string; kind: "file" | "folder" | "link" | "other"; size: number; modified: string }
/** A top of the panel's tree: the thread's folder (`/workspace`), then each granted folder. */
export interface FileRoot { path: string; writable: boolean; kind: "thread" | "grant" }
/**
 * GET /api/u/:userId/threads/:pool/:threadId/files?dir=<path> → FileListing.
 * One folder at a time (the thread's folder without `dir`), folders first;
 * `more` when the listing stopped at its cap (2,000). The panel's own
 * `.lyrica` folder is never listed.
 */
export interface FileListing { roots: FileRoot[]; dir: string; entries: FileEntry[]; more: boolean }
/** GET …/files/search?root=<path>&q=<text> → FileSearch: names containing the text under that root, at most 200. */
export interface FileSearch { entries: FileEntry[]; more: boolean }
/** GET …/files/images → ImageEntry[]: every image in the thread's folder; `uploaded` when it is in uploads/, else `made` by her. */
export interface ImageEntry extends FileEntry { source: "uploaded" | "made" }
/**
 * GET …/files/content?path=<path>[&download=1] → the file's bytes, with its type
 * (images by their bytes; HTML, SVG and scripts as plain text, never run) and
 * `Content-Disposition` inline, or attachment with `download`.
 * GET …/files/thumb?path=<path> → a copy of an image in the thread's folder at most 320 px on a side (PNG, or JPEG
 * for a JPEG), made by ImageMagick in the sandbox (decoded as what its name says, within memory, size and time
 * limits) and kept under `.lyrica/thumbs` until the image changes or goes; 404 for a grant's file, a name that is
 * not an image's, or a server without ImageMagick, when the panel shows the file itself.
 * POST …/files/upload?dir=<path>&name=<file> with the bytes → UploadResponse: saved under a free name in that folder.
 * POST …/files/folder { path } → Ok. POST …/files/rename { from, to } → Ok (a taken `to` is refused).
 * POST …/files/delete { paths } → Ok, for good. POST …/files/zip { paths } → application/zip, built as it streams.
 * A root itself can't be renamed or deleted; a read-only grant refuses every change (403); a path outside the
 * thread's folders is 403. Her next turn is told, by name, what the panel added or removed.
 */
export interface FileFolderInput { path: string }
export interface FileRenameInput { from: string; to: string }
export interface FilePathsInput { paths: string[] }

// --- The event stream ---

/**
 * GET /api/u/:userId/threads/:pool/:threadId/events: one SSE stream per thread.
 * Each event's `id` is `<epoch>-<n>`. Reconnecting with `Last-Event-ID` replays
 * what was missed from a small buffer; if that's no longer possible the stream
 * starts with `reset`, and the UI reloads messages. The SSE `event` field is
 * the `type` below, and `data` is the JSON of the whole event.
 */
export type ThreadEvent =
  /** First event on every connection: the thread's state now. */
  | { type: "hello"; busy: boolean; queued: string[]; permissions: PermissionRequest[] }
  /** Missed events can't be replayed: reload messages. */
  | { type: "reset" }
  | { type: "turn_start" }
  /** A new assistant message begins. */
  | { type: "message_start"; model?: string }
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  /** The model has started writing a tool call: shown at once, with its arguments when it runs (`tool_start`). */
  | { type: "tool_call"; toolCallId: string; name: string }
  | { type: "tool_start"; toolCallId: string; name: string; args: unknown }
  /** `result` is short: the first lines of the tool's output. */
  | { type: "tool_end"; toolCallId: string; name: string; result: string; isError: boolean; threads?: ThreadRef[]; image?: ImagePart; imageRefusal?: ImageRefusal }
  /** Memories recalled for this turn, automatically or with recall/read_memory. */
  | { type: "recall"; ids: string[] }
  /** Notes she saved. */
  | { type: "remember"; ids: string[] }
  | ({ type: "permission" } & PermissionRequest)
  | { type: "permission_end"; requestId: string; allowed: boolean; reason: "answered" | "timeout" | "stopped" }
  | { type: "usage"; input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
  /** Messages waiting as follow-ups. */
  | { type: "queue"; queued: string[] }
  /**
   * A message from another thread (`[From t:…]`) or a look (`[Watching
   * threads]`) that reached the running turn, or was kept in the stored
   * thread because the turn stopped or failed before taking it. Stored as a
   * user message with its mark.
   */
  | { type: "received"; text: string }
  /** In plain words: a model the router refused, an endpoint that's down, a failed tool setup. */
  | { type: "error"; message: string }
  /**
   * No model for the task could be reached: every machine in its list is down,
   * paused or stale. For a chat turn the message waits in `queue` and is sent
   * when one answers again. `tried`: labels and reasons, in list order.
   */
  | { type: "offline"; task: Task; tried: { label: string; reason: string }[] }
  | { type: "title"; title: string }
  /** Message n's reactions changed: hers, or the user's from another tab. */
  | { type: "reactions"; n: number; reactions: Reaction[] }
  /** The thread's settings changed (an approved plan switched its mode, say): fetch them again. */
  | { type: "settings" }
  /** In a project chat: one of its threads changed state; fetch it (`GET threads/:pool/:id`) to update its card in place. */
  | { type: "child"; threadId: string }
  /** The thread's pending wake-ups changed: set, removed or fired. Soonest first. */
  | { type: "wakeups"; wakeups: WakeupInfo[] }
  /** Her checklist for the thread changed (`threads steps`): the whole list, empty when cleared. */
  | { type: "steps"; steps: ThreadStep[] }
  /** The turn is over; the messages are stored. */
  | { type: "turn_end"; aborted: boolean }
  /** After each turn: the context as it now stands. */
  | { type: "context"; context: ContextInfo }
  /** The thread was compacted, by her or by Pi at the window's edge (also stored, as a `notice` message). */
  | { type: "compacted"; before: number; after?: number; summary: string }
  /**
   * A subagent run's event. It goes to the parent thread's stream and to the
   * subagent's own thread's stream.
   */
  | { type: "delegation"; event: DelegationEvent }
  /** A background run's result or question, just delivered into this thread (also stored, as a `notice` message). */
  | { type: "notice"; text: string; runId?: string; status?: string; threads?: ThreadRef[]; told?: Told[] }
  /** Messages from entry `from` on were removed (a rewind): drop them, and reload. `resend`: a message is being sent in their place. */
  | { type: "rewound"; from: number; resend?: true };

/** Which run and subagent thread an event is about, and its parent thread. */
export interface RunRef { userId: string; pool: Pool; parentThreadId: string; runId: string; threadId: string }
export type DelegationEvent =
  | (RunRef & { type: "started"; role: string; model: string; title: string })
  | (RunRef & { type: "output"; delta: string })
  | (RunRef & { type: "tool_call"; toolName: string; args: unknown })
  | (RunRef & { type: "question"; question: string })
  /** `ask_parent` with `wait: false`: it keeps working. */
  | (RunRef & { type: "note"; note: string })
  | (RunRef & { type: "finished"; status: "finished" | "failed" })
  | (RunRef & { type: "stopped"; reason: "stopped" | "timeout" | "parent_changed" })
  | (RunRef & { type: "interrupted" })
  | (RunRef & { type: "usage"; inputTokens: number; outputTokens: number });

export interface PermissionRequest {
  alwaysAllow?: string;
  requestId: string;
  toolCallId: string;
  /** "propose_plan" is a plan to approve, with `args` `{ plan }`: the plan card. "image" asks for daily portrait consent; its args carry { question, provider, model } with the resolved model label. */
  tool: string;
  args: unknown;
  /** When it is denied if nobody answers (ISO time). */
  expiresAt: string;
  /** Set for a call on a machine, with the folder a command runs in there. The answer covers exactly what is shown. */
  machine?: string;
  cwd?: string;
  /** A suspect command, with its warning sentence: the card offers Allow in this thread. */
  suspect?: true;
  warning?: string;
  /** Set for a call to an MCP tool its server doesn't mark read-only: the server's name and the tool's own name there. The card offers Allow in this thread. */
  server?: string;
  serverTool?: string;
  /**
   * Set for a subagent's tool call. The same request shows in the subagent's
   * thread and its parent's; either can answer it, and the first answer wins.
   */
  subagent?: { runId: string; threadId: string; parentThreadId: string; role: string };
}

// --- Subagents ---

export interface SubagentRun {
  run: string;
  /** The subagent's thread, nested under this one. */
  thread: string;
  role: string;
  model: string;
  background: boolean;
  status: "running" | "question" | "finished" | "failed" | "stopped" | "interrupted";
  inputTokens: number;
  outputTokens: number;
  startedAt: string;
  endedAt: string | null;
}

/** GET /api/u/:userId/threads/:pool/:threadId/subagents → Subagents: the thread's runs, newest first, and their total tokens. */
export interface Subagents { runs: SubagentRun[]; usage: { inputTokens: number; outputTokens: number } }

export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export interface Role {
  name: string;
  description: string;
  prompt: string;
  tier: "cheap" | "strong";
  /** Tool names it may use. */
  tools: string[];
  readOnly: boolean;
  thinking: Thinking;
}
export interface Step { task: string; role?: string; tier?: "cheap" | "strong"; model?: string }
export type WorkflowSpec =
  | { chain: Step[] }
  | { loop: { task: string; worker?: string; reviewer?: string; rounds?: number } }
  | { council: { question: string; models?: string[] } };
export interface Workflow { name: string; description: string; spec: WorkflowSpec }

/**
 * GET /api/u/:userId/roles → RoleInfo[]: built-in roles, with the user's own and their overrides.
 * PUT /api/u/:userId/roles/:name (a Role) → RoleInfo[]. A built-in's name overrides it.
 * DELETE /api/u/:userId/roles/:name → RoleInfo[]. Removing an override brings the built-in back.
 */
export interface RoleInfo extends Role { custom: boolean }
/**
 * GET /api/u/:userId/workflows → Workflow[]
 * PUT /api/u/:userId/workflows/:name (a Workflow) → Workflow[]
 * DELETE /api/u/:userId/workflows/:name → Workflow[]
 */

// --- Memory browser (the owner view) ---

export type MemoryKind = "note" | "page" | "journal" | "wake" | "entry" | "thread";
export type Origin = "lyrica" | "sleep" | "user";

/** A user as mention tokens (`[[u:ID]]`, `[[u:ID:obj]]`…) render: current name and pronouns. */
export type UserMap = Record<string, { displayName: string; pronouns: Pronouns }>;

export interface MemoryHit {
  pool: Pool;
  id: string;
  kind: MemoryKind;
  /** Around the query's words; the first line when listing a layer. */
  snippet: string;
  score: number;
  origin?: Origin;
  supersededBy?: string;
  /** A page's title. */
  title?: string;
  /** A note's tags. */
  about?: string[];
  /** The last change (a memory) or the message's time (an entry); the browse pane pages by it. */
  updatedAt?: string;
}

/**
 * GET /api/u/:userId/memory/search?q=&pool=&kinds=note,page&origin=user&about=&limit=&before= → MemoryHit[]
 * Honours the display filters (Show general, Show private); `?all=1` ignores them.
 * Without `q`: one layer, newest first, when `kinds` names exactly one of note, page, wake or journal
 * (`limit` and `before`, an `updatedAt`, page it; `about` keeps notes with that tag); with `origin=user` and
 * no single layer, what users introduced.
 */

/** GET /api/u/:userId/memory/about?pool= → MemoryTag[]: the shown pools' tags (notes' `about` words) with counts, most used first. */
export interface MemoryTag { about: string; count: number }

/** GET /api/u/:userId/memory → MemoryOverview, over the pools the display shows. */
export interface MemoryOverview {
  pages: number;
  notes: number;
  /** When she last finished sleeping, if ever. */
  slept?: string;
}

export interface MemoryItem {
  pool: Pool;
  id: string;
  kind: MemoryKind;
  /** Stored form, with mention tokens. Render with `users`; send edits back with the tokens kept. */
  text: string;
  title?: string;
  summary?: string;
  folders?: string[];
  about?: string[];
  origin?: Origin;
  author?: string;
  supersededBy?: string;
  archived?: boolean;
  flagged?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryRevision { id: number; body: Pick<MemoryItem, "text" | "title" | "summary" | "folders" | "about">; author: string; createdAt: string }

/**
 * What a memory's text or lineage points at, so the browser can show a title
 * instead of an ID and preview it. A thread's `title` is the thread's; a note
 * has none. Only memories from pools the display shows are here, and a general
 * memory's detail never carries a private one: the ID stays, the browser says
 * "Private is hidden" or "private note".
 */
export interface MemoryLink {
  kind: MemoryKind;
  pool: Pool;
  title?: string;
  /** The first line, in stored form (render with `users`), without its citations; a message's first words for an entry. */
  snippet: string;
  updatedAt: string;
  origin?: Origin;
  /** A thread deleted with its memories kept: no title, an empty snippet, `updatedAt` is when it was deleted. */
  deleted?: true;
}

/** A memory that cites this one, with the sentence that does (stored form), when its pool is shown. */
export interface MemoryUse { id: string; sentence?: string }

/** GET /api/u/:userId/memory/:pool/:id → MemoryDetail */
export interface MemoryDetail {
  item: MemoryItem;
  /** What it cites. IDs in the other pool carry it: `general/n:…`. */
  cameFrom: string[];
  /** What cites it. Private memory citing a general one shows as `private/n:…`, with no sentence. */
  usedIn: MemoryUse[];
  /** By the ID as it appears in the text, `cameFrom` or `usedIn`. */
  links: Record<string, MemoryLink>;
  /** Current and newest earlier version; all versions come from /history. */
  revisions: MemoryRevision[];
  users: UserMap;
}

/** PATCH /api/u/:userId/memory/:pool/:id → MemoryDetail. Saves a revision. `{user}` placeholders are accepted too. */
export interface MemoryEdit { text?: string; title?: string; summary?: string; folders?: string[]; about?: string[] }
/** POST /api/u/:userId/memory/:pool/:id/restore → MemoryDetail */
export interface MemoryRestore { revision: number }
/** POST /api/u/:userId/memory/:pool/:id/archive → MemoryDetail. The first deletion level, and its undo. */
export interface MemoryArchive { archived: boolean }
/** DELETE /api/u/:userId/memory/:pool/:id → Ok. Deletes a memory, leaving a tombstone. */
/** POST /api/u/:userId/memory/:pool/forget → Ok. Forgets a topic: deletes the reviewed matches at once. */
export interface ForgetTopic { ids: string[] }
// Forgetting a thread is DELETE on the thread.

/**
 * POST /api/u/:userId/memory/:pool/notes → MemoryDetail
 * POST /api/u/:userId/memory/:pool/pages → MemoryDetail
 * A memory the user introduces. `links` (t:, e:, n:, p: IDs) are cited; none makes it free.
 */
export interface NewNote { text: string; about?: string[]; links?: string[] }
export interface NewPage { slug: string; title: string; summary: string; text: string; folders?: string[]; links?: string[] }

// --- Administrators: /api/u/:userId/admin/… ---

/** GET /api/u/:userId/admin/status → AdminStatus */
export interface AdminStatus {
  /** Installed Debian units that differ from the last update release. */
  unitsStale?: string[];
  /** Why tools have no network on this host, if the self-test refused it. */
  networkRefused?: string;
  /** Whether the self.db passphrase is saved, so lyricad starts unlocked. */
  savedPassphrase: boolean;
  /** Where saved credentials go, and whether this host can save them. */
  credentials: { available: boolean; reason?: string };
}

/** PUT /api/u/:userId/admin/passphrase → AdminStatus. Saves (with the passphrase) or forgets the self.db passphrase. */
export interface PassphraseChange { save: boolean; passphrase?: string }

/** POST /api/u/:userId/admin/passphrase/change → AdminStatus, plus `note` when a saved passphrase could not be re-saved and was removed. Rekeys self.db with `next`; a wrong `current` is 403, counted on the limiter. */
export interface PassphraseRotate { current: string; next: string }

/** GET /api/u/:userId/admin/users → UserCard[] */
/** POST /api/u/:userId/admin/users → UserCard */
export interface NewUser { login: string; password: string; displayName: string; pronouns: Pronouns; admin: boolean }
/** PUT /api/u/:userId/admin/users/:targetId/admin → UserCard. The last administrator can't be demoted. */
/** PUT /api/u/:userId/admin/users/:targetId/password (AdminPassword) → Ok. The user's data stays (DESIGN.md, "Users"); they are logged out everywhere, and `Me.warning` tells them until they change it. 401 when `yourPassword` is wrong; 409 for a user with no recovery copy yet. */
export interface AdminPassword { password: string; /** The administrator's own password, asked again. */ yourPassword: string }
export interface AdminFlag { admin: boolean }
/** PATCH /api/u/:userId/admin/users/:targetId/profile → UserCard */

/** GET /api/u/:userId/admin/users/:targetId/paths → AllowedPaths */
/** POST /api/u/:userId/admin/users/:targetId/paths → AllowedPaths */
/** DELETE /api/u/:userId/admin/users/:targetId/paths → AllowedPaths (the same body) */
export interface PathChange { pool: Pool; path: string }

// --- Web access (administrators) ---

/**
 * "off": reachable only on this machine. "direct": lyricad's own HTTPS on this machine's addresses (the mode
 * she starts in). "tailnet": her tailscaled's `tailscale serve`. "builtin": the built-in Caddy. "external": a proxy elsewhere.
 */
export type WebMode = "off" | "direct" | "tailnet" | "builtin" | "external";

/** One of this machine's addresses that can serve Lyrica. */
export interface HostAddress { address: string; kind: "tailscale" | "lan"; interface: string }

export interface DnsProvider {
  id: string;
  name: string;
  fields: { name: string; label: string; secret: boolean; optional?: boolean }[];
  /** How to make a token limited to one zone. */
  hint: string;
}

/** GET /api/u/:userId/admin/web-access → WebAccess */
export interface WebAccess {
  mode: WebMode;
  /** Lyrica's name, e.g. lyrica.example.net. */
  name: string;
  builtin: {
    addresses: string[];
    provider: string;
    /** Secret fields say only whether they're set; other fields also carry their value. */
    credentials: Record<string, { set: boolean; value?: string }>;
    email?: string;
    staging: boolean;
  } | null;
  external: {
    /** The address and port lyricad listens on for the proxy. */
    address: string;
    port: number;
    /** The only addresses allowed to connect, and whose X-Forwarded-For is trusted. */
    proxies: string[];
    /** The proxy's own HTTPS port, which sandboxes never reach on its addresses. */
    proxyPort: number;
    /** On a LAN address lyricad serves HTTPS with its own certificate (naming only the address); on a Tailscale address, plain HTTP. */
    https: boolean;
    /** For the proxy to pin. */
    fingerprint?: string;
    pem?: string;
  } | null;
  /** Direct: lyricad's own HTTPS on these addresses and port, with a certificate naming them. */
  direct: { addresses: string[]; port: number; fingerprint: string; pem: string } | null;
  /** Tailnet: her name on the tailnet, and whether its HTTPS certificate came. */
  tailnet: { dnsName: string; certificates: boolean } | null;
  /** This machine's Tailscale and LAN addresses. */
  addresses: HostAddress[];
  providers: DnsProvider[];
}

/**
 * PUT /api/u/:userId/admin/web-access → WebAccess.
 * Applied and checked before it's saved: if it fails, the previous setup keeps running and the reason comes back.
 * Built-in: a new name keeps the old one served until its certificate verifies (up to 90 s), so this can take a while.
 * Credentials left out keep their saved values (for the same provider).
 */
export interface WebAccessChange {
  mode: WebMode;
  name?: string;
  builtin?: { addresses: string[]; provider: string; credentials?: Record<string, string>; email?: string; staging?: boolean };
  external?: { address: string; port: number; proxies: string[]; proxyPort?: number };
}

/** GET /api/u/:userId/admin/web-access/status → WebAccessStatus */
export interface WebAccessStatus {
  mode: WebMode;
  name: string;
  /**
   * Built-in mode: whether Caddy answers on its admin socket, has a site at all
   * (false: its saved config couldn't load at start and was set aside), and runs
   * the config lyricad gave it.
   */
  caddy?: { answers: boolean; configured: boolean; applied: boolean };
  /** Built-in mode: the certificate served for the name, read by connecting to it on this machine's address. */
  certificate?: { issuer: string; subject: string; notAfter: string } | { error: string };
  /** Caddy's newest TLS error since the last change, credentials hidden. */
  lastAcmeError?: { at: string; message: string };
  external?: { listening: boolean; address: string; port: number };
  /** Direct: the addresses it listens on now. */
  direct?: { listening: string[]; port: number; fingerprint: string };
  /** Tailnet: her name, and whether it answers over HTTPS now (checked from this machine), else why not. */
  tailnet?: { dnsName: string; answers: boolean; error?: string };
}

/** GET /api/u/:userId/admin/web-access/snippet → WebAccessSnippet: the external proxy's site, as a Caddyfile. */
export interface WebAccessSnippet { caddyfile: string }

/** GET /api/u/:userId/admin/name → NameSetting; PUT the same → NameSetting. Her name, 1 to 40 characters. Administrators. */
export interface NameSetting { name: string }

// --- The tailnet (administrators): her own tailscaled ---

/**
 * GET /api/u/:userId/admin/tailnet → Tailnet, read from her tailscaled each time.
 * "notInstalled": no tailscale binary, or her tailscaled isn't running (`reason` says which).
 */
export interface Tailnet {
  state: "connected" | "disconnected" | "notJoined" | "notInstalled";
  /** The tailnet's name, e.g. example.ts.net. */
  tailnet?: string;
  /** Her own Tailscale address. */
  address?: string;
  /** Her MagicDNS name, e.g. lyrica.example.ts.net. */
  dnsName?: string;
  hostname?: string;
  /** A Headscale server. Not filled yet: `tailscale status --json` doesn't carry it. */
  controlServer?: string;
  version?: string;
  reason?: string;
}

/**
 * PUT /api/u/:userId/admin/tailnet → Tailnet. Joins with an auth key, which is spent and never stored.
 * `hostname` is set only when given. Joined to another tailnet: 409 unless `leave`, which logs out first.
 * POST …/tailnet/disconnect and …/tailnet/connect → Tailnet; DELETE …/tailnet → Tailnet (leaves, turning
 * the Tailnet web mode off first). Disconnect, leave and a join that leaves are 409 when asked over her own
 * tailnet address: they would cut the request off.
 */
export interface TailnetJoin { authKey: string; hostname?: string; controlServer?: string; leave?: boolean }

/** GET /api/u/:userId/admin/sleep → SleepTime; PUT the same → SleepTime */
export interface SleepTime { time: string }

/**
 * GET /api/u/:userId/admin/web-search → WebSearch; PUT `{ searxng }` → WebSearch (null or "" clears it).
 * The server's SearXNG, for every thread's web_search; the state is a test search made on each call.
 * `reason` says why it is unreachable. A password in the address (basic auth) is never sent back:
 * `searxng` comes without it and `auth` says one is stored; a PUT with the same user@host and no
 * password keeps it, and one with a password replaces it. Administrators.
 */
export interface WebSearch { searxng: string | null; auth: boolean; state: "reachable" | "unreachable" | "unset"; reason?: string }

export interface PersonaProposal {
  id: number;
  path: string;
  text: string;
  /** The user who sent it on (`user:<id>`), and whether they changed its text: then the words are theirs. */
  sentBy: string;
  edited: boolean;
  /** The file has changed since it was proposed: approving would replace those changes, so it needs `overwrite`. */
  stale: boolean;
  base: number;
  /** What it replaces: the current text of the file, or empty for a new topic. */
  current: string;
  reason: string;
  author: string;
  createdAt: string;
}
/** GET /api/u/:userId/admin/proposals → PersonaProposal[]: open ones that users have sent on. */
/** POST /api/u/:userId/admin/proposals/:id → Ok. Approve applies the change; reject drops it. */
export interface ProposalDecision { approve: boolean; overwrite?: boolean }

// --- Sleep ---
// What she did each night, per pool, and what she'd like to raise. Text is in
// stored form, with mention tokens: render it with `users`, as in the memory browser.

export type SleepMode = "scheduled" | "manual";
export type SleepPhase = "consolidate" | "dream" | "wake";
export type SkipReason = "no-key" | "endpoint-down" | "no-activity";

export interface SleepRunInfo {
  pool: Pool;
  id: string;
  reason: "scheduled" | "manual";
  status: "running" | "complete" | "partial" | "skipped";
  skipReason?: SkipReason;
  /** Entries written before this are what the run covers. */
  until: string;
  /** Each phase's thread (interface `sleep`) and whether it finished. */
  phases: Partial<Record<SleepPhase, { thread: string; done: boolean }>>;
  startedAt: string;
  finishedAt?: string;
}

export interface SleepItemInfo {
  pool: Pool;
  id: string;
  run: string;
  kind: "thought" | "question" | "persona";
  text: string;
  /** What it came from: a memory ID, or `draft:<id>` / `proposal:<id>` for a persona suggestion. */
  source?: string;
  /** The chat started from it. */
  thread?: string;
  /** Neither started nor dismissed: the Sleep section shows a badge while any are new. */
  new: boolean;
  createdAt: string;
}

/** GET /api/u/:userId/sleep → SleepOverview: the mode, the sleep time, open items and the newest run of each pool, newest first. */
export interface SleepOverview { mode: SleepMode; time: string; items: SleepItemInfo[]; runs: SleepRunInfo[] }
/** PUT /api/u/:userId/sleep/mode → SleepOverview */
export interface SleepModeChange { mode: SleepMode }

/** GET /api/u/:userId/sleep/:pool/runs/:runId → SleepRunDetail */
export interface SleepRunDetail extends SleepRunInfo {
  /** Notes she wrote that she had missed in conversation. */
  notes: { id: string; text: string }[];
  /** Pages created or changed, each with its text before (absent for a new page) and after. */
  pages: { id: string; title?: string; before?: string; after: string }[];
  questions: SleepItemInfo[];
  /** Everything else she'd like to raise from this run. */
  items: SleepItemInfo[];
  dream: { id: string; text: string }[];
  wake?: string;
  users: UserMap;
}

/**
 * POST /api/u/:userId/sleep/:pool → SleepStarted. Sleeps the pool now (`/sleep`).
 * In manual mode it answers `confirm` unless `confirm: true` is sent; then, once
 * the run ends, a fresh thread opens in that pool (a `thread` event). Anything
 * that stops it at once (no key, endpoint down, nothing new) is a 409 in plain words.
 */
export interface SleepRequest { confirm?: boolean }
export type SleepStarted = { started: true } | { confirm: string };

/** POST /api/u/:userId/sleep/:pool/items/:itemId/chat → ThreadSummary: a new web thread where she opens with the item. */
/** DELETE /api/u/:userId/sleep/:pool/items/:itemId → Ok: dismissed. */

/** GET /api/u/:userId/sleep/events: SSE of SleepEvent, for this user's runs. */
export type SleepEvent =
  | { type: "started"; pool: Pool; runId: string; reason: "scheduled" | "manual" }
  | { type: "phase"; pool: Pool; runId: string; phase: SleepPhase; state: "started" | "done" | "stopped" }
  | { type: "finished"; pool: Pool; runId: string; status: SleepRunInfo["status"]; skipReason?: SkipReason }
  /** Manual mode: the fresh thread opened after the run. */
  | { type: "thread"; pool: Pool; threadId: string };

// --- Updates (docs/daemon.md "Updates"). The updater runs as root, outside lyricad. ---

/**
 * `<runtime>/update.sock`, for root's updater only (mode 0600, no login):
 * GET /health → Health, POST /drain → Drain, POST /undrain → Ok.
 * Names and IDs only, never text.
 */
export interface Health {
  commit: string;
  locked: boolean;
  checks: { name: string; ok: boolean; error?: string }[];
}
/** Work a drain waits for: a turn (or a message waiting for a model), a subagent run, a sleep run. */
export interface BusyItem { kind: "turn" | "subagent" | "sleep"; userId: string; pool?: Pool; threadId?: string }
/** POST /drain: new turns are refused (409 `{ updating: true }`) until /undrain or a restart. Empty `busy` means idle. */
export interface Drain { busy: BusyItem[] }

export type UpdaterState = "idle" | "fetching" | "building" | "testing" | "draining" | "switching" | "probation" | "failed";
/** An update note: an annotated `update/*` tag on a commit on main. */
export interface UpdateNote { tag: string; commit: string; message: string }
export interface KeptRelease {
  commit: string;
  builtAt: string;
  tag?: string;
  /** The first line of its update note; absent for a build with no note. */
  summary?: string;
  running: boolean;
  previous: boolean;
  /**
   * Whether it can be rolled back to. `restores`: going back restores the
   * snapshot taken then, and messages since are lost. `oldest`: when it
   * can't, the oldest kept release that can.
   */
  rollback: { possible: boolean; restores?: string; oldest?: string };
}
/** The last rollback, automatic (a failed probation) or asked for. */
export interface RollbackInfo { from: string; to: string; automatic: boolean; check?: string; at: string; restoredFrom?: string }
/**
 * GET /api/u/:userId/admin/updates → Updates. Administrators only.
 * `available` is false where no updater is installed (a development run).
 */
export interface Updates {
  available: boolean;
  running: { version: string; build: string };
  note: UpdateNote | null;
  state: { state: UpdaterState; since: string; tag?: string; commit?: string; busy?: BusyItem[]; error?: string };
  releases: KeptRelease[];
  lastRollback: RollbackInfo | null;
}
/** POST …/admin/updates → Updates: installs the tag's commit, once it is on main. */
export interface UpdateRequest { tag: string }
/** POST …/admin/updates/rollback → Updates: goes back to a kept release. */
export interface RollbackRequest { commit: string }
/** POST …/admin/updates/check → Updates: fetches, so the newest update note shows. */

/** A thread's wake-up, waiting: her note to herself stays in the pool, so only its time and ID are shown. */
export interface WakeupInfo { id: number; dueAt: string }

/** Settings → Claude Code: whether a token is saved (never the token) and whether the program is installed on this server. */
export interface ClaudeCodeStatus { token: boolean; installed: boolean }

/** Saves the token `claude setup-token` printed. */
export interface ClaudeCodeTokenInput { token: string }

/**
 * Settings → Claude Code and Codex: Codex, which makes ChatGPT Images: whether `codex` is installed,
 * whether the user's Codex is signed in, and a sign-in under way (Codex's own
 * device sign-in: open `url`, enter `code`). GET and DELETE (sign out)
 * /api/u/:userId/codex; POST …/codex/sign-in starts one.
 */
export interface CodexStatus { installed: boolean; signedIn: boolean; signIn?: { url: string; code: string } }
// --- Image files and portrait photos ---
/** GET /api/u/:userId/threads/:pool/:threadId/file?path=… → sniffed file bytes, no-store; thread folder only. */
/** GET /api/u/:userId/photos-of-me → PortraitPhoto[]; POST raw image bytes → UploadResponse; GET …/:name → sniffed portrait bytes, no-store; DELETE …/:name → Ok. */
export interface PortraitPhoto { path: string; size: number; type: string }
/** GET /api/u/:userId/photo-cloud; PUT { policy } → PhotoCloudSetting. */
export interface PhotoCloudSetting { policy: "never" | "ask" | "always" }

/** Routine metadata only; notes stay in the thread. */
export interface RoutineInfo { id: number; pool: Pool; threadId: string; threadTitle: string; schedule: string; nextAt: string; paused: boolean }

/** GET history endpoints: newest first, filtered total before limit/offset. */
export interface HistoryPage<T> { entries: T[]; total: number }
/** GET …/memory/:pool/:id/history; detail has the current item and display-safe links. */
export interface MemoryHistory extends HistoryPage<MemoryRevision> { detail: MemoryDetail }

/** A download as the host reports it (host/API.md, "POST /host/v1/downloads"). */
export interface HostDownload {
  id: string;
  source: Hub | "url";
  repo: string | null;
  url: string | null;
  /** Where it goes in the host's models folder: `lyrica/<source>/<repo>/<file>`, or `lyrica/url/<hostname>/<file>`. */
  path: string;
  size: number | null;
  received: number;
  state: "queued" | "downloading" | "verifying" | "done" | "failed" | "cancelled";
  /** true: the checksum matched; false: none was given; null until done. */
  verified: boolean | null;
  error: string | null;
  startedAt: string;
}


/** Finished downloads, newest first across manageable hosts. */
export interface DownloadHistory extends HistoryPage<{ endpointId: string; download: HostDownload }> {}
/** GET …/threads/:pool/:id/usage: counted turns and subagents. */
export interface ThreadUsage {
  tokens: number;
  gpuMs?: number;
  models: { label: string; kind?: "local" | "cloud"; tokens: number; gpuMs?: number }[];
  threads?: { threadId: string; tokens: number; gpuMs?: number }[];
}

/** GET/PUT/DELETE /api/u/:userId/push; POST …/push/test → 204 or 502 { status, reason }. */
export interface PushInfo {
  host: string; path: string; set: boolean; token: boolean; link: boolean;
  lastFailure?: { at: string; status: number };
}
export type { PushSettings } from "@lyrica/core";

/** GET /api/u/:userId/events: text-free list invalidation; hello on every connection. */
export type UserEvent = { type: "hello" } | { type: "changed" };
