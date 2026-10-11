import {
  AuthError, WrongPassword, WORKDIR, CAPABILITIES, FilesRefused, checkTask, isRestricted, profileFor, voiceContext, refId, THINKING_LEVELS, publicKeyOf, authorizedKeysLine, proxmoxAddress, CloudModelForbidden, FROM_PARENT, NoModel, WATCHING, PRONOUN_PRESETS, projectSlug,
  type Author, type Endpoint, type ModelRef, type Offering, type Hit, type Item, type MachineConfig, type OwnerView, type Pool, type PoolStore, type SleepItem, type SleepRunRecord, type Thread, type ThreadPref, type User,
} from "@lyrica/core";
import type * as Api from "./api.ts";
import { THREAD_TASKS } from "./api.ts";
import { Sessions } from "./auth.ts";
import { HttpError, route, type Request, type Route } from "./http.ts";
import { DEFAULT_BUDGETS, OPENING, pinnedBlock, pinnedOf, reserveFor } from "@lyrica/extension";
import type { ProjectThreadInfo } from "./children.ts";
import { Busy } from "./hosted.ts";
import { card, type Lyricad, type Services } from "./lyricad.ts";
import { toMessages } from "./messages.ts";
import { messageText, readAloud, readClip, speechState, storedSource, transcribeClip, titlesIn, type SpeechSource } from "./speech.ts";
import { applyRemoval, entriesFrom, removalPlan, uploadsIn, type RemovalContext } from "./removal.ts";

const DISPLAY_DEFAULTS: Api.Display = { theme: "device", showGeneral: true, showPrivate: true, showHidden: false, sort: "date", projects: "all" };
const THREAD_SORTS: Api.ThreadSort[] = ["date", "activity", "started", "title", "groups"];
const DISPLAY_DEFAULTS_ALL: Api.Display = { ...DISPLAY_DEFAULTS, showPrivate: true, showGeneral: true, showHidden: true };
const MESSAGE_PAGE = 50;

/** Every API route. Locked, only /api/state and /api/unlock answer (lyricad.ts enforces it). */
export function apiRoutes(d: Lyricad): Route[] {
  const s = (): Services => d.services!;
  /** The Files panel's operations for the request's thread, each inside the thread's sandbox. */
  const files = (r: Request) => {
    const user = d.userFor(r);
    const thread = owner(d, user, (o) => threadOf(o, r));
    return s().workspace.files({ userId: user.id, pool: poolOf(r), threadId: thread.id });
  };
  const refused = async <T>(fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); } catch (err) { throw err instanceof FilesRefused ? new HttpError(403, err.message) : err; }
  };
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
      // Every login gets a fresh session, so a copied cookie never comes to hold someone new.
      // One browser, one person: only the users linked to this one come along.
      const linked = new Set(s().users.linked(user.id));
      const { id, left } = d.sessions.login(r.cookie, user.id, (u) => linked.has(u));
      await d.loggedOut(left);
      r.res.setHeader("set-cookie", Sessions.setCookie(id));
      return { user: card(user), replaced: left.length > 0 };
    }),
    route("POST", "/api/logout", async (r) => {
      const { userId } = await r.json<Api.LogoutRequest>();
      const held = d.sessions.users(r.cookie);
      if (!held) throw new HttpError(401, "not logged in");
      const leaving = userId ? (held.has(userId) ? [userId] : []) : [...held];
      if (userId) d.sessions.removeUser(r.cookie!, userId);
      else d.sessions.end(r.cookie!);
      if (!d.sessions.users(r.cookie)) r.res.setHeader("set-cookie", Sessions.clearCookie());
      await d.loggedOut(leaving);
      // Whose key stays in memory because another browser still holds them.
      const stillUnlocked = leaving.filter((id) => d.keyring.hasUserKey(id) && d.sessions.holders(id) > 0);
      return { ok: true, stillUnlocked } satisfies Api.LogoutResponse;
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
      const next = { ...display(d, user.id), ...pick(change, ["theme", "showGeneral", "showPrivate", "showHidden", "sort", "projects"]) };
      if (!["device", "light", "dark"].includes(next.theme)) throw new Error("the theme is device, light or dark");
      if (!THREAD_SORTS.includes(next.sort)) throw new Error(`the sort is one of ${THREAD_SORTS.join(", ")}`);
      if (!["all", "only", "none"].includes(next.projects)) throw new Error("projects is all, only or none");
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
    route("PUT", `${u}/me/stay-unlocked`, async (r) => {
      const user = d.userFor(r);
      const { stayUnlocked } = await r.json<Api.StayUnlockedChange>();
      s().users.setStayUnlocked(user.id, stayUnlocked !== false);
      return me(d, user);
    }),
    route("GET", `${u}/links`, (r) => links(d, d.userFor(r))),
    route("POST", `${u}/links`, async (r) => {
      const user = d.userFor(r);
      const { password, login, otherPassword } = await r.json<Api.LinkRequest>();
      const keys = [`login:${user.login.toLowerCase()}`, `login:${String(login ?? "").trim().toLowerCase()}`, `ip:${r.ip}`];
      // Argon2 runs for an unknown login too, so this can't tell which names exist.
      await limited(d, keys, () => s().users.link(user, String(password ?? ""), String(login ?? ""), String(otherPassword ?? "")), "a login or password is wrong");
      return links(d, user);
    }),
    route("DELETE", `${u}/links/:otherId`, async (r) => {
      const user = d.userFor(r);
      const other = s().users.get(r.params.otherId!);
      if (!other) throw new HttpError(404, "no such user");
      s().users.unlink(user, other);
      d.sessions.separate(user.id, other.id);
      await d.loggedOut([other.id]);
      return links(d, user);
    }),
    route("GET", `${u}/proposals`, (r): Api.ProposalDraft[] => s().proposals.drafts(d.userFor(r).id)),
    route("PATCH", `${u}/proposals/:id`, async (r) => {
      const user = d.userFor(r);
      const change = await r.json<Api.ProposalDraftChange>();
      return s().proposals.edit(user.id, Number(r.params.id), {
        ...(change.text !== undefined ? { text: String(change.text) } : {}), ...(change.reason !== undefined ? { reason: String(change.reason) } : {}),
      });
    }),
    route("DELETE", `${u}/proposals/:id`, (r) => { s().proposals.drop(d.userFor(r).id, Number(r.params.id)); return { ok: true }; }),
    route("POST", `${u}/proposals/:id/send`, (r) => { s().proposals.send(d.userFor(r).id, Number(r.params.id)); return { ok: true }; }),
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
      const o = s().models.addModel(user, r.params.endpointId!, { ...capabilities(m), modelId: String(m.modelId ?? "") });
      return offeringInfo(d, user.id, o.id);
    }),
    route("GET", `${u}/endpoints/:endpointId/probe`, (r) => s().models.probe(d.userFor(r).id, r.params.endpointId!)),
    route("PATCH", `${u}/endpoints/:endpointId`, async (r) => {
      const user = d.userFor(r);
      const c = await r.json<Api.EndpointChange>();
      s().models.editEndpoint(user, r.params.endpointId!, {
        ...(c.name !== undefined ? { name: String(c.name) } : {}), ...(c.baseUrl !== undefined ? { baseUrl: String(c.baseUrl) } : {}),
        ...(c.apiKey !== undefined ? { apiKey: c.apiKey === null ? null : String(c.apiKey) } : {}),
      });
      return endpointInfo(d, user.id, r.params.endpointId!);
    }),
    route("POST", `${u}/endpoints/:endpointId/reset-ids`, (r) => {
      const user = d.userFor(r);
      return endpointInfo(d, user.id, s().models.resetIds(user, r.params.endpointId!));
    }),
    route("POST", `${u}/endpoints/:endpointId/merge`, async (r) => {
      const user = d.userFor(r);
      const { into } = await r.json<Api.MergeInput>();
      s().models.merge(user, r.params.endpointId!, String(into ?? ""));
      return endpointInfo(d, user.id, String(into));
    }),
    route("POST", `${u}/hosts`, async (r) => {
      const user = d.userFor(r);
      const h = await r.json<Api.HostInput>();
      const ep = await s().models.pairHost(user, { name: String(h.name ?? ""), addresses: strings(h.addresses), code: String(h.code ?? "") }, { shared: !!h.shared });
      await s().models.discover(user, ep.id).catch(() => {}); // a host that's paused now is read later
      return endpointInfo(d, user.id, ep.id);
    }),
    route("POST", `${u}/hosts/:endpointId/pair`, async (r) => {
      const user = d.userFor(r);
      const { code } = await r.json<Api.HostRepair>();
      const ep = s().models.endpoint(user.id, r.params.endpointId!);
      if (!ep || ep.api !== "host") throw new HttpError(404, "no such model host");
      await s().models.pairHost(user, { name: ep.name, addresses: ep.addresses ?? [], code: String(code ?? "") }, { endpointId: ep.id });
      return endpointInfo(d, user.id, ep.id);
    }),
    route("PUT", `${u}/hosts/:endpointId/addresses`, async (r) => {
      const user = d.userFor(r);
      const { addresses } = await r.json<Api.HostAddresses>();
      s().models.setHostAddresses(user, r.params.endpointId!, strings(addresses));
      return endpointInfo(d, user.id, r.params.endpointId!);
    }),
    route("GET", `${u}/hosts/:endpointId/status`, async (r) => (await s().models.hostStatus(d.userFor(r).id, r.params.endpointId!)) as Api.HostStatus),
    // --- The model libraries, downloads and host management ---
    route("GET", `${u}/library/text`, (r): Api.TextLibrary => {
      const q = r.query;
      const kind = q.get("kind");
      const capability = q.get("capability");
      if (kind && kind !== "cloud" && kind !== "local") throw new HttpError(400, "kind is cloud or local");
      if (capability && !["tools", "vision", "embedding", "image"].includes(capability)) throw new HttpError(400, "capability is tools, vision, embedding or image");
      return s().models.textLibrary(d.userFor(r).id, {
        ...(q.get("search") ? { search: q.get("search")! } : {}), ...(kind ? { kind: kind as "cloud" | "local" } : {}),
        ...(q.get("endpoint") ? { endpointId: q.get("endpoint")! } : {}), ...(capability ? { capability: capability as "tools" } : {}),
        groupsOnly: q.get("groups") === "1", offset: Number(q.get("offset") ?? 0) || 0, limit: Number(q.get("limit") ?? 50) || 50,
      });
    }),
    route("PUT", `${u}/offerings/:offeringId/star`, async (r) => {
      const { starred } = await r.json<{ starred: boolean }>();
      s().models.star(d.userFor(r).id, r.params.offeringId!, !!starred);
      return { ok: true };
    }),
    route("PUT", `${u}/offerings/:offeringId/separate`, async (r) => {
      const { separate } = await r.json<{ separate: boolean }>();
      s().models.notThisModel(d.userFor(r), r.params.offeringId!, !!separate);
      return { ok: true };
    }),
    route("POST", `${u}/offerings/:offeringId/delete-copy`, async (r): Promise<Api.DeleteCopy> => {
      const { confirm } = await r.json<{ confirm?: boolean }>();
      return s().models.deleteCopy(d.userFor(r), r.params.offeringId!, { confirm: !!confirm });
    }),
    route("GET", `${u}/hub-tokens`, (r): Api.HubTokenInfo[] => s().models.hubTokens(d.userFor(r).id)),
    route("PUT", `${u}/hub-tokens/:hub`, async (r): Promise<Api.HubTokenInfo[]> => {
      const user = d.userFor(r);
      const t = await r.json<Api.HubTokenInput>();
      s().models.setHubToken(user, r.params.hub as Api.Hub, String(t.token ?? ""), { shared: !!t.shared });
      return s().models.hubTokens(user.id);
    }),
    route("DELETE", `${u}/hub-tokens/:hub`, (r): Api.HubTokenInfo[] => {
      const user = d.userFor(r);
      s().models.removeHubToken(user, r.params.hub as Api.Hub, { shared: r.query.get("shared") === "1" });
      return s().models.hubTokens(user.id);
    }),
    route("GET", `${u}/hosts/:endpointId/hub/files`, async (r) => {
      const source = r.query.get("source");
      if (source !== "huggingface" && source !== "modelscope") throw new HttpError(400, "source is huggingface or modelscope");
      return s().models.hubFiles(d.userFor(r), r.params.endpointId!, { source, repo: String(r.query.get("repo") ?? ""), ...(r.query.get("revision") ? { revision: r.query.get("revision")! } : {}) });
    }),
    route("POST", `${u}/hosts/:endpointId/downloads`, async (r) => s().models.startDownload(d.userFor(r), r.params.endpointId!, await r.json<Api.DownloadInput>())),
    route("GET", `${u}/hosts/:endpointId/downloads`, async (r) => s().models.downloads(d.userFor(r), r.params.endpointId!)),
    route("DELETE", `${u}/hosts/:endpointId/downloads/:downloadId`, async (r) => s().models.cancelDownload(d.userFor(r), r.params.endpointId!, r.params.downloadId!)),
    route("GET", `${u}/hosts/:endpointId/images`, async (r) => s().models.imageLibrary(d.userFor(r).id, r.params.endpointId!)),
    route("POST", `${u}/hosts/:endpointId/recipes/:recipeId`, async (r) => {
      const a = await r.json<Api.RecipeAction>();
      if (!["confirm", "ignore", "download-parts", "delete", "change", "copy"].includes(a.do)) throw new HttpError(400, "a recipe can be confirmed, ignored, changed, copied, deleted, or have its parts downloaded");
      return s().models.recipe(d.userFor(r), r.params.endpointId!, r.params.recipeId!, a as never);
    }),
    route("POST", `${u}/hosts/:endpointId/manage`, async (r) => {
      const m = await r.json<Api.HostManage>();
      if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(m.method)) throw new HttpError(400, "method is GET, POST, PUT, PATCH or DELETE");
      return s().models.manageHost(d.userFor(r), r.params.endpointId!, m.method, String(m.path ?? ""), m.body);
    }),
    route("GET", `${u}/offerings/:offeringId/serving`, async (r): Promise<Api.ServingSettings> => s().models.servingSettings(d.userFor(r).id, r.params.offeringId!)),
    route("PUT", `${u}/offerings/:offeringId/serving`, async (r) => {
      const b = await r.json<{ settings?: unknown } | null>();
      if (!b || typeof b.settings !== "object" || !b.settings || Array.isArray(b.settings)) throw new HttpError(400, "send { settings }");
      return s().models.setServingSettings(d.userFor(r), r.params.offeringId!, b.settings as Record<string, unknown>);
    }),
    route("POST", `${u}/offerings/:offeringId/reload`, async (r) => s().models.reloadModel(d.userFor(r), r.params.offeringId!)),
    route("GET", `${u}/hosts/:endpointId/dashboard`, (r) => ({ url: s().models.hostDashboard(d.userFor(r).id, r.params.endpointId!) })),
    route("GET", `${u}/models/page`, async (r): Promise<Api.ModelsPage> => {
      const user = d.userFor(r);
      const m = s().models;
      const eps = m.endpoints(user.id);
      // One look per endpoint, within 3 s, so a host that's off doesn't hold the page.
      const looks = await Promise.all(eps.map(async (e) => ({ e, look: await m.pageStatus(user.id, e.id).catch((err: Error) => ({ state: "down" as const, error: err.message, status: undefined, warning: undefined })) })));
      const live = looks.map(({ e, look }) => ({ ...endpointInfo(d, user.id, e.id), state: look.state, ...(look.warning ? { warning: look.warning } : {}) }));
      const hosts = looks.filter(({ e }) => e.api === "host").map(({ e, look }) => look.status
        ? { endpointId: e.id, status: look.status as Api.HostStatus }
        : { endpointId: e.id, error: look.error ?? `${e.name} is down` });
      return { endpoints: live, hosts, profiles: profiles(d, user.id), calls: m.recentCalls(user.id, { limit: 20 }), notice: m.notice(user.id), cleanup: m.cleanup(user.id).length };
    }),
    route("POST", `${u}/hosts/:endpointId/:action`, async (r) => {
      const action = r.params.action;
      if (action !== "pause" && action !== "resume" && action !== "restart") throw new HttpError(404, "a host can be paused, resumed or restarted");
      return (await s().models.hostControl(d.userFor(r), r.params.endpointId!, action)) as Api.HostStatus;
    }),
    route("PATCH", `${u}/offerings/:offeringId`, async (r) => {
      const user = d.userFor(r);
      const c = await r.json<Api.CapabilitiesChange>();
      s().models.setCapabilities(user, r.params.offeringId!, capabilities(c, true));
      return offeringInfo(d, user.id, r.params.offeringId!);
    }),
    route("GET", `${u}/offerings/:offeringId/settings`, (r): Api.OfferingSettings => s().models.offeringSettings(d.userFor(r).id, r.params.offeringId!)),
    route("PUT", `${u}/offerings/:offeringId/settings`, async (r): Promise<Api.OfferingSettings> => {
      const user = d.userFor(r);
      const c = await r.json<Api.OfferingSettingsChange | null>();
      if (!c || typeof c !== "object" || Array.isArray(c)) throw new HttpError(400, "send { scope, values }");
      if (c.scope !== undefined && c.scope !== "shared" && c.scope !== "mine") throw new HttpError(400, "scope is shared or mine");
      if (!c.values || typeof c.values !== "object" || Array.isArray(c.values)) throw new HttpError(400, "values is an object of settings");
      s().models.setOfferingSettings(user, r.params.offeringId!, c.values, c.scope ?? "mine");
      return s().models.offeringSettings(user.id, r.params.offeringId!);
    }),
    route("DELETE", `${u}/offerings/:offeringId`, (r) => {
      s().models.removeOffering(d.userFor(r), r.params.offeringId!);
      return { ok: true };
    }),
    route("POST", `${u}/offerings/:offeringId/replace`, async (r) => {
      const { with: to } = await r.json<Api.ReplaceInput>();
      s().models.replace(d.userFor(r), r.params.offeringId!, String(to ?? ""));
      return { ok: true };
    }),
    route("GET", `${u}/offerings/:offeringId/same`, (r) => {
      const user = d.userFor(r);
      return s().models.sameModel(user.id, r.params.offeringId!).map((ref) => offeringInfo(d, user.id, ref.offeringId));
    }),
    route("GET", `${u}/models/cleanup`, (r): Api.CleanupItem[] => {
      const user = d.userFor(r);
      return s().models.cleanup(user.id).map((c) => ({
        ...(c.endpoint ? { endpoint: { id: c.endpoint.id, name: c.endpoint.name, shared: c.endpoint.shared, ...(c.endpoint.downSince ? { downSince: c.endpoint.downSince } : {}) } } : {}),
        ...(c.offering ? { offering: offeringInfo(d, user.id, c.offering.id) } : {}),
        ...(c.group ? { group: { id: c.group.id, name: c.group.name, shared: c.group.shared } } : {}),
        label: c.label, usedIn: c.usedIn, otherUsers: c.otherUsers, ...(c.suggestion ? { suggestion: c.suggestion } : {}),
      }));
    }),
    route("GET", `${u}/models/notice`, (r): Api.ModelsNotice => ({ lines: s().models.notice(d.userFor(r).id) })),
    route("DELETE", `${u}/models/notice`, (r) => { s().models.dismissNotice(d.userFor(r).id); return { ok: true }; }),
    route("GET", `${u}/models/calls`, (r): Api.CallInfo[] => {
      const user = d.userFor(r);
      const project = r.query.get("project");
      if (!project) return s().models.recentCalls(user.id);
      // A project's calls: its chat's and its threads', in the pool it is in.
      const pool = checkPool(r.query.get("pool") ?? "general");
      const ids = owner(d, user, (o) => o[pool].projectThreads(project));
      return s().models.recentCalls(user.id, { threadIds: ids });
    }),
    route("GET", `${u}/profiles`, (r) => profiles(d, d.userFor(r).id)),
    route("PATCH", `${u}/profiles`, async (r) => {
      const user = d.userFor(r);
      const c = await r.json<Api.ProfilesChange>();
      if (c.default !== undefined) s().models.setDefaultProfile(user.id, c.default);
      if (c.thinking !== undefined) s().models.setDefaultThinking(user.id, c.thinking);
      if (c.fallback !== undefined) s().models.setDefaultFallback(user.id, c.fallback);
      if (c.sleepFallback !== undefined) s().sleep.setFallback(user.id, c.sleepFallback);
      if (c.readAloudLive !== undefined) s().models.setDefaultReadAloudLive(user.id, c.readAloudLive);
      return profiles(d, user.id);
    }),
    route("PUT", `${u}/profiles/:profile/:task`, async (r) => {
      const user = d.userFor(r);
      const name = r.params.profile;
      if (name !== "cloud" && name !== "local" && name !== "custom") throw new HttpError(404, "the profiles are local, cloud and custom");
      const c = await r.json<Api.ProfileEntryChange>();
      const entry = "same" in c ? { same: checkTask(String(c.same)) } : "models" in c ? (c.models ? toRefs(c.models) : undefined) : c.model ? [toRef(c.model)] : undefined;
      s().models.setProfile(user.id, name, checkTask(r.params.task!), entry);
      return profiles(d, user.id);
    }),

    // --- Model groups ---
    route("GET", `${u}/groups`, (r): Api.GroupInfo[] => s().models.groups(d.userFor(r).id)),
    route("GET", `${u}/groups/suggestions`, (r): Api.GroupSuggestion[] => s().models.groupSuggestions(d.userFor(r).id)),
    route("POST", `${u}/groups`, async (r): Promise<Api.GroupInfo> => {
      const g = await r.json<Api.GroupInput>();
      return s().models.addGroup(d.userFor(r), { name: String(g.name ?? ""), members: ids(g.members) }, { shared: !!g.shared });
    }),
    route("GET", `${u}/groups/:groupId`, (r): Api.GroupDetail => {
      const user = d.userFor(r);
      const detail = s().models.groupDetail(user.id, r.params.groupId!);
      return { ...detail, members: detail.members.map((m) => ({ ...offeringInfo(d, user.id, m.id), kind: m.kind, stale: m.stale })) };
    }),
    route("PATCH", `${u}/groups/:groupId`, async (r): Promise<Api.GroupInfo> => {
      const c = await r.json<Api.GroupChange>();
      return s().models.editGroup(d.userFor(r), r.params.groupId!, {
        ...(c.name !== undefined ? { name: String(c.name) } : {}), ...(c.members !== undefined ? { members: ids(c.members) } : {}),
      });
    }),
    route("DELETE", `${u}/groups/:groupId`, (r) => { s().models.removeGroup(d.userFor(r), r.params.groupId!); return { ok: true }; }),

    // --- Subagent roles and saved workflows, in the user's user.db ---
    route("GET", `${u}/roles`, (r) => roles(d, d.userFor(r).id)),
    route("PUT", `${u}/roles/:name`, async (r) => {
      const user = d.userFor(r);
      const role = await r.json<Api.Role>();
      s().delegation.store.setRole(user.id, {
        name: r.params.name!, description: String(role.description ?? ""), prompt: String(role.prompt ?? ""), tier: role.tier,
        tools: toolList(role.tools), readOnly: !!role.readOnly, thinking: role.thinking ?? "off",
      });
      return roles(d, user.id);
    }),
    route("DELETE", `${u}/roles/:name`, (r) => {
      const user = d.userFor(r);
      s().delegation.store.removeRole(user.id, r.params.name!);
      return roles(d, user.id);
    }),
    route("GET", `${u}/workflows`, (r) => s().delegation.workflows(d.userFor(r).id)),
    route("PUT", `${u}/workflows/:name`, async (r) => {
      const user = d.userFor(r);
      const w = await r.json<Api.Workflow>();
      if (!w.spec || typeof w.spec !== "object") throw new Error("a workflow needs a spec: a chain, loop or council");
      // Models are saved by offering ID, so a rename breaks nothing, and indexed so Clean up and pruning see them.
      s().delegation.store.setWorkflow(user.id, { name: r.params.name!, description: String(w.description ?? ""), spec: s().models.workflowSpec(user.id, w.spec) });
      s().models.reindex(user.id);
      return s().delegation.workflows(user.id);
    }),
    route("DELETE", `${u}/workflows/:name`, (r) => {
      const user = d.userFor(r);
      s().delegation.store.removeWorkflow(user.id, r.params.name!);
      return s().delegation.workflows(user.id);
    }),

    // --- Workspace defaults, allowed paths, SSH ---
    route("GET", `${u}/network`, (r) => networkDefaults(d, d.userFor(r).id)),
    route("PATCH", `${u}/network/:pool`, async (r) => {
      const user = d.userFor(r);
      const change = pick(await r.json<Api.NetworkChange>(), ["internet", "services", "hosts"]);
      s().workspace.settings(user.id).setDefaultNetwork(poolOf(r), change);
      return networkDefaults(d, user.id);
    }),
    route("GET", `${u}/mode`, (r): Api.ModeDefault => ({ mode: s().workspace.settings(d.userFor(r).id).defaultMode() })),
    route("PUT", `${u}/mode`, async (r): Promise<Api.ModeDefault> => {
      const ws = s().workspace.settings(d.userFor(r).id);
      ws.setDefaultMode((await r.json<Api.ModeDefault>())?.mode);
      return { mode: ws.defaultMode() };
    }),
    route("GET", `${u}/paths`, (r) => s().workspace.allowedPaths.list(d.userFor(r).id)),
    route("GET", `${u}/machines`, (r) => s().workspace.settings(d.userFor(r).id).machines().map(machineInfo)),
    route("POST", `${u}/machines/probe`, async (r): Promise<Api.MachineProbe> => {
      const user = d.userFor(r);
      const input = await r.json<Api.MachineProbeInput>();
      return s().workspace.probeMachine(user.id, user.login, { kind: checkKind(input.kind), name: String(input.name ?? ""), address: String(input.address ?? ""), draft: input.draft });
    }),
    route("POST", `${u}/machines`, async (r) => {
      const user = d.userFor(r);
      const input = await r.json<Api.MachineInput>();
      return machineInfo(await s().workspace.addMachine(user.id, {
        kind: checkKind(input.kind), name: String(input.name ?? ""), address: String(input.address ?? ""), root: input.root || null, pool: checkPool(input.pool),
        limit: input.limit, draft: String(input.draft ?? ""), token: input.token === undefined ? undefined : String(input.token),
        hostKey: String(input.hostKey ?? ""), offNetworkConfirmed: input.offNetworkConfirmed === true,
      }));
    }),
    route("PATCH", `${u}/machines/:name`, async (r) => {
      const change = pick(await r.json<Api.MachineChange>(), ["address", "root", "pool", "limit"]);
      if (change.pool !== undefined) checkPool(change.pool);
      return machineInfo(await s().workspace.updateMachine(d.userFor(r).id, r.params.name!, change));
    }),
    route("POST", `${u}/machines/:name/key`, async (r) => {
      const { hostKey, token } = await r.json<Api.MachineKey>();
      return machineInfo(await s().workspace.setHostKey(d.userFor(r).id, r.params.name!, String(hostKey ?? ""), token === undefined ? undefined : String(token)));
    }),
    route("POST", `${u}/machines/:name/confirm-off-network`, (r) => machineInfo(s().workspace.confirmOffNetwork(d.userFor(r).id, r.params.name!))),
    route("DELETE", `${u}/machines/:name`, (r) => {
      s().workspace.removeMachine(d.userFor(r).id, r.params.name!);
      return { ok: true };
    }),

    // --- The user's own groups of threads ---
    route("GET", `${u}/thread-groups`, (r): Api.ThreadGroup[] => s().prefs.groups(d.userFor(r).id)),
    route("POST", `${u}/thread-groups`, async (r): Promise<Api.ThreadGroup> => s().prefs.addGroup(d.userFor(r).id, String((await r.json<Api.NewThreadGroup>()).name ?? ""))),
    route("PATCH", `${u}/thread-groups/:groupId`, async (r): Promise<Api.ThreadGroup> => s().prefs.renameGroup(d.userFor(r).id, r.params.groupId!, String((await r.json<Api.NewThreadGroup>()).name ?? ""))),
    route("DELETE", `${u}/thread-groups/:groupId`, (r) => { s().prefs.removeGroup(d.userFor(r).id, r.params.groupId!); return { ok: true }; }),

    // --- Threads ---
    route("GET", `${u}/threads`, (r) => {
      const user = d.userFor(r);
      const all = r.query.get("all") === "1";
      const iface = r.query.get("interface") ?? "web";
      const show = display(d, user.id);
      const prefs = s().prefs.all(user.id);
      const projects = all ? "all" : show.projects;
      return owner(d, user, (o) => (["general", "private"] as const)
        .filter((p) => all || (p === "general" ? show.showGeneral : show.showPrivate))
        .flatMap((p) => tree(d, user, p, o[p], o[p].listThreads({ includeHidden: all || show.showHidden }).filter((x) => x.interface === iface), prefs))
        .filter((x) => projects === "all" || (projects === "only") === !!x.project)
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt)));
    }),
    route("POST", `${u}/threads`, async (r) => {
      const user = d.userFor(r);
      const input = await r.json<Api.NewThread>();
      const pool = checkPool(input.pool);
      return owner(d, user, (o) => {
        const thread = o[pool].createThread({
          interface: "web", title: input.title?.trim() || undefined,
          ...(input.project ? { project: true, ...(typeof input.goal === "string" && input.goal.trim() ? { goal: input.goal } : {}) } : {}),
        });
        s().workspace.settings(user.id).startThread(thread.id, pool);
        // A new project starts pinned.
        if (thread.project) s().projects.pin(user.id, pool, thread.id, true);
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
      const pool = poolOf(r);
      const before = owner(d, user, (o) => {
        const store = o[pool];
        const thread = threadOf(o, r);
        if (change.project !== undefined && change.project !== true) throw new HttpError(400, "a project can't be made a thread again");
        if (change.project && !thread.project) {
          try { store.setProject(thread.id); } catch (err) { throw new HttpError(409, (err as Error).message); }
          s().projects.pin(user.id, pool, thread.id, true);
        }
        const project = !!store.getThread(thread.id)!.project;
        const settings = change.paused !== undefined || change.threadsModel !== undefined || change.threadsThinking !== undefined || change.threadsFallback !== undefined || change.watchThreads !== undefined;
        if ((change.goal !== undefined || change.instructions !== undefined || settings) && !project) {
          throw new HttpError(400, "only a project has a goal, instructions and project settings");
        }
        if (change.title !== undefined) store.setTitle(thread.id, String(change.title));
        if (change.hidden !== undefined) store.setHidden(thread.id, !!change.hidden);
        // The user's own view of the thread, in user.db.
        if (change.group !== undefined) s().prefs.setGroup(user.id, pool, thread.id, change.group === null ? null : String(change.group));
        if (change.unread !== undefined) s().prefs.setUnread(user.id, pool, thread.id, !!change.unread);
        if (change.goal !== undefined) store.setGoal(thread.id, String(change.goal));
        if (change.instructions !== undefined) {
          try { store.setProjectInstructions(thread.id, String(change.instructions), `user:${user.id}`); } catch (err) { throw new HttpError(400, (err as Error).message); }
        }
        if (settings) {
          s().projects.set(user.id, pool, thread.id, {
            ...(change.paused !== undefined ? { paused: !!change.paused } : {}),
            ...(change.threadsModel !== undefined ? { model: change.threadsModel } : {}),
            ...(change.threadsThinking !== undefined ? { thinking: change.threadsThinking } : {}),
            ...(change.threadsFallback !== undefined ? { fallback: change.threadsFallback } : {}),
            ...(change.watchThreads !== undefined ? { watch: !!change.watchThreads } : {}),
          });
        }
        return { thread: thread.id, project, made: !!change.project && !thread.project };
      });
      // Paused or hidden, a project's working threads stop and nothing new starts.
      if (before.project && (change.paused === true || change.hidden === true)) await s().children.stopProject(user.id, pool, before.thread);
      // Resumed or shown again: its queued threads may start.
      if (before.project && (change.paused === false || change.hidden === false)) s().children.resume(user.id);
      // A thread made a project opens its next turn with the project's tools and guidance.
      if (before.made) s().host.reload(user.id, pool, before.thread);
      return owner(d, user, (o) => summary(d, user, pool, o[pool], o[pool].getThread(before.thread)!, []));
    }),
    route("DELETE", t, async (r) => {
      const user = d.userFor(r);
      const pool = poolOf(r);
      const threadId = owner(d, user, (o) => threadOf(o, r).id);
      const { children } = await r.json<Api.ForgetThread>();
      const all = children === true || r.query.get("children") === "1";
      // Its subagents' threads go with it, deepest first, and with `children` its child threads; each one's runs are stopped and their records dropped first.
      const { doomed, kept } = owner(d, user, (o) => {
        const out = { doomed: [] as string[], kept: [] as string[] };
        const walk = (id: string) => {
          for (const c of o[pool].listThreads({ includeHidden: true, parent: id })) walk(c.id);
          for (const c of o[pool].listThreads({ includeHidden: true, parent: id, children: true })) if (all) walk(c.id); else out.kept.push(c.id);
          out.doomed.push(id);
        };
        walk(threadId);
        return out;
      });
      // A project's page and the notes that came only from it go before its threads do, while they still say where the notes came from.
      if (all) owner(d, user, (o) => { if (o[pool].getThread(threadId)?.project) o[pool].forgetProjectMemory(threadId, author(user)); });
      for (const id of doomed) {
        await s().delegation.forget(user.id, pool, id);
        await s().host.forget(user.id, pool, id);
        owner(d, user, (o) => { if (o[pool].getThread(id)) o[pool].forgetThread(id, author(user), { children: all }); });
        s().models.forgetThread(user.id, pool, id);
      }
      s().children.forget(user.id, pool, doomed);
      s().prefs.forget(user.id, pool, doomed);
      s().projects.forget(user.id, pool, doomed);
      // A kept child is a thread of its own now: its next turn opens with its own tools and workspace.
      for (const id of kept) { s().workspace.settings(user.id).detach(id); s().host.reload(user.id, pool, id); }
      return { ok: true };
    }),
    route("GET", `${t}/subagents`, (r): Api.Subagents => {
      const user = d.userFor(r);
      const thread = owner(d, user, (o) => threadOf(o, r));
      const ref = { user, pool: poolOf(r), threadId: thread.id };
      return {
        runs: s().delegation.store.runs(user.id, ref.pool, { parent: thread.id }).map(({ pool: _p, parent: _t, pick: _k, narrowing: _n, ...run }) => run),
        usage: s().delegation.usage(ref),
      };
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
        // Opening a child thread sees its updates, and opening any thread clears its unread mark.
        if (thread.child && !before) s().children.seen(user.id, poolOf(r), thread.id);
        if (!before && s().prefs.get(user.id, poolOf(r), thread.id).unread) s().prefs.setUnread(user.id, poolOf(r), thread.id, false);
        const page = o[poolOf(r)].entryPage(thread.id, { before: before ? Number(before) : undefined, limit });
        const names = thread.subagent ? { userName: (id: string) => s().users.get(id)?.profile.displayName ?? "a user" } : undefined;
        return { messages: toMessages(thread.id, poolOf(r), page.entries,
          (run) => s().delegation.store.runs(user.id, poolOf(r), { run }).map((x) => x.thread), names, thread.child && thread.parent ? { parent: thread.parent } : {}), hasMore: page.hasMore };
      });
    }),
    route("POST", `${t}/messages`, async (r) => {
      const user = d.userFor(r);
      const { text, confirm } = await r.json<Api.SendRequest>();
      const thread = owner(d, user, (o) => threadOf(o, r));
      if (thread.subagent) return toSubagent(d, user, poolOf(r), thread, String(text ?? ""));
      if (String(text ?? "").trim() === "/sleep") return { queued: false, sleep: await startSleep(d, user, poolOf(r), confirm === true) };
      const project = owner(d, user, (o) => o[poolOf(r)].projectOf(thread.id));
      if (project && project !== thread.id && s().children.stopped(user.id, poolOf(r), project)) throw new HttpError(409, "this project is paused or hidden; resume it to write in its threads");
      const sent = await s().host.get(user.id, poolOf(r), thread.id).send(unmarked(String(text ?? "")));
      // The user wrote: the thread no longer waits on them, and a resolved one reopens.
      if (thread.child) s().children.userWrote(user.id, poolOf(r), thread.id);
      return sent;
    }),
    route("POST", `${t}/messages/:n/branch`, async (r) => {
      const user = d.userFor(r);
      const pool = poolOf(r);
      const { title } = await r.json<Api.BranchRequest>();
      const branch = owner(d, user, (o) => {
        const thread = threadOf(o, r);
        const n = entryN(r);
        if (thread.subagent) throw new HttpError(409, "a subagent's thread can't be branched");
        if (!o[pool].entryPage(thread.id, { before: n + 1, limit: 1 }).entries.some((e) => e.n === n)) throw new HttpError(404, "no such message");
        return o[pool].branchThread(thread.id, n, { title: typeof title === "string" ? title : undefined });
      });
      inheritThread(d, user, pool, r.params.threadId!, branch.id);
      // A branch in a project is a thread of the project, anchored where its source hangs (or, of the project chat, where it branched).
      if (branch.child && branch.parent) s().children.adopt(user.id, pool, branch.id, branch.parent, branch.parent === r.params.threadId ? entryN(r) : s().children.anchorOf(user.id, pool, r.params.threadId!));
      return owner(d, user, (o) => summary(d, user, pool, o[pool], branch, []));
    }),
    route("PUT", `${t}/pin`, (r) => pinThread(d, d.userFor(r), r, true)),
    route("DELETE", `${t}/pin`, (r) => pinThread(d, d.userFor(r), r, false)),
    route("POST", `${t}/messages/:n/thread`, async (r) => {
      const user = d.userFor(r);
      const pool = poolOf(r);
      const { title } = await r.json<Api.StartThread>();
      const n = entryN(r);
      const { project, task } = owner(d, user, (o) => {
        const thread = threadOf(o, r);
        if (!thread.project) throw new HttpError(400, "threads are started from a project chat's messages");
        const entry = o[pool].entryPage(thread.id, { before: n + 1, limit: 1 }).entries.find((e) => e.n === n);
        if (!entry) throw new HttpError(404, "no such message");
        const said = userText(entry.data) ?? assistantText(entry.data);
        if (!said?.trim()) throw new HttpError(400, "start a thread from a message with text");
        return { project: thread.id, task: said };
      });
      if (s().children.stopped(user.id, pool, project)) throw new HttpError(409, "this project is paused or hidden; resume it to start threads");
      const name = (typeof title === "string" && title.trim()) || task.trim().split("\n")[0]!.slice(0, 80);
      let id: string;
      try { id = await s().children.startFrom(user.id, pool, project, n, { title: name, task }); } catch (err) { throw new HttpError(409, (err as Error).message); }
      return owner(d, user, (o) => summary(d, user, pool, o[pool], o[pool].getThread(id)!, []));
    }),
    route("POST", `${t}/resolve`, (r) => resolveThread(d, d.userFor(r), r, true)),
    route("POST", `${t}/reopen`, (r) => resolveThread(d, d.userFor(r), r, false)),
    route("POST", `${t}/suggestions/:callId/start`, async (r) => {
      const user = d.userFor(r);
      const pool = poolOf(r);
      const { index } = await r.json<Api.StartSuggestion>();
      const callId = r.params.callId!;
      const project = owner(d, user, (o) => threadOf(o, r));
      if (!project.project) throw new HttpError(400, "suggestions are a project chat's");
      const entries = owner(d, user, (o) => o[pool].entryPage(project.id, { limit: 100_000 }).entries);
      const list = suggestionsIn(entries.map((e) => e.data), callId);
      if (!list) throw new HttpError(404, "no such suggestion");
      const started = s().projects.started(user.id, pool, project.id);
      const wanted = index === undefined ? list.map((_, i) => i) : [Number(index)];
      if (wanted.some((i) => !list[i])) throw new HttpError(404, "no such suggested thread");
      const anchor = anchorOfCall(entries, callId) ?? owner(d, user, (o) => o[pool].nextEntryN(project.id));
      const made: string[] = [];
      for (const i of wanted) {
        // Claimed before the await, so a second click can't start the same thread.
        const key = `${user.id}/${pool}/${project.id}/${callId}#${i}`;
        if (started.has(`${callId}#${i}`) || startingSuggestions.has(key)) continue;
        startingSuggestions.add(key);
        let id: string;
        try {
          id = await s().children.startFrom(user.id, pool, project.id, anchor, list[i]!);
          s().projects.markStarted(user.id, pool, project.id, callId, i, id);
        } catch (err) {
          throw new HttpError(409, (err as Error).message);
        } finally {
          startingSuggestions.delete(key);
        }
        made.push(id);
      }
      return owner(d, user, (o) => made.map((id) => summary(d, user, pool, o[pool], o[pool].getThread(id)!, [])));
    }),
    route("GET", `${t}/overview`, (r): Api.ProjectOverview => {
      const user = d.userFor(r);
      const pool = poolOf(r);
      return owner(d, user, (o) => {
        const project = threadOf(o, r);
        if (!project.project) throw new HttpError(400, "only a project has an overview");
        const ids = o[pool].projectThreads(project.id);
        const threads = ids.slice(1).map((id) => summary(d, user, pool, o[pool], o[pool].getThread(id)!, []));
        return {
          threads, waiting: threads.filter((x) => x.state === "waiting").length, tokens: s().models.tokensFor(user.id, ids),
          started: Object.fromEntries(s().projects.started(user.id, pool, project.id)),
        };
      });
    }),
    route("PUT", `${t}/messages/:n/pin`, (r) => pin(d, d.userFor(r), r, true)),
    route("DELETE", `${t}/messages/:n/pin`, (r) => pin(d, d.userFor(r), r, false)),
    route("GET", `${t}/pins`, (r) => {
      const user = d.userFor(r);
      return owner(d, user, (o): Api.Pins => {
        const thread = threadOf(o, r);
        const pins = o[poolOf(r)].pins(thread.id).filter((p) => p.role === "user" || p.role === "assistant");
        const block = pinnedOf(o[poolOf(r)], thread.id);
        return {
          pins: pins.map((p) => ({ id: p.id, n: p.n, role: p.role as Api.Pin["role"], text: p.text, createdAt: p.createdAt })),
          shortened: !!block && pinnedBlock(block, DEFAULT_BUDGETS.pinned).shortened,
        };
      });
    }),
    route("POST", `${t}/messages/:n/rewind`, async (r) => rewind(d, d.userFor(r), r, await r.json<Api.RewindRequest>())),
    route("POST", `${t}/stop`, async (r) => {
      const user = d.userFor(r);
      const thread = owner(d, user, (o) => threadOf(o, r));
      await s().host.get(user.id, poolOf(r), thread.id).stop();
      // In a subagent's thread, Stop also stops the subagent's work.
      if (thread.subagent) s().delegation.stopThread(user.id, poolOf(r), thread.id);
      return { ok: true };
    }),
    route("POST", `${t}/permissions/:requestId`, async (r) => {
      const user = d.userFor(r);
      const { allow, mode, allowInThread } = await r.json<Api.PermissionAnswer>();
      const thread = owner(d, user, (o) => threadOf(o, r));
      if (!s().host.get(user.id, poolOf(r), thread.id).answer(r.params.requestId!, allow === true, mode, allowInThread === true)) throw new HttpError(404, "that request is no longer waiting");
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
    // --- The Files panel: the thread's folder and grants, every call inside the sandbox ---
    route("GET", `${t}/files`, async (r): Promise<Api.FileListing> => {
      const f = files(r);
      const dir = r.query.get("dir") || WORKDIR;
      return { roots: f.roots(), dir, ...(await refused(() => f.list(dir))) };
    }),
    route("GET", `${t}/files/search`, (r): Promise<Api.FileSearch> => refused(() => files(r).search(r.query.get("root") || WORKDIR, r.query.get("q") ?? ""))),
    route("GET", `${t}/files/images`, (r): Promise<Api.ImageEntry[]> => refused(() => files(r).images())),
    route("GET", `${t}/files/content`, async (r) => {
      const path = r.query.get("path") ?? "";
      const { stream, size, type } = await refused(() => files(r).read(path));
      const name = path.split("/").pop() ?? "file";
      r.res.writeHead(200, {
        "content-type": type, "content-length": String(size), "cache-control": "no-store",
        "content-disposition": `${r.query.get("download") ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`,
        "content-security-policy": "default-src 'none'; sandbox", "x-content-type-options": "nosniff",
      }),
      stream.on("error", () => r.res.destroy());
      stream.pipe(r.res);
      return undefined;
    }),
    route("POST", `${t}/files/upload`, async (r): Promise<Api.UploadResponse> => {
      const f = files(r);
      const bytes = await r.bytes(d.opts.uploadLimit ?? 50 * 1024 * 1024);
      return { path: await refused(() => f.upload(r.query.get("dir") || WORKDIR, r.query.get("name") ?? "", bytes)) };
    }),
    route("POST", `${t}/files/folder`, async (r): Promise<Api.Ok> => {
      const { path } = await r.json<Api.FileFolderInput>();
      await refused(() => files(r).mkdir(String(path ?? "")));
      return { ok: true };
    }),
    route("POST", `${t}/files/rename`, async (r): Promise<Api.Ok> => {
      const { from, to } = await r.json<Api.FileRenameInput>();
      await refused(() => files(r).rename(String(from ?? ""), String(to ?? "")));
      return { ok: true };
    }),
    route("POST", `${t}/files/delete`, async (r): Promise<Api.Ok> => {
      const { paths } = await r.json<Api.FilePathsInput>();
      if (!Array.isArray(paths)) throw new HttpError(400, "paths must be a list");
      await refused(() => files(r).remove(paths.map(String)));
      return { ok: true };
    }),
    route("POST", `${t}/files/zip`, async (r) => {
      const { paths } = await r.json<Api.FilePathsInput>();
      if (!Array.isArray(paths) || !paths.length) throw new HttpError(400, "paths must be a list");
      const zip = await refused(() => files(r).zip(paths.map(String)));
      const name = paths.length === 1 ? (String(paths[0]).split("/").pop() || "files") : "files";
      r.res.writeHead(200, {
        "content-type": "application/zip", "cache-control": "no-store",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${name}.zip`)}`,
        "content-security-policy": "default-src 'none'", "x-content-type-options": "nosniff",
      }),
      zip.on("error", () => r.res.destroy());
      zip.pipe(r.res);
      return undefined;
    }),
    // --- Speech: Dictation and Read aloud ---
    route("GET", `${u}/speech`, (r): Api.Speech => {
      const user = d.userFor(r);
      return speechState(s().models, s().models.callContext(user.id, checkPool(r.query.get("pool") ?? "general"), ""));
    }),
    route("POST", `${u}/transcribe`, async (r): Promise<Api.Transcription> => {
      const user = d.userFor(r);
      const pool = checkPool(r.query.get("pool") ?? "general");
      // Before a thread exists: the user's defaults for a new thread in this pool.
      const ctx = s().models.callContext(user.id, pool, "");
      return transcribeClip(s().models, ctx, pool, "", await readClip(r), r.query.get("language"), stopOnClose(r));
    }),
    route("POST", `${t}/transcribe`, async (r): Promise<Api.Transcription> => {
      const user = d.userFor(r);
      const pool = poolOf(r);
      const thread = owner(d, user, (o) => threadOf(o, r));
      const ctx = s().models.callContext(user.id, pool, thread.id);
      return transcribeClip(s().models, ctx, pool, thread.id, await readClip(r), r.query.get("language"), stopOnClose(r));
    }),
    route("GET", `${t}/messages/:n/speech`, async (r) => {
      const user = d.userFor(r);
      const pool = poolOf(r);
      let source: SpeechSource;
      const thread = owner(d, user, (o) => threadOf(o, r));
      const live = r.params.n === "live" ? s().host.peek(user.id, pool, thread.id)?.following() : undefined;
      if (live) {
        let read = "";
        let at = -1;
        // Made speakable as it grows; the text stays in memory only.
        source = {
          text: () => {
            const raw = live.text();
            if (raw.length !== at) {
              at = raw.length;
              // Titles need the pool open; most of a reply has no mention, so only then.
              const parts = [{ type: "text" as const, text: raw }];
              read = /\[(?:\w+\/)?[te]:/.test(raw) ? owner(d, user, (o) => messageText(parts, titlesIn(o, pool))) : messageText(parts);
            }
            return read;
          },
          done: live.done, more: live.more,
        };
      } else {
        // Live with nothing being written (she finished as it was pressed) reads her last message.
        const n = r.params.n === "live" ? undefined : entryN(r);
        const text = owner(d, user, (o) => {
          const message = n === undefined
            ? toMessages(thread.id, pool, o[pool].entryPage(thread.id, { limit: 20 }).entries).findLast((m) => m.role === "assistant")
            : toMessages(thread.id, pool, o[pool].entryPage(thread.id, { before: n + 1, limit: 1 }).entries.filter((e) => e.n === n))[0];
          if (!message) throw new HttpError(404, n === undefined ? "she hasn't written a message here" : "no such message");
          if (message.role !== "assistant") throw new HttpError(400, "only her messages are read aloud");
          return messageText(message.parts, titlesIn(o, pool));
        });
        source = storedSource(text);
      }
      const allowed = () => !!d.sessions.users(r.cookie)?.has(user.id) && d.keyring.hasUserKey(user.id);
      await readAloud({ models: s().models, ctx: s().models.callContext(user.id, pool, thread.id), pool, threadId: thread.id, source, res: r.res, allowed });
      return undefined;
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

    // --- Sleep: runs, items, /sleep ---
    route("GET", `${u}/sleep`, (r) => sleepOverview(d, d.userFor(r))),
    route("PUT", `${u}/sleep/mode`, async (r) => {
      const user = d.userFor(r);
      const { mode } = await r.json<Api.SleepModeChange>();
      s().sleep.setMode(user.id, mode);
      return sleepOverview(d, user);
    }),
    route("GET", `${u}/sleep/events`, (r) => {
      const user = d.userFor(r);
      const { res } = r;
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.write("retry: 3000\n\n");
      const allowed = () => !!d.sessions.users(r.cookie)?.has(user.id) && d.keyring.hasUserKey(user.id);
      let n = 0;
      const listener = (e: { userId: string } & Api.SleepEvent) => {
        if (e.userId !== user.id) return;
        if (!allowed()) return void res.end();
        const { userId: _u, ...event } = e;
        res.write(`id: ${++n}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      };
      s().sleep.events.on("event", listener);
      const check = setInterval(() => { if (!allowed()) res.end(); else res.write(": keep-alive\n\n"); }, 25_000);
      res.on("close", () => { clearInterval(check); s().sleep.events.off("event", listener); });
      return undefined;
    }),
    route("GET", `${u}/sleep/:pool/runs/:runId`, (r) => owner(d, d.userFor(r), (o) => sleepRunDetail(d, o, poolOf(r), r.params.runId!))),
    route("POST", `${u}/sleep/:pool`, async (r) => {
      const user = d.userFor(r);
      const { confirm } = await r.json<Api.SleepRequest>();
      return startSleep(d, user, poolOf(r), confirm === true);
    }),
    route("POST", `${u}/sleep/:pool/items/:itemId/chat`, async (r) => {
      const user = d.userFor(r);
      const pool = poolOf(r);
      const thread = owner(d, user, (o) => {
        const item = o[pool].getItem(r.params.itemId!);
        if (!item || item.dismissed) throw new HttpError(404, "no such item");
        if (item.thread) throw new HttpError(409, "a chat was already started from this item");
        const th = o[pool].createThread({ interface: "web" });
        s().workspace.settings(user.id).startThread(th.id, pool);
        o[pool].startItem(item.id, th.id);
        return th;
      });
      // She speaks first, with the item in her context (and in no other thread's).
      await s().host.get(user.id, pool, thread.id).send(OPENING);
      return owner(d, user, (o) => summary(d, user, pool, o[pool], o[pool].getThread(thread.id)!, []));
    }),
    route("DELETE", `${u}/sleep/:pool/items/:itemId`, (r) => {
      owner(d, d.userFor(r), (o) => o[poolOf(r)].dismissItem(r.params.itemId!));
      return { ok: true };
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
    route("GET", `${u}/admin/sleep`, (r) => { d.adminFor(r); return { time: d.sleepTime() }; }),
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
      const { approve, overwrite } = await r.json<Api.ProposalDecision>();
      s().persona.decide(actor, Number(r.params.id), approve === true, { overwrite: overwrite === true });
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

function checkKind(k: unknown): "ssh" | "proxmox" {
  if (k === undefined || k === "ssh") return "ssh";
  if (k !== "proxmox") throw new HttpError(400, "a machine's kind is ssh or proxmox");
  return k;
}
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

/**
 * A user's message in a subagent's thread goes to the subagent, the way
 * Lyrica's `message` does, marked as theirs. Only someone who can open the
 * parent thread gets here: it is in the same user's pool.
 */
async function toSubagent(d: Lyricad, user: User, pool: Pool, thread: Thread, text: string): Promise<Api.SendResponse> {
  const s = d.services!;
  const parent = owner(d, user, (o) => (thread.parent ? o[pool].getThread(thread.parent) : undefined));
  const row = s.delegation.store.byThread(user.id, pool, thread.id);
  if (!parent || !row || row.parent !== parent.id) throw new HttpError(409, "this subagent's parent thread is gone, so it can't be messaged");
  try {
    const sent = s.delegation.message({ user, pool, interface: parent.interface, threadId: parent.id }, row.run, { text, from: user },
      { thread: thread.id, budget: s.delegation.newBudget() });
    await sent.opened;
    return { queued: false };
  } catch (err) {
    throw new HttpError(409, (err as Error).message);
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

function toolList(tools: unknown): string[] {
  if (tools === undefined) return [];
  if (!Array.isArray(tools) || !tools.every((t) => typeof t === "string")) throw new Error("a role's tools are a list of tool names");
  return tools;
}

/** Every role the user's runs can use: built-ins, overridden or not, and their own. */
function roles(d: Lyricad, userId: string): Api.RoleInfo[] {
  const custom = new Set(d.services!.delegation.store.roles(userId).map((r) => r.name));
  return d.services!.delegation.roles(userId).map((r) => ({ ...r, custom: custom.has(r.name) }));
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
  const savedCredentials = d.keyring.hasSavedKey(user.id);
  const stayUnlocked = d.services!.users.stayUnlocked(user.id);
  return {
    user: card(fresh), previousNames: fresh.profile.previousNames, display: display(d, user.id), savedCredentials, stayUnlocked,
    ...(savedCredentials && !stayUnlocked
      ? { warning: "Your key is saved, so it is unlocked again whenever Lyrica restarts, even though logging out drops it." } : {}),
  };
}

function links(d: Lyricad, user: User): Api.UserCard[] {
  return d.services!.users.linked(user.id).map((id) => d.services!.users.get(id)).filter((u): u is User => !!u).map(card);
}

function endpointInfo(d: Lyricad, userId: string, id: string): Api.EndpointInfo {
  const ep = d.services!.models.endpoint(userId, id);
  if (!ep) throw new HttpError(404, `no endpoint ${id}`);
  return {
    id: ep.id, name: ep.name, kind: ep.kind, api: ep.api, baseUrl: ep.baseUrl, hasApiKey: !!ep.apiKey, shared: ep.shared,
    ...(ep.addresses ? { addresses: ep.addresses } : {}), ...(ep.fingerprint ? { fingerprint: ep.fingerprint } : {}),
    unencrypted: ep.unencrypted, stale: ep.stale, ...(ep.downSince ? { downSince: ep.downSince } : {}),
    models: d.services!.models.offerings(userId, ep.id).map((o) => toOfferingInfo(ep, o)),
  };
}

function toOfferingInfo(ep: Endpoint, o: Offering): Api.OfferingInfo {
  const { endpointId: _e, ...rest } = o;
  return { ...rest, label: `${ep.shared ? "shared." : ""}${ep.name}/${o.modelId}` };
}

function offeringInfo(d: Lyricad, userId: string, id: string): Api.OfferingInfo {
  const o = d.services!.models.offering(userId, id);
  if (!o) throw new HttpError(404, `no model ${id}`);
  return toOfferingInfo(o.endpoint, o.offering);
}

/** Only known capabilities, of the right types. With `clearing`, null clears one. */
function capabilities(input: object, clearing = false): Record<string, number | boolean | string[] | { voices: Api.Voice[] } | null> {
  const out: Record<string, number | boolean | string[] | { voices: Api.Voice[] } | null> = {};
  const levels = ["low", "medium", "high"];
  for (const k of CAPABILITIES) {
    const v = (input as Record<string, unknown>)[k];
    if (v === undefined) continue;
    if (v === null && clearing) out[k] = null;
    else if (k === "contextWindow" && typeof v === "number" && v > 0) out[k] = Math.floor(v);
    else if (k === "reasoning" && Array.isArray(v) && v.every((l) => levels.includes(l))) out[k] = levels.filter((l) => v.includes(l));
    // Each voice is checked in core.
    else if (k === "speak" && v && typeof v === "object" && Array.isArray((v as { voices?: unknown }).voices)) out[k] = { voices: (v as { voices: Api.Voice[] }).voices };
    else if (k !== "contextWindow" && k !== "reasoning" && k !== "speak" && typeof v === "boolean") out[k] = v;
    else throw new HttpError(400, `${k} must be ${k === "contextWindow" ? "a number of tokens" : k === "reasoning" ? "a list of low, medium and high" : k === "speak" ? "{ voices: [{ id, language }] }" : "true or false"}`);
  }
  return out;
}

function endpoints(d: Lyricad, userId: string): Api.EndpointInfo[] {
  return d.services!.models.endpoints(userId).map((e) => endpointInfo(d, userId, e.id));
}

function profiles(d: Lyricad, userId: string): Api.Profiles {
  const m = d.services!.models;
  return {
    local: m.profile(userId, "local"), cloud: m.profile(userId, "cloud"), custom: m.profile(userId, "custom"),
    default: m.defaultProfile(userId), thinking: m.defaultThinking(userId),
    fallback: m.defaultFallback(userId), sleepFallback: d.services!.sleep.fallback(userId),
    readAloudLive: m.defaultReadAloudLive(userId),
  };
}

/** A model reference from a request: an offering or a group, nothing else. */
function toRef(r: unknown): ModelRef {
  const o = (r ?? {}) as Record<string, unknown>;
  if (typeof o.offeringId === "string") return { offeringId: o.offeringId };
  if (typeof o.groupId === "string") return { groupId: o.groupId };
  throw new HttpError(400, "a model is { offeringId } or { groupId }");
}

function toRefs(list: unknown): ModelRef[] {
  if (!Array.isArray(list)) throw new HttpError(400, "expected a list of models");
  return list.map(toRef);
}

function strings(list: unknown): string[] {
  if (!Array.isArray(list) || list.some((x) => typeof x !== "string")) throw new HttpError(400, "expected a list of addresses");
  return list as string[];
}

function ids(list: unknown): string[] {
  if (!Array.isArray(list) || list.some((x) => typeof x !== "string")) throw new HttpError(400, "members are a list of offering IDs");
  return list as string[];
}

function networkDefaults(d: Lyricad, userId: string): Api.NetworkDefaults {
  const s = d.services!.workspace.settings(userId);
  return { general: s.defaultNetwork("general"), private: s.defaultNetwork("private") };
}

/** A machine as the API shows it: never its key or token. */
function machineInfo(m: MachineConfig): Api.MachineInfo {
  if (m.kind === "proxmox") {
    return {
      name: m.name, kind: "proxmox", address: proxmoxAddress(m.host, m.port), root: null, pool: m.pool, limit: m.limit,
      tokenId: m.username, hostKey: m.hostKey, offNetwork: m.offNetwork, lastUsed: m.lastUsed,
    };
  }
  const host = m.host.includes(":") ? `[${m.host}]` : m.host;
  return {
    name: m.name, kind: m.kind, address: `${m.username}@${host}${m.port === 22 ? "" : `:${m.port}`}`, root: m.root, pool: m.pool, limit: m.limit,
    keyLine: authorizedKeysLine(publicKeyOf(m.privateKey)), hostKey: m.hostKey, offNetwork: m.offNetwork, lastUsed: m.lastUsed,
    ...(m.state ? { state: m.state } : {}),
  };
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

/**
 * /sleep: sleeps the pool now. Manual mode asks first, and opens a fresh
 * thread once the run ends. Whatever stops it at once is a plain error.
 */
async function startSleep(d: Lyricad, user: User, pool: Pool, confirmed: boolean): Promise<Api.SleepStarted> {
  const { sleep } = d.services!;
  const manual = sleep.mode(user.id) === "manual";
  if (manual && !confirmed) return { confirm: `Sleep now? She'll consolidate, dream and wake for your ${pool} memory, and then a fresh thread opens.` };
  const { skip, reason } = await sleep.check(user.id, pool);
  const run = sleep.run(user.id, pool, "manual"); // records a skip too
  if (skip) {
    await run;
    throw new HttpError(409, `Sleep can't run now: ${reason}.`);
  }
  void run.then((done) => {
    if (!manual || done.status === "skipped" || !d.keyring.hasUserKey(user.id)) return;
    const thread = owner(d, user, (o) => o[pool].createThread({ interface: "web" }));
    d.services!.workspace.settings(user.id).startThread(thread.id, pool);
    sleep.events.emit("event", { type: "thread", userId: user.id, pool, threadId: thread.id });
  }).catch((err: Error) => d.log(`sleep failed: ${err.name}`));
  return { started: true };
}

function sleepRunInfo(pool: Pool, r: SleepRunRecord): Api.SleepRunInfo {
  return { pool, ...r };
}

function sleepItemInfo(pool: Pool, i: SleepItem): Api.SleepItemInfo {
  const { dismissed, ...rest } = i;
  return { pool, ...rest, new: !dismissed && !i.thread };
}

function sleepOverview(d: Lyricad, user: User): Api.SleepOverview {
  return owner(d, user, (o) => {
    const pools = ["general", "private"] as const;
    return {
      mode: d.services!.sleep.mode(user.id),
      time: d.sleepTime(),
      items: pools.flatMap((p) => o[p].listItems().map((i) => sleepItemInfo(p, i))).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      runs: pools.flatMap((p) => o[p].listSleepRuns(30).map((r) => sleepRunInfo(p, r))).sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    };
  });
}

function sleepRunDetail(d: Lyricad, o: OwnerView, pool: Pool, runId: string): Api.SleepRunDetail {
  const store = o[pool];
  const run = store.getSleepRun(runId);
  if (!run) throw new HttpError(404, "no such sleep run");
  const changes = run.status === "skipped" ? { notes: [], pages: [], journal: [] } : store.sleepChanges(run.startedAt, run.finishedAt ?? new Date().toISOString());
  const raw = (id: string) => store.get(id, { raw: true });
  const items = store.listItems({ run: run.id, includeDismissed: true }).map((i) => sleepItemInfo(pool, i));
  return {
    ...sleepRunInfo(pool, run),
    notes: changes.notes.map((id) => ({ id, text: raw(id)?.text ?? "" })),
    pages: changes.pages.map((p) => ({ id: p.id, ...(p.after.title ? { title: p.after.title } : {}), ...(p.before ? { before: p.before.text } : {}), after: p.after.text })),
    questions: items.filter((i) => i.kind === "question"),
    items: items.filter((i) => i.kind !== "question"),
    dream: changes.journal.map((id) => ({ id, text: raw(id)?.text ?? "" })),
    ...("wake" in changes && changes.wake !== undefined ? { wake: changes.wake } : {}),
    users: Object.fromEntries(d.services!.users.all().map((u) => [u.id, { displayName: u.profile.displayName, pronouns: u.profile.pronouns }])),
  };
}


/**
 * A thread with its child threads (forks, copies) nested under it. Subagents
 * aren't listed: they live inline, in their parent's delegate cards.
 */
function tree(d: Lyricad, user: User, pool: Pool, store: PoolStore, threads: Thread[], prefs: Map<string, ThreadPref>): Api.ThreadSummary[] {
  const listed = threads.filter((th) => !th.subagent);
  const children = new Map<string, Thread[]>();
  const nested = (th: Thread) => !!th.parent && listed.some((p) => p.id === th.parent);
  for (const th of listed) if (nested(th)) children.set(th.parent!, [...(children.get(th.parent!) ?? []), th]);
  const look = lookups(d, user);
  const build = (th: Thread): Api.ThreadSummary => summary(d, user, pool, store, th, (children.get(th.id) ?? []).map(build), look, prefs);
  return listed.filter((th) => !nested(th)).map(build);
}

/** Suggested threads being started now, so one started twice at once starts once. */
const startingSuggestions = new Set<string>();

function instructionsOf(store: PoolStore, project: string): { instructions?: string } {
  const instructions = store.pageForProject(project)?.instructions;
  return instructions ? { instructions } : {};
}

/** `prefs` is the user's thread preferences read once for a whole list; a single summary reads its own. */
function summary(d: Lyricad, user: User, pool: Pool, store: PoolStore, th: Thread, children: Api.ThreadSummary[], look = lookups(d, user), prefs?: Map<string, ThreadPref>): Api.ThreadSummary {
  const pref = prefs ? prefs.get(`${pool}/${th.id}`) : d.services!.prefs.get(user.id, pool, th.id);
  const inProject = th.child && th.parent ? look.project(pool, th.parent, store) : undefined;
  const mine = inProject?.find((x) => x.id === th.id);
  const settings = th.project ? d.services!.projects.settings(user.id, pool, th.id) : undefined;
  return {
    pool, id: th.id, interface: th.interface, subagent: th.subagent, child: th.child, hidden: th.hidden, unlogged: th.unlogged, createdAt: th.createdAt,
    updatedAt: store.lastEntry(th.id)?.createdAt ?? th.createdAt,
    ...(th.title ? { title: th.title } : {}), ...(th.parent ? { parent: th.parent } : {}),
    busy: d.services!.host.busy(user.id, pool, th.id), children, pinned: look.pinned().has(`${pool}/${th.id}`),
    ...(th.child ? childInfo(d, user, pool, th.id) : {}),
    ...(pref?.group ? { group: pref.group } : {}), ...(pref?.unread ? { unread: true } : {}),
    ...(th.project ? { project: true as const, ...(th.goal ? { goal: th.goal } : {}), ...instructionsOf(store, th.id) } : {}),
    ...(settings ? { projectSettings: {
      pageId: `p:${projectSlug(th.id)}`, paused: settings.paused, watchThreads: settings.watch, ...(settings.model ? { threadsModel: settings.model } : {}), ...(settings.thinking ? { threadsThinking: settings.thinking } : {}),
      ...(settings.fallback !== undefined ? { threadsFallback: settings.fallback } : {}),
    } } : {}),
    ...(mine ? { state: mine.state, ...(mine.anchor !== undefined ? { anchor: mine.anchor } : {}), ...(mine.needsYou ? { needsYou: true as const } : {}) } : {}),
  };
}

/** Per request: the user's pins and each project's threads, read once. */
function lookups(d: Lyricad, user: User) {
  let pinned: Set<string> | undefined;
  const projects = new Map<string, ProjectThreadInfo[] | undefined>();
  return {
    pinned: () => (pinned ??= d.services!.projects.pinned(user.id)),
    project: (pool: Pool, parent: string, store: PoolStore) => {
      const key = `${pool}/${parent}`;
      if (!projects.has(key)) projects.set(key, store.getThread(parent)?.project ? d.services!.children.projectThreads(user.id, pool, parent) : undefined);
      return projects.get(key);
    },
  };
}

/** Pins or unpins a thread: the user's own setting, in user.db. */
function pinThread(d: Lyricad, user: User, r: Request, pinned: boolean): Api.ThreadSummary {
  const pool = poolOf(r);
  return owner(d, user, (o) => {
    const thread = threadOf(o, r);
    if (thread.subagent) throw new HttpError(409, "a subagent's thread isn't in the thread list");
    d.services!.projects.pin(user.id, pool, thread.id, pinned);
    return summary(d, user, pool, o[pool], thread, []);
  });
}

/** Resolves or reopens a project's thread. */
function resolveThread(d: Lyricad, user: User, r: Request, resolved: boolean): Api.ThreadSummary {
  const pool = poolOf(r);
  return owner(d, user, (o) => {
    const thread = threadOf(o, r);
    if (!thread.child || !thread.parent || !o[pool].getThread(thread.parent)?.project) throw new HttpError(400, "only a project's thread is resolved or reopened");
    d.services!.children.setResolved(user.id, pool, thread.id, resolved);
    return summary(d, user, pool, o[pool], thread, []);
  });
}

/** The threads a `threads suggest` call proposed, from the project chat's stored entries. */
function suggestionsIn(entries: unknown[], callId: string): { title: string; task: string }[] | undefined {
  for (const e of entries) {
    const m = (e as { type?: string; message?: { role?: string; content?: unknown } }).message;
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const p of m.content as { type: string; id?: string; name?: string; arguments?: { action?: string; threads?: unknown } }[]) {
      if (p.type !== "toolCall" || p.id !== callId || p.name !== "threads" || p.arguments?.action !== "suggest" || !Array.isArray(p.arguments.threads)) continue;
      return (p.arguments.threads as { title?: unknown; task?: unknown }[])
        .map((t) => ({ title: String(t.title ?? "").trim().slice(0, 200), task: String(t.task ?? "").trim() })).filter((t) => t.title && t.task);
    }
  }
  return undefined;
}

/** The entry number of the reply holding a tool call, so threads started from its card hang there. */
function anchorOfCall(entries: { n: number; data: unknown }[], callId: string): number | undefined {
  for (const e of entries) {
    const m = (e.data as { message?: { role?: string; content?: unknown } }).message;
    if (m?.role === "assistant" && Array.isArray(m.content) && (m.content as { type: string; id?: string }[]).some((p) => p.type === "toolCall" && p.id === callId)) return e.n;
  }
  return undefined;
}

/** The text of one of her stored replies. */
function assistantText(data: unknown): string | undefined {
  const m = (data as { type?: string; message?: { role?: string; content?: unknown } }).message;
  if ((data as { type?: string }).type !== "message" || m?.role !== "assistant") return undefined;
  if (typeof m.content === "string") return m.content;
  return Array.isArray(m.content) ? m.content.filter((p: { type: string }) => p.type === "text").map((p: { text: string }) => p.text).join("") : "";
}

/** A child thread's status and unseen updates, for the sidebar. */
function childInfo(d: Lyricad, user: User, pool: Pool, id: string): Pick<Api.ThreadSummary, "status" | "unseen"> {
  const info = d.services!.children.info(user.id).get(`${pool}/${id}`);
  return { status: info?.status ?? d.services!.host.status(user.id, pool, id), unseen: info?.unseen ?? 0 };
}

/** The thread's context: from its open session, else what its last call record measured (no breakdown). */
function contextOf(d: Lyricad, user: User, pool: Pool, threadId: string, answered?: Api.CallInfo): { context: Api.ContextInfo } | undefined {
  const live = d.services!.host.context(user.id, pool, threadId);
  if (live) return { context: live };
  const p = answered?.pace;
  if (!p?.window) return undefined;
  // The last prompt plus the reply, as the live meter counts it. The record's output is the whole turn's, so a tool turn reads a little high.
  const tokens = p.promptTokens + p.outputTokens;
  const reserve = Math.max(0, Math.min(reserveFor(p.window), p.window - tokens));
  return { context: {
    tokens, window: p.window, percent: Math.round((tokens / p.window) * 100), reserve,
    free: Math.max(0, p.window - tokens - reserve), parts: [], measuredAt: answered!.at, pace: p,
  } };
}

function threadSettings(d: Lyricad, user: User, pool: Pool, threadId: string): Api.ThreadSettings {
  const { models, workspace } = d.services!;
  const ctx = models.callContext(user.id, pool, threadId);
  const tw = workspace.settings(user.id).thread(threadId);
  // The mode and switches her tools follow: a parent's later narrowing included.
  const applies = workspace.settings(user.id).effective(threadId);
  const isUnlogged = owner(d, user, (o) => o[pool].getThread(threadId)?.unlogged ?? false);
  let thinkingLevels: Api.ThinkingLevel[] = ["off"];
  const taskModel = (task: Api.ThreadTask): Api.TaskModel => {
    const override = ctx.overrides?.[task];
    const list = override?.length ? { list: override } : {};
    try {
      const r = models.resolve(task, task === "speech.transcribe" ? voiceContext(ctx) : ctx);
      if (task === "chat") thinkingLevels = ["off", ...(r.offering.reasoning ?? [])];
      return {
        model: r.ref, ...list, kind: r.endpoint.kind, endpointName: r.endpoint.name, label: r.label, modelId: r.offering.modelId,
        source: r.source,
      };
    } catch (err) {
      if (!(err instanceof NoModel) && !(err instanceof CloudModelForbidden)) throw err;
      const label = override?.[0] && models.label(user.id, refId(override[0]));
      return { ...list, ...(label ? { label } : {}), source: override?.length ? "thread" : "none", problem: (err as Error).message };
    }
  };
  const answered = models.recentCalls(user.id, { threadId, limit: 1, speech: false })[0];
  return {
    models: Object.fromEntries(THREAD_TASKS.map((task) => [task, taskModel(task)])) as Api.ThreadSettings["models"],
    profile: profileFor(ctx), profileChoice: models.threadProfile(user.id, threadId), thinking: ctx.thinking ?? "off", thinkingLevels,
    ...(answered ? { answered } : {}),
    ...(contextOf(d, user, pool, threadId, answered) ?? {}),
    localOnly: ctx.localOnly,
    internet: tw.internet, services: tw.services, hosts: tw.hosts,
    network: workspace.network({ userId: user.id, pool, threadId }),
    grants: tw.grants, machines: tw.machines, mode: applies.mode, webSearch: applies.webSearch, images: applies.images, unlogged: isUnlogged, parent: tw.parent,
    speech: speechState(models, ctx),
    fallback: models.threadFallback(user.id, threadId), fallbackOn: ctx.fallback !== false,
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
  if (change.profile && pool === "private") throw new CloudModelForbidden("a private thread always uses the local profile");
  if (change.profile !== undefined && change.profile !== null && change.profile !== "cloud" && change.profile !== "custom") throw new Error("a thread uses the cloud or the custom profile");
  if (change.thinking !== undefined && change.thinking !== null && !THINKING_LEVELS.includes(change.thinking)) throw new Error("thinking is off, low, medium or high");
  const overrides = { ...current.overrides };
  for (const [task, ref] of Object.entries(change.models ?? {})) {
    if (!(THREAD_TASKS as readonly string[]).includes(task)) throw new Error(`a thread can't choose a model for ${task}`);
    if (ref) overrides[task as Api.ThreadTask] = Array.isArray(ref) ? toRefs(ref) : [toRef(ref)];
    else delete overrides[task as Api.ThreadTask];
  }
  const profile = pool === "general" ? (change.profile === undefined ? current.profile : change.profile ?? models.defaultProfile(user.id)) : undefined;
  const next = { ...current, localOnly, overrides, ...(profile ? { profile } : {}) };
  for (const [task, list] of Object.entries(overrides)) overrides[task as Api.ThreadTask] = models.checkThreadList(next, task as Api.ThreadTask, list);
  if (change.unlogged === false && thread.parent) {
    owner(d, user, (o) => { if (o[pool].getThread(thread.parent!)?.unlogged) throw new Error("this thread's parent isn't logged, so it can't be logged either"); });
  }

  for (const k of ["webSearch", "images"] as const) if (change[k] !== undefined && typeof change[k] !== "boolean") throw new Error(`${k} is true or false`);
  if (change.fallback !== undefined && change.fallback !== null && typeof change.fallback !== "boolean") throw new Error("fallback is true, false or null");
  // The workspace checks grants, hosts, mode, switches, machines and the parent's limits, and writes only if all pass.
  const wsChange = pick(change, ["grants", "internet", "services", "hosts", "mode", "webSearch", "images", "machines"]);
  if (Object.keys(wsChange).length) ws.setThread(thread.id, pool, wsChange);

  if (change.localOnly !== undefined && pool === "general") models.setLocalOnly(user.id, pool, thread.id, change.localOnly);
  if (change.profile !== undefined && pool === "general") models.setThreadProfile(user.id, pool, thread.id, change.profile);
  if (change.thinking !== undefined) models.setThinking(user.id, thread.id, change.thinking);
  for (const task of Object.keys(change.models ?? {})) models.setThreadModel(user.id, pool, thread.id, task as Api.ThreadTask, overrides[task as Api.ThreadTask]);
  if (change.unlogged !== undefined) owner(d, user, (o) => o[pool].setUnlogged(thread.id, !!change.unlogged));
  if (change.fallback !== undefined) models.setThreadFallback(user.id, thread.id, change.fallback);
}

/** A signal that stops when the client goes away before the answer is sent. */
function stopOnClose(r: Request): AbortSignal {
  const stop = new AbortController();
  r.res.on("close", () => { if (!r.res.writableEnded) stop.abort(); });
  return stop.signal;
}

function entryN(r: Request): number {
  const n = Number(r.params.n);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "no such message");
  return n;
}

/**
 * A branch gets its parent's settings: models and local-only, and the
 * workspace, which then refuses anything wider than the parent's.
 */
function inheritThread(d: Lyricad, user: User, pool: Pool, parent: string, child: string): void {
  const { models, workspace } = d.services!;
  models.inheritContext(models.callContext(user.id, pool, parent), child);
  workspace.settings(user.id).inheritSettings(parent, child, pool);
}

/** The text of a stored user message, for sending again. */
function userText(data: unknown): string | undefined {
  const m = (data as { type?: string; message?: { role?: string; content?: unknown } }).message;
  if ((data as { type?: string }).type !== "message" || m?.role !== "user") return undefined;
  if (typeof m.content === "string") return m.content;
  return Array.isArray(m.content) ? m.content.filter((p: { type: string }) => p.type === "text").map((p: { text: string }) => p.text).join("") : "";
}

/** Pins or unpins one of the user's messages or her replies. */
function pin(d: Lyricad, user: User, r: Request, pinned: boolean): Api.Ok {
  const pool = poolOf(r);
  const n = entryN(r);
  return owner(d, user, (o) => {
    const thread = threadOf(o, r);
    if (thread.subagent) throw new HttpError(409, "a subagent's thread has no pins");
    const at = o[pool].entryPage(thread.id, { before: n + 1, limit: 1 }).entries.find((e) => e.n === n);
    const role = (at?.data as { type?: string; message?: { role?: string } } | undefined)?.message?.role;
    if (!at) throw new HttpError(404, "no such message");
    if (role !== "user" && role !== "assistant") throw new HttpError(400, "only your messages and her replies can be pinned");
    o[pool].pinEntry(thread.id, n, pinned);
    return { ok: true };
  });
}

/** A user's text can't carry the line that marks a parent's message to its child thread. */
function unmarked(text: string): string {
  if (FROM_PARENT.test(text)) throw new HttpError(400, "a message can't start with a [From t:…] line");
  if (WATCHING.test(text)) throw new HttpError(400, "a message can't start with a [Watching threads] line");
  return text;
}

/**
 * Delete from here, Regenerate and Edit. The thread's turn is held while its
 * subagents from those turns are stopped and the entries removed, so nothing
 * runs meanwhile; then the message is sent again, or the edited one.
 */
async function rewind(d: Lyricad, user: User, r: Request, req: Api.RewindRequest): Promise<Api.RewindResponse | Api.RemovalPlan> {
  const { host, delegation, models } = d.services!;
  const pool = poolOf(r);
  const n = entryN(r);
  const thread = owner(d, user, (o) => threadOf(o, r));
  if (thread.subagent) throw new HttpError(409, "a subagent's thread can't be rewound");
  if (host.busy(user.id, pool, thread.id)) throw new HttpError(409, "a turn is running: stop it or wait for it to end");
  // Where the removal starts, and what is sent after it.
  const { from, then } = owner(d, user, (o) => {
    const entries = o[pool].entryPage(thread.id, { before: n + 1, limit: n }).entries;
    const at = entries.find((e) => e.n === n);
    if (!at) throw new HttpError(404, "no such message");
    if (req.action === "delete") return { from: n, then: undefined };
    if (req.action === "edit") {
      const text = String(req.text ?? "");
      if (userText(at.data) === undefined) throw new HttpError(400, "only your own messages can be edited");
      if (!text.trim()) throw new HttpError(400, "the message is empty");
      return { from: n, then: unmarked(text) };
    }
    if (req.action !== "regenerate") throw new HttpError(400, "the action is delete, regenerate or edit");
    const asked = entries.filter((e) => e.n <= n && userText(e.data) !== undefined).at(-1);
    if (!asked || asked.n === n) throw new HttpError(400, "only her replies can be regenerated");
    return { from: asked.n, then: userText(asked.data)! };
  });
  // Regenerate with…: the router checks the model before anything is removed.
  if (req.action === "regenerate" && req.model) {
    const m = req.model as { offeringId?: unknown; groupId?: unknown };
    models.setThreadModel(user.id, pool, thread.id, "chat", m.groupId !== undefined ? { groupId: String(m.groupId) } : { offeringId: String(m.offeringId) });
  }
  if (req.preview) return removal(d, user, pool, thread.id, from).then(({ changes: _, ...plan }) => plan);
  const skip = new Set(Array.isArray(req.skip) ? req.skip.map(String) : []);
  let result: Api.RewindResponse = { removed: 0, subagents: 0, pins: 0, files: 0, branches: 0 };
  try {
    await host.get(user.id, pool, thread.id).rewind(async () => {
      // Read before the subagents go; undo files after they've stopped writing.
      const gathered = gather(d, user, pool, thread.id, from);
      const subagents = gathered.subagents.map((s) => s.thread);
      await delegation.forgetSubagents(user.id, pool, subagents);
      for (const id of subagents) await host.forget(user.id, pool, id);
      const plan = await removalPlan(gathered);
      const undone = await applyRemoval(plan, gathered, gathered.changes, skip);
      const done = owner(d, user, (o) => o[pool].truncateThread(thread.id, from, author(user)));
      // A project's threads hanging off removed messages stay, unanchored.
      if (thread.project) d.services!.children.unanchor(user.id, pool, thread.id, from);
      result = { removed: done.removed, subagents: done.subagents.length, pins: done.pins, ...undone };
      return from;
    }, then);
  } catch (err) {
    if (err instanceof Busy) throw new HttpError(409, err.message);
    throw err;
  }
  return result;
}

/** What removing from entry `from` would undo. Reads only. */
async function removal(d: Lyricad, user: User, pool: Pool, thread: string, from: number) {
  return removalPlan(gather(d, user, pool, thread, from));
}

/** The removed entries, their subagents (with runs and entries), pins and uploads, and where the thread's tools run. */
function gather(d: Lyricad, user: User, pool: Pool, thread: string, from: number): RemovalContext {
  const { workspace, delegation } = d.services!;
  const t = { userId: user.id, pool, threadId: thread };
  let target: RemovalContext["target"];
  try { target = workspace.targetFor(t); } catch { target = undefined; }
  const targetOf = (name: string) => {
    if (name === "sandbox") return target;
    try { return name.startsWith("ssh:") ? workspace.targetFor(t, name.slice(4)) : undefined; } catch { return undefined; }
  };
  return owner(d, user, (o) => {
    const store = o[pool];
    const subagents: RemovalContext["subagents"] = [];
    const walk = (id: string, run?: string) => {
      subagents.push({ thread: id, run, entries: entriesFrom(store, id, 1) });
      const runs = delegation.store.runs(user.id, pool, { parent: id });
      for (const c of store.listThreads({ includeHidden: true, parent: id })) walk(c.id, runs.find((x) => x.thread === c.id)?.run);
    };
    const top = delegation.store.runs(user.id, pool, { parent: thread });
    for (const id of store.subagentsSince(thread, from)) walk(id, top.find((x) => x.thread === id)?.run);
    const removed = entriesFrom(store, thread, from);
    const at = new Set(removed.map((e) => e.n));
    const uploadsKept = new Set([...uploadsIn(removed, WORKDIR)].filter((path) => store.entriesMentioning(path).some((m) => m.thread !== thread || !at.has(m.n))));
    return {
      pool, thread, removed, subagents, uploadsKept, target, targetOf,
      pins: store.pins(thread).filter((p) => p.n >= from).length,
      changes: workspace.changes(user.id),
      grants: target ? workspace.grantsFor(t) : [],
    };
  });
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
