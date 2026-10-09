import {
  AuthError, WrongPassword, checkTask, isRestricted, publicKeyOf, generateSshKey, CloudModelForbidden, NoModel, PRONOUN_PRESETS,
  type Author, type Hit, type Item, type OwnerView, type Pool, type PoolStore, type Thread, type User,
} from "@lyrica/core";
import type * as Api from "./api.ts";
import { THREAD_TASKS } from "./api.ts";
import { Sessions } from "./auth.ts";
import { HttpError, route, type Request, type Route } from "./http.ts";
import { card, type Lyricad, type Services } from "./lyricad.ts";
import { toMessages } from "./messages.ts";

const DISPLAY_DEFAULTS: Api.Display = { theme: "device", showGeneral: true, showPrivate: true, showHidden: false };
const DISPLAY_DEFAULTS_ALL: Api.Display = { ...DISPLAY_DEFAULTS, showPrivate: true, showGeneral: true, showHidden: true };
const MESSAGE_PAGE = 50;

/** Every API route. Locked, only /api/state and /api/unlock answer (lyricad.ts enforces it). */
export function apiRoutes(d: Lyricad): Route[] {
  const s = (): Services => d.services!;
  const u = "/api/u/:userId";
  const t = `${u}/threads/:pool/:threadId`;

  return [
    // --- State, unlock, login ---
    route("GET", "/api/state", (r) => d.state(r.cookie)),
    route("POST", "/api/unlock", async (r) => {
      const { passphrase } = await r.json<Api.UnlockRequest>();
      await limited(d, [`unlock:${r.ip}`], () => d.unlock(String(passphrase ?? "")), "wrong passphrase");
      return d.state(r.cookie);
    }),
    route("POST", "/api/login", async (r): Promise<Api.LoginResponse> => {
      const { login, password } = await r.json<Api.LoginRequest>();
      const keys = [`login:${String(login ?? "").trim().toLowerCase()}`, `ip:${r.ip}`];
      const user = await limited(d, keys, () => s().users.authenticate(String(login ?? ""), String(password ?? "")), "wrong login or password");
      await d.keyAvailable(user.id);
      let session = r.cookie;
      if (!d.sessions.users(session)) session = d.sessions.create();
      d.sessions.addUser(session!, user.id);
      r.res.setHeader("set-cookie", Sessions.setCookie(session!));
      return { user: card(user) };
    }),
    route("POST", "/api/logout", async (r) => {
      const { userId } = await r.json<Api.LogoutRequest>();
      if (!d.sessions.users(r.cookie)) throw new HttpError(401, "not logged in");
      if (userId) d.sessions.removeUser(r.cookie!, userId);
      else {
        d.sessions.end(r.cookie!);
        r.res.setHeader("set-cookie", Sessions.clearCookie());
      }
      return { ok: true };
    }),
    route("POST", `${u}/lock`, async (r) => {
      const user = d.userFor(r);
      await d.lockUser(user.id);
      return { ok: true };
    }),

    // --- The signed-in user ---
    route("GET", `${u}/me`, (r) => me(d, d.userFor(r))),
    route("PATCH", `${u}/me/profile`, async (r) => {
      const user = d.userFor(r);
      s().users.updateProfile(user, user, pick(await r.json<Api.ProfileChange>(), ["displayName", "pronouns", "accent", "monogram"]));
      return me(d, user);
    }),
    route("PATCH", `${u}/me/display`, async (r) => {
      const user = d.userFor(r);
      const change = await r.json<Api.DisplayChange>();
      const next = { ...display(d, user.id), ...pick(change, ["theme", "showGeneral", "showPrivate", "showHidden"]) };
      if (!["device", "light", "dark"].includes(next.theme)) throw new Error("the theme is device, light or dark");
      const db = s().users.openUserDb(user.id);
      try {
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('display', ?)").run(JSON.stringify(next));
      } finally {
        db.close();
      }
      return me(d, user);
    }),
    route("POST", `${u}/me/password`, async (r) => {
      const user = d.userFor(r);
      const { oldPassword, newPassword } = await r.json<Api.PasswordChange>();
      const keys = [`login:${user.login.toLowerCase()}`, `ip:${r.ip}`];
      await limited(d, keys, () => s().users.changePassword(user, String(oldPassword ?? ""), String(newPassword ?? "")), "the current password is wrong");
      return { ok: true };
    }),
    route("PUT", `${u}/me/credentials`, async (r) => {
      const user = d.userFor(r);
      const { save } = await r.json<Api.CredentialsChange>();
      if (save) await d.keyring.saveUserKey(user.id);
      else await d.keyring.forgetSavedKey(user.id);
      return me(d, user);
    }),

    // --- Endpoints and profiles ---
    route("GET", `${u}/endpoints`, (r) => endpoints(d, d.userFor(r).id)),
    route("POST", `${u}/endpoints`, async (r) => {
      const user = d.userFor(r);
      const input = await r.json<Api.EndpointInput>();
      const ep = s().models.addEndpoint(user, { name: input.name, kind: input.kind, baseUrl: input.baseUrl, apiKey: input.apiKey }, { shared: !!input.shared });
      await s().models.discover(user, ep.id).catch(() => {}); // a server that's down now can be discovered later
      return endpointInfo(d, user.id, ep.id);
    }),
    route("DELETE", `${u}/endpoints/:endpointId`, (r) => {
      s().models.removeEndpoint(d.userFor(r), r.params.endpointId!);
      return { ok: true };
    }),
    route("POST", `${u}/endpoints/:endpointId/discover`, async (r) => {
      const user = d.userFor(r);
      await s().models.discover(user, r.params.endpointId!);
      return endpointInfo(d, user.id, r.params.endpointId!);
    }),
    route("POST", `${u}/endpoints/:endpointId/models`, async (r) => {
      const user = d.userFor(r);
      const m = await r.json<Api.ModelInput>();
      s().models.addModel(user, r.params.endpointId!, { modelId: String(m.modelId ?? ""), contextWindow: m.contextWindow, tools: m.tools });
      return endpointInfo(d, user.id, r.params.endpointId!);
    }),
    route("GET", `${u}/endpoints/:endpointId/probe`, (r) => s().models.probe(d.userFor(r).id, r.params.endpointId!)),
    route("GET", `${u}/profiles`, (r) => profiles(d, d.userFor(r).id)),
    route("PUT", `${u}/profiles/:profile/:task`, async (r) => {
      const user = d.userFor(r);
      const name = r.params.profile;
      if (name !== "cloud" && name !== "local") throw new HttpError(404, "the profiles are cloud and local");
      const { model } = await r.json<Api.ProfileModelChange>();
      s().models.setProfile(user.id, name, checkTask(r.params.task!), model ?? undefined);
      return profiles(d, user.id);
    }),

    // --- Workspace defaults, allowed paths, SSH ---
    route("GET", `${u}/network`, (r) => networkDefaults(d, d.userFor(r).id)),
    route("PATCH", `${u}/network/:pool`, async (r) => {
      const user = d.userFor(r);
      const change = pick(await r.json<Api.NetworkChange>(), ["internet", "services", "hosts"]);
      s().workspace.settings(user.id).setDefaultNetwork(poolOf(r), change);
      return networkDefaults(d, user.id);
    }),
    route("GET", `${u}/paths`, (r) => s().workspace.allowedPaths.list(d.userFor(r).id)),
    route("GET", `${u}/ssh`, (r) => sshTargets(d, d.userFor(r).id)),
    route("POST", `${u}/ssh`, async (r) => {
      const user = d.userFor(r);
      const input = await r.json<Api.SshTargetInput>();
      const m = /^([^@\s]+)@([^:\s]+)(?::(\d+))?$/.exec(String(input.address ?? ""));
      if (!m) throw new Error("the address looks like account@host or account@host:port");
      const key = generateSshKey(`lyrica:${user.login}:${input.name}`);
      s().workspace.settings(user.id).addSsh({ name: String(input.name ?? ""), username: m[1]!, host: m[2]!, port: Number(m[3] ?? 22), privateKey: key.privateKey, root: input.root || null });
      return sshTargets(d, user.id).find((x) => x.name === input.name);
    }),
    route("DELETE", `${u}/ssh/:name`, (r) => {
      s().workspace.settings(d.userFor(r).id).removeSsh(r.params.name!);
      return { ok: true };
    }),

    // --- Threads ---
    route("GET", `${u}/threads`, (r) => {
      const user = d.userFor(r);
      const all = r.query.get("all") === "1";
      const iface = r.query.get("interface") ?? "web";
      const show = display(d, user.id);
      return owner(d, user, (o) => (["general", "private"] as const)
        .filter((p) => all || (p === "general" ? show.showGeneral : show.showPrivate))
        .flatMap((p) => tree(d, user, p, o[p], o[p].listThreads({ includeHidden: all || show.showHidden }).filter((x) => x.interface === iface)))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    }),
    route("POST", `${u}/threads`, async (r) => {
      const user = d.userFor(r);
      const input = await r.json<Api.NewThread>();
      const pool = checkPool(input.pool);
      return owner(d, user, (o) => {
        const thread = o[pool].createThread({ interface: "web", title: input.title?.trim() || undefined });
        return summary(d, user, pool, o[pool], thread, []);
      });
    }),
    route("GET", t, (r) => {
      const user = d.userFor(r);
      return owner(d, user, (o) => summary(d, user, poolOf(r), o[poolOf(r)], threadOf(o, r), []));
    }),
    route("PATCH", t, async (r) => {
      const user = d.userFor(r);
      const change = await r.json<Api.ThreadChange>();
      return owner(d, user, (o) => {
        const store = o[poolOf(r)];
        const thread = threadOf(o, r);
        if (change.title !== undefined) store.setTitle(thread.id, String(change.title));
        if (change.hidden !== undefined) store.setHidden(thread.id, !!change.hidden);
        return summary(d, user, poolOf(r), store, store.getThread(thread.id)!, []);
      });
    }),
    route("DELETE", t, async (r) => {
      const user = d.userFor(r);
      const pool = poolOf(r);
      const threadId = owner(d, user, (o) => threadOf(o, r).id);
      await s().host.forget(user.id, pool, threadId);
      owner(d, user, (o) => o[pool].forgetThread(threadId, author(user)));
      return { ok: true };
    }),
    route("GET", `${t}/settings`, (r) => {
      const user = d.userFor(r);
      owner(d, user, (o) => threadOf(o, r));
      return threadSettings(d, user, poolOf(r), r.params.threadId!);
    }),
    route("PATCH", `${t}/settings`, async (r) => {
      const user = d.userFor(r);
      const change = await r.json<Api.ThreadSettingsChange>();
      const pool = poolOf(r);
      const thread = owner(d, user, (o) => threadOf(o, r));
      changeSettings(d, user, pool, thread, change);
      s().host.reload(user.id, pool, thread.id);
      return threadSettings(d, user, pool, thread.id);
    }),
    route("GET", `${t}/messages`, (r) => {
      const user = d.userFor(r);
      const before = r.query.get("before");
      const limit = Math.min(200, Math.max(1, Number(r.query.get("limit") ?? MESSAGE_PAGE) || MESSAGE_PAGE));
      return owner(d, user, (o): Api.MessagePage => {
        const thread = threadOf(o, r);
        const page = o[poolOf(r)].entryPage(thread.id, { before: before ? Number(before) : undefined, limit });
        return { messages: toMessages(thread.id, page.entries), hasMore: page.hasMore };
      });
    }),
    route("POST", `${t}/messages`, async (r) => {
      const user = d.userFor(r);
      const { text } = await r.json<Api.SendRequest>();
      const thread = owner(d, user, (o) => threadOf(o, r));
      return s().host.get(user.id, poolOf(r), thread.id).send(String(text ?? ""));
    }),
    route("POST", `${t}/stop`, async (r) => {
      const user = d.userFor(r);
      const thread = owner(d, user, (o) => threadOf(o, r));
      await s().host.get(user.id, poolOf(r), thread.id).stop();
      return { ok: true };
    }),
    route("POST", `${t}/permissions/:requestId`, async (r) => {
      const user = d.userFor(r);
      const { allow } = await r.json<Api.PermissionAnswer>();
      const thread = owner(d, user, (o) => threadOf(o, r));
      if (!s().host.get(user.id, poolOf(r), thread.id).answer(r.params.requestId!, allow === true)) throw new HttpError(404, "that request is no longer waiting");
      return { ok: true };
    }),
    route("POST", `${t}/uploads`, async (r): Promise<Api.UploadResponse> => {
      const user = d.userFor(r);
      const thread = owner(d, user, (o) => threadOf(o, r));
      const name = r.query.get("name") ?? "";
      const bytes = await r.bytes(d.opts.uploadLimit ?? 50 * 1024 * 1024);
      const path = await s().workspace.saveUpload({ userId: user.id, pool: poolOf(r), threadId: thread.id }, name, bytes);
      return { path };
    }),
    route("GET", `${t}/events`, (r) => {
      const user = d.userFor(r);
      const thread = owner(d, user, (o) => threadOf(o, r));
      const hosted = s().host.get(user.id, poolOf(r), thread.id);
      const { res } = r;
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store",
        "content-security-policy": "default-src 'none'", "x-content-type-options": "nosniff",
      });
      res.write("retry: 3000\n\n");
      // Logout and Lock end live streams: the session is checked with every event and every few seconds.
      const allowed = () => !!d.sessions.users(r.cookie)?.has(user.id) && d.keyring.hasUserKey(user.id);
      const stop = hosted.subscribe((id, event) => {
        if (!allowed()) return void res.end();
        res.write(`id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        if (event.type === "reset" && hosted.closed) res.end(); // Lock or shutdown: the stream is over
      }, r.req.headers["last-event-id"] as string | undefined);
      let ticks = 0;
      const check = setInterval(() => {
        if (!allowed()) return void res.end();
        if (++ticks % 10 === 0) res.write(": keep-alive\n\n");
      }, 2_500);
      res.on("close", () => { clearInterval(check); stop(); });
      return undefined;
    }),

    // --- Memory browser, through the owner view ---
    route("GET", `${u}/memory/search`, (r) => {
      const user = d.userFor(r);
      const q = r.query.get("q")?.trim() ?? "";
      const show = r.query.get("all") === "1" ? DISPLAY_DEFAULTS_ALL : display(d, user.id);
      const pools = (r.query.get("pool") ? [checkPool(r.query.get("pool"))] : (["general", "private"] as const))
        .filter((p) => (p === "general" ? show.showGeneral : show.showPrivate));
      const kinds = r.query.get("kinds")?.split(",").filter(Boolean) as Hit["kind"][] | undefined;
      const origin = r.query.get("origin") ?? undefined;
      const limit = Math.min(100, Number(r.query.get("limit") ?? 30) || 30);
      return owner(d, user, (o) => pools.flatMap((pool): Api.MemoryHit[] => {
        const store = o[pool];
        const hits: Hit[] = q
          ? store.search(q, { kinds, limit: limit * 2, includeArchived: true })
          : store.userIntroduced().map((id) => store.get(id)).filter((x): x is Item => !!x).map((i) => ({
            id: i.id, kind: i.kind, snippet: (i.title ? `${i.title}: ` : "") + i.text.slice(0, 200), score: 0, origin: i.origin, author: i.author,
          }));
        return hits.filter((h) => !origin || h.origin === origin)
          .map((h) => ({ pool, id: h.id, kind: h.kind, snippet: h.snippet, score: h.score, ...(h.origin ? { origin: h.origin } : {}), ...(h.supersededBy ? { supersededBy: h.supersededBy } : {}) }));
      }).sort((a, b) => b.score - a.score).slice(0, limit));
    }),
    route("POST", `${u}/memory/:pool/notes`, async (r) => {
      const user = d.userFor(r);
      const input = await r.json<Api.NewNote>();
      return owner(d, user, (o) => {
        const store = o[poolOf(r)];
        const [id] = store.addNotes([{ text: withLinks(String(input.text ?? ""), input.links), about: input.about }], { author: author(user) });
        return memoryDetail(d, o, poolOf(r), id!);
      });
    }),
    route("POST", `${u}/memory/:pool/pages`, async (r) => {
      const user = d.userFor(r);
      const p = await r.json<Api.NewPage>();
      return owner(d, user, (o) => {
        const store = o[poolOf(r)];
        if (store.get(`p:${p.slug}`)) throw new HttpError(409, `a page p:${p.slug} already exists`);
        const id = store.putPage({ slug: String(p.slug ?? ""), title: String(p.title ?? ""), summary: String(p.summary ?? ""), text: withLinks(String(p.text ?? ""), p.links), folders: p.folders }, author(user));
        return memoryDetail(d, o, poolOf(r), id);
      });
    }),
    route("POST", `${u}/memory/:pool/forget`, async (r) => {
      const user = d.userFor(r);
      const { ids } = await r.json<Api.ForgetTopic>();
      if (!Array.isArray(ids)) throw new Error("ids is a list of memory IDs");
      owner(d, user, (o) => o[poolOf(r)].deleteMany(ids.map(String), author(user)));
      return { ok: true };
    }),
    route("GET", `${u}/memory/:pool/:id`, (r) => owner(d, d.userFor(r), (o) => memoryDetail(d, o, poolOf(r), r.params.id!))),
    route("PATCH", `${u}/memory/:pool/:id`, async (r) => {
      const user = d.userFor(r);
      const change = pick(await r.json<Api.MemoryEdit>(), ["text", "title", "summary", "folders", "about"]);
      return owner(d, user, (o) => {
        o[poolOf(r)].edit(memoryId(o, r), change, author(user));
        return memoryDetail(d, o, poolOf(r), r.params.id!);
      });
    }),
    route("POST", `${u}/memory/:pool/:id/restore`, async (r) => {
      const user = d.userFor(r);
      const { revision } = await r.json<Api.MemoryRestore>();
      return owner(d, user, (o) => {
        o[poolOf(r)].restore(memoryId(o, r), Number(revision), author(user));
        return memoryDetail(d, o, poolOf(r), r.params.id!);
      });
    }),
    route("POST", `${u}/memory/:pool/:id/archive`, async (r) => {
      const user = d.userFor(r);
      const { archived } = await r.json<Api.MemoryArchive>();
      return owner(d, user, (o) => {
        o[poolOf(r)].archive(memoryId(o, r), archived !== false, author(user));
        return memoryDetail(d, o, poolOf(r), r.params.id!);
      });
    }),
    route("DELETE", `${u}/memory/:pool/:id`, (r) => {
      const user = d.userFor(r);
      owner(d, user, (o) => o[poolOf(r)].delete(memoryId(o, r), author(user)));
      return { ok: true };
    }),

    // --- Administrators ---
    route("GET", `${u}/admin/status`, (r) => { d.adminFor(r); return adminStatus(d); }),
    route("PUT", `${u}/admin/passphrase`, async (r) => {
      d.adminFor(r);
      const { save, passphrase } = await r.json<Api.PassphraseChange>();
      if (save) await d.keyring.saveSelfPassphrase(String(passphrase ?? ""));
      else await d.keyring.forgetSelfPassphrase();
      return adminStatus(d);
    }),
    route("GET", `${u}/admin/users`, (r) => s().users.listUsers(d.adminFor(r)).map(card)),
    route("POST", `${u}/admin/users`, async (r) => {
      d.adminFor(r);
      const n = await r.json<Api.NewUser>();
      const created = await s().users.createUser(String(n.login ?? ""), String(n.password ?? ""),
        { displayName: String(n.displayName ?? ""), pronouns: n.pronouns ?? PRONOUN_PRESETS.they }, { admin: !!n.admin });
      return card(created);
    }),
    route("PUT", `${u}/admin/users/:targetId/admin`, async (r) => {
      const actor = d.adminFor(r);
      const { admin } = await r.json<Api.AdminFlag>();
      s().users.setAdmin(actor, target(d, r), !!admin);
      return card(target(d, r));
    }),
    route("PATCH", `${u}/admin/users/:targetId/profile`, async (r) => {
      const actor = d.adminFor(r);
      s().users.updateProfile(actor, target(d, r), pick(await r.json<Api.ProfileChange>(), ["displayName", "pronouns", "accent", "monogram"]));
      return card(target(d, r));
    }),
    route("GET", `${u}/admin/users/:targetId/paths`, (r) => { d.adminFor(r); return s().workspace.allowedPaths.list(target(d, r).id); }),
    route("POST", `${u}/admin/users/:targetId/paths`, async (r) => {
      const actor = d.adminFor(r);
      const { pool, path } = await r.json<Api.PathChange>();
      s().workspace.allowedPaths.allow(actor, target(d, r).id, checkPool(pool), String(path ?? ""));
      return s().workspace.allowedPaths.list(target(d, r).id);
    }),
    route("DELETE", `${u}/admin/users/:targetId/paths`, async (r) => {
      const actor = d.adminFor(r);
      const { pool, path } = await r.json<Api.PathChange>();
      s().workspace.allowedPaths.disallow(actor, target(d, r).id, checkPool(pool), String(path ?? ""));
      return s().workspace.allowedPaths.list(target(d, r).id);
    }),
    route("GET", `${u}/admin/web-access`, (r) => { d.adminFor(r); return s().web.view(); }),
    route("PUT", `${u}/admin/web-access`, async (r) => {
      d.adminFor(r);
      return s().web.set(await r.json<Api.WebAccessChange>());
    }),
    route("GET", `${u}/admin/web-access/status`, (r) => { d.adminFor(r); return s().web.status(); }),
    route("GET", `${u}/admin/web-access/snippet`, (r): Api.WebAccessSnippet => { d.adminFor(r); return { caddyfile: s().web.snippet() }; }),
    route("GET", `${u}/admin/sleep`, (r) => { d.adminFor(r); return { time: sleepTime(d) }; }),
    route("PUT", `${u}/admin/sleep`, async (r) => {
      d.adminFor(r);
      const { time } = await r.json<Api.SleepTime>();
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(time))) throw new Error("the sleep time looks like 03:30");
      d.keyring.self().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('sleep.time', ?)").run(time);
      return { time };
    }),
    route("GET", `${u}/admin/proposals`, (r): Api.PersonaProposal[] => {
      d.adminFor(r);
      const files = s().persona.files();
      return s().persona.proposals().map((p) => ({ ...p, current: files.get(p.path) ?? "" }));
    }),
    route("POST", `${u}/admin/proposals/:id`, async (r) => {
      const actor = d.adminFor(r);
      const { approve } = await r.json<Api.ProposalDecision>();
      s().persona.decide(actor, Number(r.params.id), approve === true);
      return { ok: true };
    }),
  ];
}

// --- Helpers ---

/**
 * One password attempt under the rate limiter: refused while the keys must
 * wait or another attempt on them is running, and counted as a failure if the
 * password was wrong. The attempt is taken before the slow key derivation, so
 * parallel guesses get no free tries.
 */
async function limited<T>(d: Lyricad, keys: string[], attempt: () => Promise<T>, wrong: string): Promise<T> {
  const tooMany = (ms: number) => {
    const seconds = Math.max(1, Math.ceil(ms / 1000));
    return new HttpError(429, `too many attempts; try again in ${seconds} s`, { "retry-after": String(seconds) });
  };
  const wait = d.limiter.wait(keys);
  if (wait > 0) throw tooMany(wait);
  if (!d.limiter.begin(keys)) throw tooMany(1000);
  try {
    const result = await attempt();
    d.limiter.succeed(keys);
    return result;
  } catch (err) {
    if (!(err instanceof AuthError) && !(err instanceof WrongPassword)) throw err;
    d.limiter.fail(keys);
    throw new HttpError(401, wrong);
  } finally {
    d.limiter.end(keys);
  }
}

function pick<T extends object, K extends keyof T>(o: T, keys: K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) if (o && o[k] !== undefined) out[k] = o[k];
  return out;
}

function checkPool(p: unknown): Pool {
  if (p !== "general" && p !== "private") throw new HttpError(400, "the pool is general or private");
  return p;
}

const poolOf = (r: Request): Pool => checkPool(r.params.pool);
const author = (user: User): Author => `user:${user.id}`;

/** The owner view for one request, closed afterwards. */
function owner<T>(d: Lyricad, user: User, fn: (o: OwnerView) => T): T {
  const o = d.services!.memory.openOwnerView(user.id);
  try {
    return fn(o);
  } finally {
    o.close();
  }
}

function threadOf(o: OwnerView, r: Request): Thread {
  const thread = o[poolOf(r)].getThread(r.params.threadId!);
  if (!thread) throw new HttpError(404, "no such thread");
  return thread;
}

function memoryId(o: OwnerView, r: Request): string {
  const id = r.params.id!;
  if (!o[poolOf(r)].get(id)) throw new HttpError(404, `no such memory: ${id}`);
  return id;
}

function target(d: Lyricad, r: Request): User {
  const user = d.services!.users.get(r.params.targetId!);
  if (!user) throw new HttpError(404, "no such user");
  return user;
}

function withLinks(text: string, links: unknown): string {
  const ids = Array.isArray(links) ? links.map(String).filter((l) => /^(general\/)?[tenp]:\S+$/.test(l)) : [];
  return [text.trim(), ...ids.map((l) => `[${l}]`)].filter(Boolean).join(" ");
}

function display(d: Lyricad, userId: string): Api.Display {
  const db = d.services!.users.openUserDb(userId);
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'display'").get() as { value: string } | undefined;
    return { ...DISPLAY_DEFAULTS, ...(row ? JSON.parse(row.value) : {}) };
  } finally {
    db.close();
  }
}

function me(d: Lyricad, user: User): Api.Me {
  const fresh = d.services!.users.get(user.id)!;
  return { user: card(fresh), previousNames: fresh.profile.previousNames, display: display(d, user.id), savedCredentials: d.keyring.hasSavedKey(user.id) };
}

function endpointInfo(d: Lyricad, userId: string, id: string): Api.EndpointInfo {
  const ep = d.services!.models.endpoint(userId, id);
  if (!ep) throw new HttpError(404, `no endpoint ${id}`);
  return {
    id: ep.id, name: ep.name, kind: ep.kind, baseUrl: ep.baseUrl, hasApiKey: !!ep.apiKey, shared: ep.shared,
    models: d.services!.models.models(userId, ep.id).map(({ endpointId: _e, ...m }) => m),
  };
}

function endpoints(d: Lyricad, userId: string): Api.EndpointInfo[] {
  return d.services!.models.endpoints(userId).map((e) => endpointInfo(d, userId, e.id));
}

function profiles(d: Lyricad, userId: string): Api.Profiles {
  return { cloud: d.services!.models.profile(userId, "cloud"), local: d.services!.models.profile(userId, "local") };
}

function networkDefaults(d: Lyricad, userId: string): Api.NetworkDefaults {
  const s = d.services!.workspace.settings(userId);
  return { general: s.defaultNetwork("general"), private: s.defaultNetwork("private") };
}

function sshTargets(d: Lyricad, userId: string): Api.SshTargetInfo[] {
  return d.services!.workspace.settings(userId).sshTargets().map((t) => ({
    name: t.name, host: t.host, port: t.port, username: t.username, root: t.root, hostKey: t.hostKey, publicKey: publicKeyOf(t.privateKey),
  }));
}

function adminStatus(d: Lyricad): Api.AdminStatus {
  const refused = d.services!.workspace.networkRefused;
  const why = d.keyring.credentials?.unavailable();
  return {
    ...(refused ? { networkRefused: refused } : {}),
    savedPassphrase: d.keyring.hasSavedPassphrase(),
    credentials: why ? { available: false, reason: why } : { available: true },
  };
}

function sleepTime(d: Lyricad): string {
  const row = d.keyring.self().prepare("SELECT value FROM settings WHERE key = 'sleep.time'").get() as { value: string } | undefined;
  return row?.value ?? "03:00";
}

/** A thread with its subagents nested under it. */
function tree(d: Lyricad, user: User, pool: Pool, store: PoolStore, threads: Thread[]): Api.ThreadSummary[] {
  const children = new Map<string, Thread[]>();
  for (const th of threads) if (th.subagent && th.parent) children.set(th.parent, [...(children.get(th.parent) ?? []), th]);
  const build = (th: Thread): Api.ThreadSummary => summary(d, user, pool, store, th, (children.get(th.id) ?? []).map(build));
  return threads.filter((th) => !th.subagent || !threads.some((p) => p.id === th.parent)).map(build);
}

function summary(d: Lyricad, user: User, pool: Pool, store: PoolStore, th: Thread, children: Api.ThreadSummary[]): Api.ThreadSummary {
  return {
    pool, id: th.id, interface: th.interface, subagent: th.subagent, hidden: th.hidden, unlogged: th.unlogged, createdAt: th.createdAt,
    updatedAt: store.lastEntry(th.id)?.createdAt ?? th.createdAt,
    ...(th.title ? { title: th.title } : {}), ...(th.parent ? { parent: th.parent } : {}),
    busy: d.services!.host.busy(user.id, pool, th.id), children,
  };
}

function threadSettings(d: Lyricad, user: User, pool: Pool, threadId: string): Api.ThreadSettings {
  const { models, workspace } = d.services!;
  const ctx = models.callContext(user.id, pool, threadId);
  const tw = workspace.settings(user.id).thread(threadId);
  const isUnlogged = owner(d, user, (o) => o[pool].getThread(threadId)?.unlogged ?? false);
  const taskModel = (task: Api.ThreadTask): Api.TaskModel => {
    const override = ctx.overrides?.[task];
    try {
      const ref = models.resolveModel(task, ctx);
      const ep = models.endpoint(user.id, ref.endpointId);
      return { model: ref, kind: ep?.kind, endpointName: ep?.name, source: override ? "thread" : "profile" };
    } catch (err) {
      if (!(err instanceof NoModel) && !(err instanceof CloudModelForbidden)) throw err;
      return { ...(override ? { model: override } : {}), source: override ? "thread" : "none", problem: (err as Error).message };
    }
  };
  return {
    models: Object.fromEntries(THREAD_TASKS.map((task) => [task, taskModel(task)])) as Api.ThreadSettings["models"],
    localOnly: ctx.localOnly,
    internet: tw.internet, services: tw.services, hosts: tw.hosts,
    network: workspace.network({ userId: user.id, pool, threadId }),
    grants: tw.grants, target: tw.target, mode: tw.mode, unlogged: isUnlogged, parent: tw.parent,
    allowed: models.allowed(ctx).map(({ endpoint }) => endpointInfo(d, user.id, endpoint.id)),
  };
}

/**
 * Applies a settings change, or refuses all of it with the reason: what the
 * router would refuse (a cloud model where only local ones are allowed) and
 * what the workspace would refuse (folders, hosts, a subagent wider than its
 * parent) are checked before anything is written.
 */
function changeSettings(d: Lyricad, user: User, pool: Pool, thread: Thread, change: Api.ThreadSettingsChange): void {
  const { models, workspace } = d.services!;
  const current = models.callContext(user.id, pool, thread.id);
  const ws = workspace.settings(user.id);
  const parent = ws.thread(thread.id).parent;

  // Models: the same rules the router applies at the next turn.
  const localOnly = change.localOnly ?? current.localOnly;
  if (pool === "private" && !localOnly) throw new CloudModelForbidden("a private thread is always local-only");
  if (parent && !localOnly && models.callContext(user.id, pool, parent).localOnly) throw new Error("the parent thread is local-only, so this one is too");
  const overrides = { ...current.overrides };
  for (const [task, ref] of Object.entries(change.models ?? {})) {
    if (!(THREAD_TASKS as readonly string[]).includes(task)) throw new Error(`a thread can't choose a model for ${task}`);
    if (ref) overrides[task as Api.ThreadTask] = { endpointId: String(ref.endpointId), modelId: String(ref.modelId) };
    else delete overrides[task as Api.ThreadTask];
  }
  const next = { ...current, localOnly, overrides };
  for (const ref of Object.values(overrides)) {
    const ep = models.endpoint(user.id, ref.endpointId);
    if (!ep) throw new NoModel(`no endpoint ${ref.endpointId}`);
    if (isRestricted(next) && ep.kind !== "local") throw new CloudModelForbidden(`${ref.endpointId}/${ref.modelId} is a cloud model, and only local models are allowed in a ${pool === "private" ? "private" : "local-only"} thread`);
    if (!models.models(user.id, ep.id).some((m) => m.modelId === ref.modelId)) throw new NoModel(`${ref.endpointId} has no model ${ref.modelId}`);
  }
  if (change.unlogged === false && thread.parent) {
    owner(d, user, (o) => { if (o[pool].getThread(thread.parent!)?.unlogged) throw new Error("this thread's parent isn't logged, so it can't be logged either"); });
  }

  // The workspace checks grants, hosts, mode, target and the parent's limits, and writes only if all pass.
  const wsChange = pick(change, ["grants", "internet", "services", "hosts", "mode", "target"]);
  if (Object.keys(wsChange).length) ws.setThread(thread.id, pool, wsChange);

  if (change.localOnly !== undefined && pool === "general") models.setLocalOnly(user.id, pool, thread.id, change.localOnly);
  for (const [task, ref] of Object.entries(change.models ?? {})) models.setThreadModel(user.id, pool, thread.id, task as Api.ThreadTask, ref ?? undefined);
  if (change.unlogged !== undefined) owner(d, user, (o) => o[pool].setUnlogged(thread.id, !!change.unlogged));
}

function memoryDetail(d: Lyricad, o: OwnerView, pool: Pool, id: string): Api.MemoryDetail {
  const store: PoolStore = o[pool];
  const item = store.get(id, { raw: true });
  if (!item) throw new HttpError(404, `no such memory: ${id}`);
  const usedIn = [...store.usedIn(id), ...(pool === "general" ? o.private.usedIn(`general/${id}`).map((x) => `private/${x}`) : [])];
  const users: Api.UserMap = Object.fromEntries(d.services!.users.all().map((u) => [u.id, { displayName: u.profile.displayName, pronouns: u.profile.pronouns }]));
  return {
    item: { pool, ...item, kind: item.kind },
    cameFrom: store.cameFrom(id),
    usedIn,
    revisions: store.revisions(id).map((r) => ({ id: r.id, body: r.body, author: r.author, createdAt: r.createdAt })),
    users,
  };
}
