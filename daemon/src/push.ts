// Principles 6 and 2: reach the user without sending any conversation words.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { PUSH_LIMITS, PushStore, resolveHost, inOwnNetwork, type PushSettings, type User } from "@lyrica/core";
import type { NotificationType } from "./api.ts";
import { notifications } from "./notifications.ts";
import { display } from "./routes.ts";
import type { Lyricad } from "./lyricad.ts";

export const PUSH_PHRASES: Partial<Record<NotificationType, string>> = {
  question: "A question is waiting.", permission: "A permission is waiting.", share: "A share is waiting.",
  suggestion: "A suggested persona change is waiting.", approval: "A persona change waits for approval.", update: "A thread is waiting on you.",
};
export const pushBody = (types: string[]) => types.length === 1 ? PUSH_PHRASES[types[0] as NotificationType] ?? "Something is waiting." : `${types.length} things are waiting.`;
const blocked = new BlockList();
for (const [ip, bits] of [["127.0.0.0", 8], ["169.254.0.0", 16], ["0.0.0.0", 8], ["224.0.0.0", 4]] as const) blocked.addSubnet(ip, bits, "ipv4");
for (const [ip, bits] of [["::", 128], ["::1", 128], ["fe80::", 10], ["ff00::", 8]] as const) blocked.addSubnet(ip, bits, "ipv6");

/** Resolve at Save and every attempt; the transport connects only to these checked addresses. */
export async function pushTarget(value: string, admin: boolean, resolve = resolveHost, excludedHosts: string[] = []): Promise<{ url: URL; addresses: string[] }> {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Enter a valid push URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("Use an HTTP or HTTPS URL without credentials or a fragment.");
  const { addresses } = await resolve(url.hostname.replace(/^\[|\]$/g, ""));
  const own = new BlockList();
  const frontDoor = await Promise.all(excludedHosts.filter(Boolean).map(async host => {
    if (host.toLowerCase() === url.hostname.toLowerCase()) throw new Error("Push cannot reach this server.");
    return (await resolve(host).catch(() => ({ addresses: [] }))).addresses;
  }));
  for (const address of [...Object.values(networkInterfaces()).flatMap(v => v ?? []).map(v => v.address), ...frontDoor.flat()]) {
    own.addAddress(address, isIP(address) === 6 ? "ipv6" : "ipv4");
  }
  if (!addresses.length || addresses.some(a => blocked.check(a, isIP(a) === 6 ? "ipv6" : "ipv4") || own.check(a, isIP(a) === 6 ? "ipv6" : "ipv4"))) throw new Error("Push cannot reach this server, loopback or link-local addresses.");
  if (url.protocol === "http:" && addresses.some(a => !inOwnNetwork(a))) throw new Error("HTTP push requires a host on the operator's network.");
  if (!admin && addresses.some(inOwnNetwork)) throw new Error("Push requires a public HTTPS host.");
  if (!admin && url.protocol !== "https:") throw new Error("Push requires HTTPS.");
  return { url, addresses };
}

export interface PushResult { status: number; reason: string }
/** Never follows redirects; DNS is pinned to an address checked above, including retries. */
export function postPush(target: Awaited<ReturnType<typeof pushTarget>>, settings: PushSettings, body: string): Promise<PushResult> {
  return new Promise(resolve => {
    const headers: Record<string, string> = { Title: "Lyrica", Tags: "bell", "Content-Type": "text/plain; charset=utf-8" };
    if (settings.link) headers.Click = settings.origin + "/notifications";
    if (settings.token) headers.Authorization = `Bearer ${settings.token}`;
    const address = target.addresses[0]!;
    const req = (target.url.protocol === "https:" ? httpsRequest : httpRequest)(target.url, {
      method: "POST", headers, family: isIP(address), lookup: (_host, _options, cb) => cb(null, address, isIP(address)),
      signal: AbortSignal.timeout(PUSH_LIMITS.timeout),
    }, res => { res.resume(); resolve({ status: res.statusCode ?? 0, reason: res.statusCode! >= 200 && res.statusCode! < 300 ? "Sent" : "Receiver refused the push." }); });
    req.on("error", () => resolve({ status: 0, reason: "Receiver could not be reached." }));
    req.end(body);
  });
}

export class Push {
  private pendingSince = new Map<string, number>();
  private busy = new Set<string>();
  constructor(private d: Lyricad, private transport = postPush, private target = (url: string, admin: boolean) => pushTarget(url, admin, resolveHost, this.d.services?.web.frontDoor().hosts), private pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms))) {}
  private store<T>(user: User, fn: (s: PushStore) => T): T {
    const db = this.d.services!.users.openUserDb(user.id);
    try { return fn(new PushStore(db)); } finally { db.close(); }
  }
  async send(user: User, settings: PushSettings, body: string): Promise<PushResult> {
    let result: PushResult = { status: 0, reason: "Push destination refused." };
    for (let attempt = 0; attempt <= PUSH_LIMITS.retries; attempt++) {
      if (!this.d.services || !this.d.keyring.hasUserKey(user.id)) return result;
      try { result = await this.transport(await this.target(settings.url, this.d.services.users.get(user.id)?.admin ?? false), settings, body); }
      catch { result = { status: 0, reason: "Push destination refused." }; }
      if (result.status >= 200 && result.status < 300) break;
      this.d.log(`push failed: ${new URL(settings.url).hostname} ${result.status}`);
      if (attempt < PUSH_LIMITS.retries) await this.pause(1000 * 2 ** attempt);
    }
    if (this.d.services && this.d.keyring.hasUserKey(user.id)) this.store(user, s => {
      if (result.status >= 200 && result.status < 300) s.sent([], Date.now());
      else s.failed({ at: new Date().toISOString(), status: result.status });
    });
    return result;
  }
  async check(user: User, immediate = false, now = Date.now()): Promise<void> {
    if (!this.d.services || !this.d.keyring.hasUserKey(user.id) || this.busy.has(user.id)) return;
    this.busy.add(user.id);
    try {
      const settings = this.store(user, s => s.settings());
      if (!settings) { this.pendingSince.delete(user.id); return; }
      const items = [];
      for (let offset = 0; ; offset += 200) {
        const page = notifications(this.d, user, display(this.d, user.id), { offset, limit: 200 });
        items.push(...page.items);
        if (offset + page.items.length >= page.total) break;
      }
      const decisions = items.filter(n => n.decision && n.type !== "sleep");
      const ids = this.store(user, s => s.pending(decisions.map(n => n.id), now));
      if (!ids.length) { this.pendingSince.delete(user.id); return; }
      const since = this.pendingSince.get(user.id) ?? now;
      this.pendingSince.set(user.id, since);
      if ((!immediate && now - since < PUSH_LIMITS.window) || now - this.store(user, s => s.lastAttempt()) < PUSH_LIMITS.minimumGap) return;
      this.store(user, s => s.attempted(now));
      const selected = new Set(ids);
      const result = await this.send(user, settings, pushBody(decisions.filter(n => selected.has(n.id)).map(n => n.type)));
      if (this.d.services && this.d.keyring.hasUserKey(user.id) && result.status >= 200 && result.status < 300) this.store(user, s => s.sent(ids, now));
      this.pendingSince.delete(user.id);
    } finally { this.busy.delete(user.id); }
  }
  tick(immediate = false) {
    if (!this.d.services) return;
    for (const user of this.d.services.users.all()) void this.check(user, immediate).catch(() => this.d.log("push check failed"));
  }
}
