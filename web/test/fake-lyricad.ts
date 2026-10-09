// A small in-memory stand-in for lyricad, built from daemon/src/api.ts, for
// developing the web UI before the real server is far enough along. It also
// serves web/dist. Run: npx tsx web/test/fake-lyricad.ts [port]
//
// Replies are scripted from the message text: "run <cmd>" makes her call bash
// (asking first in an ask mode), "slow" streams for a few seconds, and
// anything else gets a short streamed answer.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import type * as A from "../../daemon/src/api.ts";

const DIST = join(import.meta.dirname, "..", "dist");
const PASSPHRASE = "unlock me";
const now = () => new Date().toISOString();

const pronounsShe: A.Pronouns = { subj: "she", obj: "her", poss: "her", possPro: "hers", refl: "herself" };
const users: (A.UserCard & { password: string })[] = [
  { id: "u-li", login: "li", password: "pw", displayName: "Li", pronouns: pronounsShe, admin: true },
];
const endpoints: A.EndpointInfo[] = [
  { id: "openrouter", name: "OpenRouter", kind: "cloud", baseUrl: "https://openrouter.ai/api/v1", hasApiKey: true, shared: false,
    models: [{ modelId: "deepseek-4.1-flash", manual: false }, { modelId: "glm-5.3-flash", manual: false }] },
  { id: "blackwell", name: "Blackwell host", kind: "local", baseUrl: "http://192.168.1.50:8000/v1", hasApiKey: false, shared: false,
    models: [{ modelId: "qwen-3.8-27b", manual: false }, { modelId: "deepseek-4.1-flash", manual: false }] },
];
const profiles: A.Profiles = {
  cloud: { chat: { endpointId: "openrouter", modelId: "deepseek-4.1-flash" } },
  local: { chat: { endpointId: "blackwell", modelId: "qwen-3.8-27b" } },
};

let locked = true;
const sessions = new Map<string, Set<string>>();
const display: A.Display = { theme: "device", showGeneral: true, showPrivate: true, showHidden: false };

interface Thread {
  summary: A.ThreadSummary;
  overrides: Partial<Record<A.ThreadTask, A.ModelRef>>;
  localOnly: boolean;
  internet: boolean | null; services: boolean | null; hosts: string[] | null;
  grants: A.Grant[]; target: string; mode: A.PermissionMode;
  messages: A.Message[];
  events: { id: string; e: A.ThreadEvent }[];
  clients: Set<ServerResponse>;
  queued: string[];
  permissions: Map<string, { req: A.PermissionRequest; answer: (allow: boolean) => void }>;
  abort?: () => void;
}
const threads = new Map<string, Thread>();
let seq = 0;
const memories = new Map<string, A.MemoryItem & { revisions: A.MemoryRevision[] }>();
memories.set("general/n:1", {
  pool: "general", id: "n:1", kind: "note", text: "[[u:u-li]] wants the backup job on node 2 fixed before winter.",
  origin: "lyrica", createdAt: now(), updatedAt: now(), revisions: [],
});

// --- Threads ---

function newThread(pool: A.Pool, title?: string): Thread {
  const id = `web/${(++seq).toString(16).padStart(6, "0")}`;
  const t: Thread = {
    summary: { pool, id, interface: "web", title, subagent: false, hidden: false, unlogged: false, createdAt: now(), busy: false, children: [] },
    overrides: {}, localOnly: pool === "private", internet: null, services: null, hosts: null,
    grants: [], target: "sandbox", mode: "auto", messages: [], events: [], clients: new Set(), queued: [], permissions: new Map(),
  };
  threads.set(`${pool}/${id}`, t);
  return t;
}

function settingsOf(t: Thread): A.ThreadSettings {
  const local = t.localOnly || t.summary.pool === "private";
  const allowed = endpoints.filter((e) => !local || e.kind === "local");
  const models = {} as Record<A.ThreadTask, A.TaskModel>;
  for (const task of ["chat", "subagent.cheap", "subagent.strong", "compaction", "title"] as const) {
    const own = t.overrides[task];
    const fromProfile = (local ? profiles.local : profiles.cloud)[task];
    const model = own ?? fromProfile;
    const ep = endpoints.find((e) => e.id === model?.endpointId);
    models[task] = model ? { model, kind: ep?.kind, endpointName: ep?.name, source: own ? "thread" : "profile" } : { source: "none" };
  }
  const defaults = t.summary.pool === "private" ? { internet: false, services: false } : { internet: true, services: false };
  return {
    models, localOnly: local, internet: t.internet, services: t.services, hosts: t.hosts,
    network: { internet: t.internet ?? defaults.internet, services: t.services ?? defaults.services, hosts: t.hosts ?? [] },
    grants: t.grants, target: t.target, mode: t.mode, unlogged: t.summary.unlogged, parent: null, allowed,
  };
}

function emit(t: Thread, e: A.ThreadEvent) {
  const id = `1-${t.events.length + 1}`;
  t.events.push({ id, e });
  for (const c of t.clients) c.write(`id: ${id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runTurn(t: Thread, text: string) {
  t.summary.busy = true;
  let aborted = false;
  t.abort = () => { aborted = true; };
  t.messages.push({ id: `e:${t.summary.id}#${t.messages.length}`, n: t.messages.length, role: "user", parts: [{ type: "text", text }], createdAt: now() });
  emit(t, { type: "turn_start" });
  const s = settingsOf(t);
  const chat = s.models.chat;
  const model = chat.model?.modelId;
  const parts: A.MessagePart[] = [];
  emit(t, { type: "message_start", model });
  const say = async (words: string, delay = 25) => {
    for (const w of words.match(/\S+\s*/g) ?? []) {
      if (aborted) return;
      emit(t, { type: "text", delta: w });
      const last = parts.at(-1);
      if (last?.type === "text") last.text += w; else parts.push({ type: "text", text: w });
      await sleep(delay);
    }
  };
  let error: string | undefined;
  if (local(t) && chat.kind === "cloud") {
    error = "A cloud model can't be used in a local-only thread. Choose a local model.";
    emit(t, { type: "error", message: error });
  } else if (text.startsWith("run ")) {
    const command = text.slice(4);
    const toolCallId = `call-${Date.now()}`;
    emit(t, { type: "tool_start", toolCallId, name: "bash", args: { command } });
    const tool: A.MessagePart = { type: "tool", toolCallId, name: "bash", args: { command } };
    parts.push(tool);
    let allowed = true;
    if (t.mode !== "auto") {
      const requestId = `perm-${Date.now()}`;
      const req: A.PermissionRequest = { requestId, toolCallId, tool: "bash", args: { command }, expiresAt: new Date(Date.now() + 120_000).toISOString() };
      emit(t, { type: "permission", ...req });
      allowed = await new Promise<boolean>((resolve) => t.permissions.set(requestId, { req, answer: resolve }));
      t.permissions.delete(requestId);
      emit(t, { type: "permission_end", requestId, allowed, reason: "answered" });
    }
    const result = allowed ? `ran: ${command}` : "Denied by the user.";
    Object.assign(tool, { result, isError: !allowed });
    emit(t, { type: "tool_end", toolCallId, name: "bash", result, isError: !allowed });
    await say(allowed ? "Done. The command ran." : "All right, I won't run it.");
  } else if (text.includes("slow")) {
    await say("Let me think about this slowly. ".repeat(12), 120);
  } else {
    emit(t, { type: "recall", ids: ["n:1"] });
    parts.push({ type: "recall", ids: ["n:1"] });
    await say(`Hello! You said: **${text}**. Here is some code:\n\n\`\`\`sh\necho hi\n\`\`\`\n`);
  }
  t.messages.push({ id: `e:${t.summary.id}#${t.messages.length}`, n: t.messages.length, role: "assistant", parts, createdAt: now(), model, error });
  if (!t.summary.title) { t.summary.title = text.slice(0, 40); emit(t, { type: "title", title: t.summary.title }); }
  t.summary.busy = false;
  emit(t, { type: "turn_end", aborted });
  const next = t.queued.shift();
  if (next !== undefined) { emit(t, { type: "queue", queued: [...t.queued] }); void runTurn(t, next); }
}
const local = (t: Thread) => t.localOnly || t.summary.pool === "private";

// --- HTTP ---

async function body<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const s = Buffer.concat(chunks).toString();
  return (s ? JSON.parse(s) : {}) as T;
}

function send(res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(data));
}
const fail = (res: ServerResponse, status: number, error: string) => send(res, status, { error });

function cookieSession(req: IncomingMessage): string | undefined {
  return /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  const parts = url.pathname.split("/").slice(1).map(decodeURIComponent);
  const m = req.method ?? "GET";
  if (parts[0] !== "api") return serveStatic(url.pathname, res);
  const route = parts.slice(1);
  const sid = cookieSession(req);
  const logged = sid ? sessions.get(sid) : undefined;

  if (route[0] === "state") return send(res, 200, state(logged));
  if (route[0] === "unlock" && m === "POST") {
    const { passphrase } = await body<A.UnlockRequest>(req);
    if (passphrase !== PASSPHRASE) return fail(res, 400, "That passphrase didn't unlock Lyrica.");
    locked = false;
    return send(res, 200, state(logged));
  }
  if (locked) return fail(res, 503, "Lyrica is locked.");
  if (route[0] === "login" && m === "POST") {
    const { login, password } = await body<A.LoginRequest>(req);
    const user = users.find((x) => x.login === login && x.password === password);
    if (!user) return fail(res, 400, "That login name and password don't match.");
    const id = sid && sessions.has(sid) ? sid : Math.random().toString(36).slice(2);
    sessions.set(id, (sessions.get(id) ?? new Set()).add(user.id));
    return send(res, 200, { user: card(user) }, { "set-cookie": `sid=${id}; HttpOnly; SameSite=Strict; Path=/` });
  }
  if (route[0] === "logout" && m === "POST") {
    const { userId } = await body<A.LogoutRequest>(req);
    if (sid && userId) sessions.get(sid)?.delete(userId); else if (sid) sessions.delete(sid);
    return send(res, 200, { ok: true });
  }
  if (route[0] !== "u" || !route[1]) return fail(res, 404, "Not found.");
  const userId = route[1];
  if (!logged?.has(userId)) return fail(res, 401, "You're not logged in.");
  const user = users.find((x) => x.id === userId)!;
  const [section, a, b, c, d] = route.slice(2);

  if (section === "lock") { for (const s of sessions.values()) s.delete(userId); return send(res, 200, { ok: true }); }
  if (section === "me") {
    if (a === "profile" && m === "PATCH") Object.assign(user, await body<A.ProfileChange>(req));
    if (a === "display" && m === "PATCH") Object.assign(display, await body<A.DisplayChange>(req));
    if (a === "password" && m === "POST") return send(res, 200, { ok: true });
    return send(res, 200, { user: card(user), previousNames: [], display, savedCredentials: false } satisfies A.Me);
  }
  if (section === "endpoints") {
    if (!a) return send(res, 200, endpoints);
    if (b === "probe") return send(res, 200, { state: a === "openrouter" ? "up" : "down" } satisfies A.Probe);
    return send(res, 200, endpoints.find((e) => e.id === a));
  }
  if (section === "profiles") return send(res, 200, profiles);
  if (section === "network") return send(res, 200, { general: { internet: true, services: false, hosts: [] }, private: { internet: false, services: false, hosts: [] } });
  if (section === "paths") return send(res, 200, { general: ["/srv/homelab"], private: [] });
  if (section === "ssh") return send(res, 200, []);
  if (section === "admin") {
    if (a === "status") return send(res, 200, { savedPassphrase: false, credentials: { available: false, reason: "no systemd here" } });
    if (a === "users") return b ? send(res, 200, { general: [], private: [] }) : send(res, 200, users.map(card));
    if (a === "sleep") return send(res, 200, { time: "04:00" });
    if (a === "proposals") return send(res, 200, []);
  }
  if (section === "threads") return threadRoute(req, res, m, url, a, b, c, d);
  if (section === "memory") return memoryRoute(req, res, m, url, a, b, c);
  return fail(res, 404, "Not found.");
}

async function threadRoute(req: IncomingMessage, res: ServerResponse, m: string, url: URL, pool?: string, id?: string, sub?: string, arg?: string) {
  if (!pool) {
    if (m === "POST") { const { pool: p, title } = await body<A.NewThread>(req); return send(res, 200, newThread(p, title).summary); }
    const all = url.searchParams.get("all") === "1";
    const list = [...threads.values()].map((t) => t.summary)
      .filter((s) => all || ((s.pool === "general" ? display.showGeneral : display.showPrivate) && (display.showHidden || !s.hidden)))
      .reverse();
    return send(res, 200, list);
  }
  const t = threads.get(`${pool}/${id}`);
  if (!t) return fail(res, 404, "That thread doesn't exist.");
  if (!sub) {
    if (m === "PATCH") Object.assign(t.summary, await body<A.ThreadChange>(req));
    if (m === "DELETE") { threads.delete(`${pool}/${id}`); return send(res, 200, { ok: true }); }
    return send(res, 200, t.summary);
  }
  if (sub === "settings") {
    if (m === "PATCH") {
      const ch = await body<A.ThreadSettingsChange>(req);
      const localAfter = pool === "private" || (ch.localOnly ?? t.localOnly);
      for (const [task, ref] of Object.entries(ch.models ?? {})) {
        if (ref && localAfter && endpoints.find((e) => e.id === ref.endpointId)?.kind === "cloud") return fail(res, 400, "A cloud model can't be used in a private or local-only thread.");
        if (ref) t.overrides[task as A.ThreadTask] = ref; else delete t.overrides[task as A.ThreadTask];
      }
      if (ch.localOnly !== undefined && pool === "general") {
        t.localOnly = ch.localOnly;
        // Drop thread choices the router would now refuse.
        if (t.localOnly) for (const [k, r] of Object.entries(t.overrides)) if (endpoints.find((e) => e.id === r.endpointId)?.kind === "cloud") delete t.overrides[k as A.ThreadTask];
      }
      if (ch.hosts?.some((h) => /\s/.test(h))) return fail(res, 400, "An allowed host is an address, a range, a hostname or a URL, with no spaces.");
      if (ch.grants?.some((g) => !g.path.startsWith("/srv/homelab"))) return fail(res, 400, "That folder is outside the folders you may grant.");
      for (const k of ["internet", "services", "hosts", "grants", "target", "mode"] as const) if (ch[k] !== undefined) (t as unknown as Record<string, unknown>)[k] = ch[k];
      if (ch.unlogged !== undefined) t.summary.unlogged = ch.unlogged;
    }
    return send(res, 200, settingsOf(t));
  }
  if (sub === "messages") {
    if (m === "POST") {
      const { text } = await body<A.SendRequest>(req);
      if (t.summary.busy) { t.queued.push(text); emit(t, { type: "queue", queued: [...t.queued] }); return send(res, 200, { queued: true }); }
      void runTurn(t, text);
      return send(res, 200, { queued: false });
    }
    return send(res, 200, { messages: t.messages, hasMore: false } satisfies A.MessagePage);
  }
  if (sub === "stop") { t.abort?.(); for (const p of t.permissions.values()) p.answer(false); return send(res, 200, { ok: true }); }
  if (sub === "permissions" && arg) { t.permissions.get(arg)?.answer((await body<A.PermissionAnswer>(req)).allow); return send(res, 200, { ok: true }); }
  if (sub === "uploads") {
    for await (const _ of req) { /* drain */ }
    return send(res, 200, { path: `uploads/${url.searchParams.get("name")}` } satisfies A.UploadResponse);
  }
  if (sub === "events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    const hello: A.ThreadEvent = { type: "hello", busy: t.summary.busy, queued: t.queued, permissions: [...t.permissions.values()].map((p) => p.req) };
    res.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`);
    const last = req.headers["last-event-id"] ?? url.searchParams.get("lastEventId");
    if (last) {
      const i = t.events.findIndex((x) => x.id === last);
      for (const x of t.events.slice(i + 1)) res.write(`id: ${x.id}\nevent: ${x.e.type}\ndata: ${JSON.stringify(x.e)}\n\n`);
    }
    t.clients.add(res);
    req.on("close", () => t.clients.delete(res));
    return;
  }
  return fail(res, 404, "Not found.");
}

async function memoryRoute(req: IncomingMessage, res: ServerResponse, m: string, url: URL, pool?: string, id?: string, action?: string) {
  const usersMap: A.UserMap = Object.fromEntries(users.map((x) => [x.id, { displayName: x.displayName, pronouns: x.pronouns }]));
  const render = (s: string) => s.replace(/\[\[u:([^\]:]+)[^\]]*\]\]/g, (w, uid: string) => usersMap[uid]?.displayName ?? w);
  if (pool === "search") {
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const hits: A.MemoryHit[] = [...memories.values()]
      .filter((x) => render(x.text).toLowerCase().includes(q))
      .map((x) => ({ pool: x.pool, id: x.id, kind: x.kind, snippet: render(x.text), score: 1, origin: x.origin }));
    return send(res, 200, hits);
  }
  const item = memories.get(`${pool}/${id}`);
  if (!item) return fail(res, 404, "That memory doesn't exist.");
  const detail = (): A.MemoryDetail => {
    const { revisions, ...rest } = item;
    return { item: rest, cameFrom: ["e:web/000001#1"], usedIn: [], revisions: [...revisions].reverse(), users: usersMap };
  };
  if (m === "PATCH") {
    const edit = await body<A.MemoryEdit>(req);
    item.revisions.push({ id: item.revisions.length + 1, body: { text: item.text }, author: "u-li", createdAt: now() });
    Object.assign(item, edit, { updatedAt: now() });
  }
  if (action === "restore") {
    const { revision } = await body<A.MemoryRestore>(req);
    const r = item.revisions.find((x) => x.id === revision);
    if (r) { item.revisions.push({ id: item.revisions.length + 1, body: { text: item.text }, author: "u-li", createdAt: now() }); item.text = r.body.text; }
  }
  return send(res, 200, detail());
}

function card({ password: _, ...u }: (typeof users)[number]): A.UserCard { return u; }
function state(logged?: Set<string>): A.State {
  return { locked, users: locked ? [] : users.filter((x) => logged?.has(x.id)).map(card) };
}

const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };
async function serveStatic(path: string, res: ServerResponse) {
  const file = join(DIST, normalize(path === "/" ? "/index.html" : path));
  try {
    const data = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "content-security-policy": "default-src 'self'" });
    res.end(data);
  } catch { fail(res, 404, "Not found."); }
}

const port = Number(process.argv[2] ?? 7340);
createServer((req, res) => { handle(req, res).catch((e: Error) => fail(res, 500, e.message)); })
  .listen(port, "127.0.0.1", () => console.log(`fake lyricad on http://127.0.0.1:${port} (passphrase "${PASSPHRASE}", login li / pw)`));
