// Share with and Notifications (DESIGN.md, "Where things are"; docs/briefs/web-2.md):
// a declined share leaves nothing in the recipient's pools; a shared private
// thread lands only where the recipient chooses; the sender's later messages
// never reach the copy.
import { describe, expect, it } from "vitest";
import type { Lyricad } from "../src/lyricad.ts";
import type { Notification, NotificationPage, ThreadSummary } from "../src/api.ts";
import { browser, daemon, enc, login, runtime } from "./helpers.ts";

const say = (d: Lyricad, userId: string, pool: "general" | "private", thread: string, role: "user" | "assistant", text: string) => {
  const o = d.services!.memory.openOwnerView(userId);
  try {
    o[pool].appendEntry(thread, { piId: `${role}-${Math.random()}`, role, data: { type: "message", message: { role, content: [{ type: "text", text }] } }, text });
  } finally {
    o.close();
  }
};

describe("Share with", () => {
  it("copies a thread as it is to the user who accepts it, into the pool they choose, and nothing to one who declines", async () => {
    const rt = await runtime();
    const { d, base } = await daemon(rt);
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    const li = await login(base, "li", "pw");
    const sam = await login(base, "sam", "pw2");
    const lu = `/api/u/${rt.li.id}`;
    const su = `/api/u/${rt.sam.id}`;
    // Li has a private thread with two entries, and knows who else is on the server.
    const t = (await li.post<ThreadSummary>(`${lu}/threads`, { pool: "private", title: "Garden plans" })).body;
    say(d, rt.li.id, "private", t.id, "user", "Where do the tomatoes go?");
    say(d, rt.li.id, "private", t.id, "assistant", "The south bed, by the fence.");
    expect((await li.get<{ id: string; displayName: string; linked: boolean }[]>(`${lu}/people`)).body).toEqual([{ id: rt.sam.id, displayName: "Sam", linked: false }]);
    const share = `${lu}/threads/private/${enc(t.id)}/share`;
    expect((await li.post(share, { to: rt.li.id })).status).toBe(400);
    expect((await li.post(share, { to: "nobody" })).status).toBe(400);
    const project = (await li.post<ThreadSummary>(`${lu}/threads`, { pool: "general", project: true })).body;
    expect((await li.post(`${lu}/threads/general/${enc(project.id)}/share`, { to: rt.sam.id })).status).toBe(400);
    expect((await li.post(share, { to: rt.sam.id })).status).toBe(200);

    // Sam sees it in Notifications, as a decision; Li sees nothing.
    let page = (await sam.get<NotificationPage>(`${su}/notifications`)).body;
    expect(page.waiting).toBe(1);
    expect(page.types).toEqual(["share"]);
    const n = page.items[0]!;
    expect(n).toMatchObject({ type: "share", title: "Li shared “Garden plans” with you", decision: true, scope: "general" });
    expect(n.actions.map((a) => a.label)).toEqual(["Add to General", "Add to Private", "Decline"]);
    expect((await li.get<NotificationPage>(`${lu}/notifications`)).body.total).toBe(0);
    // Only the recipient can act on it.
    const shareId = n.id.slice("share:".length);
    expect((await li.del(`${lu}/shares/${shareId}`)).status).toBe(404);
    expect((await li.post(`${lu}/shares/${shareId}/accept`, { pool: "general" })).status).toBe(404);

    // Declined: nothing in either of Sam's pools, and the share is gone.
    const decline = n.actions.find((a) => a.label === "Decline")!;
    expect((await sam.call(decline.method, decline.path, decline.body)).status).toBe(200);
    expect((await sam.get<ThreadSummary[]>(`${su}/threads`)).body).toEqual([]);
    expect((await sam.get<NotificationPage>(`${su}/notifications`)).body.total).toBe(0);
    expect((await sam.del(`${su}/shares/${shareId}`)).status).toBe(404);

    // Shared again; Li goes on talking afterwards.
    expect((await li.post(share, { to: rt.sam.id })).status).toBe(200);
    say(d, rt.li.id, "private", t.id, "user", "And the beans?");
    page = (await sam.get<NotificationPage>(`${su}/notifications`)).body;
    const add = page.items[0]!.actions.find((a) => a.label === "Add to Private")!;
    const copy = (await sam.call<ThreadSummary>(add.method, add.path, add.body)).body;
    expect(copy).toMatchObject({ pool: "private", title: "Garden plans" });
    expect(copy.id).not.toBe(t.id);
    // Only in Private, with the two entries from when it was sent, and the share is gone.
    const threads = (await sam.get<ThreadSummary[]>(`${su}/threads`)).body;
    expect(threads.map((x) => [x.pool, x.id])).toEqual([["private", copy.id]]);
    const messages = (await sam.get<{ messages: { role: string; parts: { text?: string }[] }[] }>(`${su}/threads/private/${enc(copy.id)}/messages`)).body.messages;
    expect(messages.map((m) => m.parts[0]!.text)).toEqual(["Where do the tomatoes go?", "The south bed, by the fence."]);
    expect((await sam.get<NotificationPage>(`${su}/notifications`)).body.total).toBe(0);
    // Indexed in Sam's pool: search finds it there; Li's own thread still has three entries.
    expect((await sam.get<{ hits?: unknown[] } | unknown[]>(`${su}/memory/search?q=tomatoes`)).status).toBe(200);
    const lis = (await li.get<{ messages: unknown[] }>(`${lu}/threads/private/${enc(t.id)}/messages`)).body.messages;
    expect(lis).toHaveLength(3);
  });

  it("filters, sorts and pages the notifications", async () => {
    const rt = await runtime();
    const { d, base } = await daemon(rt);
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    const li = await login(base, "li", "pw");
    const sam = await login(base, "sam", "pw2");
    const lu = `/api/u/${rt.li.id}`;
    const su = `/api/u/${rt.sam.id}`;
    for (const title of ["One", "Two", "Three"]) {
      const t = (await li.post<ThreadSummary>(`${lu}/threads`, { pool: "general", title })).body;
      say(d, rt.li.id, "general", t.id, "user", title);
      expect((await li.post(`${lu}/threads/general/${enc(t.id)}/share`, { to: rt.sam.id })).status).toBe(200);
    }
    const titles = (p: NotificationPage) => p.items.map((n: Notification) => n.title.replace(/^Li shared “(.*)” with you$/, "$1"));
    const all = (await sam.get<NotificationPage>(`${su}/notifications`)).body;
    expect(all.total).toBe(3);
    expect(titles(all)).toEqual(["Three", "Two", "One"]);
    expect(titles((await sam.get<NotificationPage>(`${su}/notifications?sort=oldest`)).body)).toEqual(["One", "Two", "Three"]);
    const second = (await sam.get<NotificationPage>(`${su}/notifications?offset=1&limit=1`)).body;
    expect(titles(second)).toEqual(["Two"]);
    expect(second.total).toBe(3);
    expect((await sam.get<NotificationPage>(`${su}/notifications?type=sleep`)).body.total).toBe(0);
    expect((await sam.get<NotificationPage>(`${su}/notifications?type=decision&scope=general`)).body.total).toBe(3);
    expect((await sam.get<NotificationPage>(`${su}/notifications?scope=private`)).body.total).toBe(0);
    // The sidebar's count asks for no items.
    const count = (await sam.get<NotificationPage>(`${su}/notifications?limit=0`)).body;
    expect(count).toMatchObject({ items: [], total: 3, waiting: 3 });
  });
});
