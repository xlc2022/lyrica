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
// - A browser session can hold several users (Li's personas). Everything a user
//   owns is under `/api/u/:userId/…`, and that user must be logged in on this
//   browser session.
// - Path segments are URI-encoded: thread IDs contain "/" (`web/3f7a2c`), so
//   `/threads/general/web%2F3f7a2c`.

// --- Shared vocabulary (mirrors @lyrica/core, kept here so the UI needs no core import) ---

export type Pool = "general" | "private";
export type Interface = "web" | "cli" | "matrix" | "forum" | "sleep";
export type Task =
  | "chat" | "subagent.cheap" | "subagent.strong" | "compaction"
  | "title" | "embedding" | "sleep.consolidate" | "sleep.dream" | "sleep.wake";
/** The tasks a thread can choose models for. */
export const THREAD_TASKS = ["chat", "subagent.cheap", "subagent.strong", "compaction", "title"] as const satisfies readonly Task[];
export type ThreadTask = (typeof THREAD_TASKS)[number];

export interface ModelRef { endpointId: string; modelId: string }
export interface Pronouns { subj: string; obj: string; poss: string; possPro: string; refl: string }
export type Theme = "device" | "light" | "dark";
/** "ask-commands" asks before bash; "ask-changes" before bash, write and edit. */
export type PermissionMode = "auto" | "ask-changes" | "ask-commands";
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

/** GET /api/state. Answers while locked. */
export interface State {
  locked: boolean;
  /** Users logged in on this browser session. Empty while locked. */
  users: UserCard[];
}

/** POST /api/unlock → State. Only while locked. */
export interface UnlockRequest { passphrase: string }

/** POST /api/login → LoginResponse. Adds the user to this browser session (creating it if needed). */
export interface LoginRequest { login: string; password: string }
export interface LoginResponse { user: UserCard }

/** POST /api/logout → Ok. Ends the cookie session, or with `userId` removes only that user from it. The key stays in memory. */
export interface LogoutRequest { userId?: string }

/** POST /api/u/:userId/lock → Ok. Drops the user's key and every session of theirs, in every browser. */

// --- The signed-in user: /api/u/:userId/me ---

export interface Display {
  theme: Theme;
  showGeneral: boolean;
  showPrivate: boolean;
  showHidden: boolean;
}

/** GET /api/u/:userId/me */
export interface Me {
  user: UserCard;
  previousNames: { name: string; until: string }[];
  display: Display;
  /** Whether this user's key is saved with systemd credentials, so it's unlocked at startup. */
  savedCredentials: boolean;
}

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

// --- Endpoints and model profiles ---

export interface EndpointModelInfo { modelId: string; contextWindow?: number; tools?: boolean; manual: boolean }

export interface EndpointInfo {
  /** Its name, or `shared.<name>` for a shared one. */
  id: string;
  name: string;
  kind: "cloud" | "local";
  baseUrl: string;
  /** API keys are never sent back. */
  hasApiKey: boolean;
  shared: boolean;
  models: EndpointModelInfo[];
}

/** GET /api/u/:userId/endpoints → EndpointInfo[] (own, then shared) */
/** POST /api/u/:userId/endpoints → EndpointInfo. `shared` needs an administrator. */
export interface EndpointInput { name: string; kind: "cloud" | "local"; baseUrl: string; apiKey?: string; shared?: boolean }
/** DELETE /api/u/:userId/endpoints/:endpointId → Ok */
/** POST /api/u/:userId/endpoints/:endpointId/discover → EndpointInfo. Re-reads /v1/models. */
/** POST /api/u/:userId/endpoints/:endpointId/models → EndpointInfo. Adds a model by hand. */
export interface ModelInput { modelId: string; contextWindow?: number; tools?: boolean }
/** GET /api/u/:userId/endpoints/:endpointId/probe → Probe */
export interface Probe { state: "up" | "down"; warning?: string }

/** GET /api/u/:userId/profiles → Profiles */
export interface Profiles {
  cloud: Partial<Record<Task, ModelRef>>;
  local: Partial<Record<Task, ModelRef>>;
}
/** PUT /api/u/:userId/profiles/:profile/:task → Profiles. The local profile takes local models only. */
export interface ProfileModelChange { model: ModelRef | null }

// --- Workspace defaults ---

/** GET /api/u/:userId/network → NetworkDefaults */
export type NetworkDefaults = Record<Pool, Network>;
/** PATCH /api/u/:userId/network/:pool → NetworkDefaults */
export type NetworkChange = Partial<Network>;

/** GET /api/u/:userId/paths → AllowedPaths: the folders this user may grant, set by an administrator. */
export type AllowedPaths = Record<Pool, string[]>;

export interface SshTargetInfo {
  name: string;
  host: string;
  port: number;
  username: string;
  root: string | null;
  /** Install this on the remote account. */
  publicKey: string;
  /** SHA-256 of the host key, pinned on first connection. */
  hostKey: string | null;
}
/** GET /api/u/:userId/ssh → SshTargetInfo[] */
/** POST /api/u/:userId/ssh → SshTargetInfo. Generates the key; `address` is account@host[:port]. */
export interface SshTargetInput { name: string; address: string; root?: string }
/** DELETE /api/u/:userId/ssh/:name → Ok */

// --- Threads ---

export interface ThreadSummary {
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
  /** Subagents' threads, nested under their parent. */
  children: ThreadSummary[];
}

/**
 * GET /api/u/:userId/threads?interface=web → ThreadSummary[]
 * One interface's threads (default `web`), most recently active first. Honours the user's
 * display filters (pools, hidden); `?all=1` ignores them. Subagents appear
 * only under their parent.
 */
/** POST /api/u/:userId/threads → ThreadSummary. Its interface is `web`. */
export interface NewThread { pool: Pool; title?: string }
/** GET /api/u/:userId/threads/:pool/:threadId → ThreadSummary */
/** PATCH /api/u/:userId/threads/:pool/:threadId → ThreadSummary. Rename, hide or unhide. */
export interface ThreadChange { title?: string; hidden?: boolean }
/** DELETE /api/u/:userId/threads/:pool/:threadId → Ok. Forgets the thread (memory.md, "Deletion"). */

/** Where a thread's model for one task comes from. */
export interface TaskModel {
  model?: ModelRef;
  kind?: "cloud" | "local";
  endpointName?: string;
  /** "thread" when overridden here, "profile" when following the profile, "none" when nothing is set. */
  source: "thread" | "profile" | "none";
  /** Why it can't be used, in plain words, if it can't. */
  problem?: string;
}

export interface ThreadSettings {
  models: Record<ThreadTask, TaskModel>;
  /** Always true in a private thread. */
  localOnly: boolean;
  /** Overrides of the user's per-pool defaults; null follows the default. */
  internet: boolean | null;
  services: boolean | null;
  hosts: string[] | null;
  /** What applies now, defaults included. All off while the host's network self-test refuses network. */
  network: Network;
  grants: Grant[];
  /** "sandbox" or "ssh:<name>". */
  target: string;
  mode: PermissionMode;
  /** "Do not log thread in memory". */
  unlogged: boolean;
  /** Set for a subagent: its settings are its parent's or stricter, and the UI shows them read-only. */
  parent: string | null;
  /** The endpoints and models this thread may choose from (local only when restricted). */
  allowed: EndpointInfo[];
}

/** GET /api/u/:userId/threads/:pool/:threadId/settings → ThreadSettings */
/**
 * PATCH /api/u/:userId/threads/:pool/:threadId/settings → ThreadSettings.
 * Refused as a whole, with the reason, if the router or the workspace would
 * refuse any part: a cloud model in a private or local-only thread, a folder
 * outside the allowed paths, a subagent wider than its parent.
 */
export interface ThreadSettingsChange {
  /** null clears the thread's choice, so the profile's applies. */
  models?: Partial<Record<ThreadTask, ModelRef | null>>;
  localOnly?: boolean;
  internet?: boolean | null;
  services?: boolean | null;
  hosts?: string[] | null;
  grants?: Grant[];
  target?: string;
  mode?: PermissionMode;
  unlogged?: boolean;
}

// --- Messages ---

/** One part of a stored message, as the UI draws it. */
export type MessagePart =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; toolCallId: string; name: string; args: unknown; result?: string; isError?: boolean; threads?: ThreadRef[] }
  | { type: "recall"; ids: string[] }
  | { type: "remember"; ids: string[] }
  /** A background subagent run's result or question, delivered into the thread. */
  | { type: "delegation"; text: string; runId?: string; status?: string; threads?: ThreadRef[] };

/** A `delegate` call's subagent threads, so its card can open them. */
export interface ThreadRef { pool: Pool; id: string }

export interface Message {
  /** The entry ID, `e:<thread>#<n>`. */
  id: string;
  /** Entry number in the thread, for paging. */
  n: number;
  /** "notice": something delivered into the thread, such as a background run's result. */
  role: "user" | "assistant" | "notice";
  parts: MessagePart[];
  createdAt: string;
  /** The model that wrote an assistant message. */
  model?: string;
  error?: string;
}

/**
 * GET /api/u/:userId/threads/:pool/:threadId/messages?before=<n>&limit=<k> → MessagePage
 * Newest page by default, oldest first within the page. Tool results are folded into their calls.
 */
export interface MessagePage { messages: Message[]; hasMore: boolean }

/**
 * POST /api/u/:userId/threads/:pool/:threadId/messages → SendResponse.
 * Starts a turn, or waits as a follow-up while one runs.
 */
export interface SendRequest { text: string }
export interface SendResponse { queued: boolean }

/** POST /api/u/:userId/threads/:pool/:threadId/stop → Ok. Aborts the running turn. */

/** POST /api/u/:userId/threads/:pool/:threadId/permissions/:requestId → Ok */
export interface PermissionAnswer { allow: boolean }

/**
 * POST /api/u/:userId/threads/:pool/:threadId/uploads?name=<file name> → UploadResponse.
 * The body is the file's bytes (any content type), up to the size limit.
 */
export interface UploadResponse { path: string }

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
  | { type: "tool_start"; toolCallId: string; name: string; args: unknown }
  /** `result` is short: the first lines of the tool's output. */
  | { type: "tool_end"; toolCallId: string; name: string; result: string; isError: boolean; threads?: ThreadRef[] }
  /** Memories recalled for this turn, automatically or with recall/read_memory. */
  | { type: "recall"; ids: string[] }
  /** Notes she saved. */
  | { type: "remember"; ids: string[] }
  | ({ type: "permission" } & PermissionRequest)
  | { type: "permission_end"; requestId: string; allowed: boolean; reason: "answered" | "timeout" | "stopped" }
  | { type: "usage"; input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
  /** Messages waiting as follow-ups. */
  | { type: "queue"; queued: string[] }
  /** In plain words: a model the router refused, an endpoint that's down, a failed tool setup. */
  | { type: "error"; message: string }
  | { type: "title"; title: string }
  /** The turn is over; the messages are stored. */
  | { type: "turn_end"; aborted: boolean }
  /**
   * A subagent run's event. It goes to the parent thread's stream and to the
   * subagent's own thread's stream.
   */
  | { type: "delegation"; event: DelegationEvent }
  /** A background run's result or question, just delivered into this thread (also stored, as a `notice` message). */
  | { type: "notice"; text: string; runId?: string; status?: string };

/** Which run and subagent thread an event is about, and its parent thread. */
export interface RunRef { userId: string; pool: Pool; parentThreadId: string; runId: string; threadId: string }
export type DelegationEvent =
  | (RunRef & { type: "started"; role: string; model: string; title: string })
  | (RunRef & { type: "output"; delta: string })
  | (RunRef & { type: "tool_call"; toolName: string; args: unknown })
  | (RunRef & { type: "question"; question: string })
  | (RunRef & { type: "finished"; status: "finished" | "failed" })
  | (RunRef & { type: "stopped"; reason: "stopped" | "timeout" | "parent_changed" })
  | (RunRef & { type: "interrupted" })
  | (RunRef & { type: "usage"; inputTokens: number; outputTokens: number });

export interface PermissionRequest {
  requestId: string;
  toolCallId: string;
  tool: string;
  args: unknown;
  /** When it is denied if nobody answers (ISO time). */
  expiresAt: string;
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
  /** Rendered with current names. */
  snippet: string;
  score: number;
  origin?: Origin;
  supersededBy?: string;
}

/**
 * GET /api/u/:userId/memory/search?q=&pool=&kinds=note,page&origin=user&limit= → MemoryHit[]
 * Honours the display filters (Show general, Show private); `?all=1` ignores them.
 * Without `q`, `origin=user` lists what users introduced.
 */

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

/** GET /api/u/:userId/memory/:pool/:id → MemoryDetail */
export interface MemoryDetail {
  item: MemoryItem;
  /** What it cites. IDs in the other pool carry it: `general/n:…`. */
  cameFrom: string[];
  /** What cites it. Private memory citing a general one shows as `private/n:…`. */
  usedIn: string[];
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
  /** Why tools have no network on this host, if the self-test refused it. */
  networkRefused?: string;
  /** Whether the self.db passphrase is saved, so lyricad starts unlocked. */
  savedPassphrase: boolean;
  /** Where saved credentials go, and whether this host can save them. */
  credentials: { available: boolean; reason?: string };
}

/** PUT /api/u/:userId/admin/passphrase → AdminStatus. Saves (with the passphrase) or forgets the self.db passphrase. */
export interface PassphraseChange { save: boolean; passphrase?: string }

/** GET /api/u/:userId/admin/users → UserCard[] */
/** POST /api/u/:userId/admin/users → UserCard */
export interface NewUser { login: string; password: string; displayName: string; pronouns: Pronouns; admin: boolean }
/** PUT /api/u/:userId/admin/users/:targetId/admin → UserCard. The last administrator can't be demoted. */
export interface AdminFlag { admin: boolean }
/** PATCH /api/u/:userId/admin/users/:targetId/profile → UserCard */

/** GET /api/u/:userId/admin/users/:targetId/paths → AllowedPaths */
/** POST /api/u/:userId/admin/users/:targetId/paths → AllowedPaths */
/** DELETE /api/u/:userId/admin/users/:targetId/paths → AllowedPaths (the same body) */
export interface PathChange { pool: Pool; path: string }

// --- Web access (administrators) ---

/** "off": reachable only on this machine. "builtin": the built-in Caddy. "external": a proxy elsewhere. */
export type WebMode = "off" | "builtin" | "external";

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
}

/** GET /api/u/:userId/admin/web-access/snippet → WebAccessSnippet: the external proxy's site, as a Caddyfile. */
export interface WebAccessSnippet { caddyfile: string }

/** GET /api/u/:userId/admin/sleep → SleepTime; PUT the same → SleepTime */
export interface SleepTime { time: string }

export interface PersonaProposal {
  id: number;
  path: string;
  text: string;
  /** What it replaces: the current text of the file, or empty for a new topic. */
  current: string;
  reason: string;
  author: string;
  createdAt: string;
}
/** GET /api/u/:userId/admin/proposals → PersonaProposal[] (open ones) */
/** POST /api/u/:userId/admin/proposals/:id → Ok. Approve applies the change; reject drops it. */
export interface ProposalDecision { approve: boolean }
