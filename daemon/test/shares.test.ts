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
    const ada = await login(base, "ada", "pw");
    const sam = await login(base, "sam", "pw2");
    const lu = `/api/u/${rt.ada.id}`;
    const su = `/api/u/${rt.sam.id}`;
    // Ada has a private thread with two entries, and knows who else is on the server.
    const t = (await ada.post<ThreadSummary>(`${lu}/threads`, { pool: "private", title: "Garden plans" })).body;
    say(d, rt.ada.id, "private", t.id, "user", "Where do the tomatoes go?");
    say(d, rt.ada.id, "private", t.id, "assistant", "The south bed, by the fence.");
    expect((await ada.get<{ id: string; displayName: string; linked: boolean }[]>(`${lu}/people`)).body).toEqual([{ id: rt.sam.id, displayName: "Sam", linked: false }]);
    const share = `${lu}/threads/private/${enc(t.id)}/share`;
    expect((await ada.post(share, { to: rt.ada.id })).status).toBe(400);
    expect((await ada.post(share, { to: "nobody" })).status).toBe(400);
    const project = (await ada.post<ThreadSummary>(`${lu}/threads`, { pool: "general", project: true })).body;
    expect((await ada.post(`${lu}/threads/general/${enc(project.id)}/share`, { to: rt.sam.id })).status).toBe(400);
    expect((await ada.post(share, { to: rt.sam.id })).status).toBe(200);

    // Sam sees it in Notifications, as a decision; Ada sees nothing.
    let page = (await sam.get<NotificationPage>(`${su}/notifications`)).body;
    expect(page.waiting).toBe(1);
    expect(page.types).toEqual(["share"]);
    const n = page.items[0]!;
    // A private thread goes to Private only.
    expect(n).toMatchObject({ type: "share", title: "Ada shared “Garden plans” with you", decision: true, scope: "private" });
    expect(n.actions.map((a) => a.label)).toEqual(["Add to Private", "Decline"]);
    expect((await sam.post(`${su}/shares/${n.id.slice("share:".length)}/accept`, { pool: "general" })).status).toBe(409);
    expect((await ada.get<NotificationPage>(`${lu}/notifications`)).body.total).toBe(0);
    // Only the recipient can act on it.
    const shareId = n.id.slice("share:".length);
    expect((await ada.del(`${lu}/shares/${shareId}`)).status).toBe(404);
    expect((await ada.post(`${lu}/shares/${shareId}/accept`, { pool: "general" })).status).toBe(404);

    // Declined: nothing in either of Sam's pools, and the share is gone.
    const decline = n.actions.find((a) => a.label === "Decline")!;
    expect((await sam.call(decline.method, decline.path, decline.body)).status).toBe(200);
    expect((await sam.get<ThreadSummary[]>(`${su}/threads`)).body).toEqual([]);
    expect((await sam.get<NotificationPage>(`${su}/notifications`)).body.total).toBe(0);
    expect((await sam.del(`${su}/shares/${shareId}`)).status).toBe(404);

    // Shared again; Ada goes on talking afterwards.
    expect((await ada.post(share, { to: rt.sam.id })).status).toBe(200);
    say(d, rt.ada.id, "private", t.id, "user", "And the beans?");
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
    // Indexed in Sam's pool: search finds it there; Ada's own thread still has three entries.
    expect((await sam.get<{ hits?: unknown[] } | unknown[]>(`${su}/memory/search?q=tomatoes`)).status).toBe(200);
    const lis = (await ada.get<{ messages: unknown[] }>(`${lu}/threads/private/${enc(t.id)}/messages`)).body.messages;
    expect(lis).toHaveLength(3);
  });

  it("sends the conversation alone: none of her memory, its IDs or her thinking, and a local-only thread stays off the cloud", async () => {
    const rt = await runtime();
    const { d, base } = await daemon(rt);
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    const ada = await login(base, "ada", "pw");
    const sam = await login(base, "sam", "pw2");
    const lu = `/api/u/${rt.ada.id}`;
    const su = `/api/u/${rt.sam.id}`;
    const t = (await ada.post<ThreadSummary>(`${lu}/threads`, { pool: "general", title: "Bees" })).body;
    expect((await ada.patch(`${lu}/threads/general/${enc(t.id)}/settings`, { localOnly: true })).status).toBe(200);
    // What a turn leaves in the thread: her context, a memory tool's call and result, a reply with citations and thinking, a shell call.
    const o = d.services!.memory.openOwnerView(rt.ada.id);
    try {
      const add = (role: string, data: unknown, text: string) => o.general.appendEntry(t.id, { piId: `${role}-${Math.random()}`, role, data, text });
      add("custom", { type: "custom", customType: "lyrica-context", data: { recall: "SECRETNOTE the hive is by the apple tree [n:hive1]" } }, "");
      add("user", { type: "message", message: { role: "user", content: [{ type: "text", text: "Where is the hive?" }] } }, "Where is the hive?");
      add("assistant", { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "recall", arguments: { query: "hive" } }] } }, "");
      add("toolResult", { type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "recall", content: [{ type: "text", text: "SECRETNOTE [n:hive1]" }] } }, "");
      add("assistant", { type: "message", message: { role: "assistant", content: [
        { type: "thinking", thinking: "PRIVATETHOUGHT about n:hive1" },
        { type: "text", text: "By the apple tree [n:hive1, general/p:garden], as you wrote [e:t1#3]." },
        { type: "toolCall", id: "c2", name: "bash", arguments: { command: "date" } },
      ] } }, "By the apple tree [n:hive1, general/p:garden], as you wrote [e:t1#3].\nbash({\"command\":\"date\"})");
      add("toolResult", { type: "message", message: { role: "toolResult", toolCallId: "c2", toolName: "bash", content: [{ type: "text", text: "Sun Oct 12" }] } }, "bash: Sun Oct 12");
    } finally {
      o.close();
    }
    expect((await ada.post(`${lu}/threads/general/${enc(t.id)}/share`, { to: rt.sam.id })).status).toBe(200);
    const n = (await sam.get<NotificationPage>(`${su}/notifications`)).body.items[0]!;
    expect(n.detail).toMatch(/^3 entries/);
    const add = n.actions.find((a) => a.label === "Add to General")!;
    const copy = (await sam.call<ThreadSummary>(add.method, add.path, add.body)).body;
    // Sam's copy: the question, the reply without its citations, the shell call and its result. Nothing of memory.
    const stored = d.services!.memory.openOwnerView(rt.sam.id);
    try {
      const entries = stored.general.loadEntries(copy.id);
      const everything = JSON.stringify(entries);
      expect(everything).not.toContain("SECRETNOTE");
      expect(everything).not.toContain("PRIVATETHOUGHT");
      expect(everything).not.toContain("n:hive1");
      expect(everything).not.toContain("p:garden");
      expect(everything).not.toContain("e:t1#3");
      expect(everything).not.toContain("recall");
      expect(everything).toContain("By the apple tree, as you wrote.");
      expect(everything).toContain("Sun Oct 12");
      expect(entries).toHaveLength(3);
    } finally {
      stored.close();
    }
    // Kept off the cloud, as the original was.
    expect(d.services!.models.callContext(rt.sam.id, "general", copy.id).localOnly).toBe(true);
  });

  it("shows nothing from a pool the display has off", async () => {
    const rt = await runtime();
    const { d, base } = await daemon(rt);
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    const ada = await login(base, "ada", "pw");
    const sam = await login(base, "sam", "pw2");
    const lu = `/api/u/${rt.ada.id}`;
    const su = `/api/u/${rt.sam.id}`;
    const t = (await ada.post<ThreadSummary>(`${lu}/threads`, { pool: "private", title: "Quiet" })).body;
    say(d, rt.ada.id, "private", t.id, "user", "between us");
    expect((await ada.post(`${lu}/threads/private/${enc(t.id)}/share`, { to: rt.sam.id })).status).toBe(200);
    expect((await sam.get<NotificationPage>(`${su}/notifications`)).body).toMatchObject({ total: 1, waiting: 1 });
    expect((await sam.patch(`${su}/me/display`, { showPrivate: false })).status).toBe(200);
    expect((await sam.get<NotificationPage>(`${su}/notifications`)).body).toMatchObject({ total: 0, waiting: 0, types: [] });
    expect((await sam.patch(`${su}/me/display`, { showPrivate: true })).status).toBe(200);
    expect((await sam.get<NotificationPage>(`${su}/notifications`)).body.waiting).toBe(1);
  });

  it("filters, sorts and pages the notifications", async () => {
    const rt = await runtime();
    const { d, base } = await daemon(rt);
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    const ada = await login(base, "ada", "pw");
    const sam = await login(base, "sam", "pw2");
    const lu = `/api/u/${rt.ada.id}`;
    const su = `/api/u/${rt.sam.id}`;
    for (const title of ["One", "Two", "Three"]) {
      const t = (await ada.post<ThreadSummary>(`${lu}/threads`, { pool: "general", title })).body;
      say(d, rt.ada.id, "general", t.id, "user", title);
      expect((await ada.post(`${lu}/threads/general/${enc(t.id)}/share`, { to: rt.sam.id })).status).toBe(200);
    }
    const titles = (p: NotificationPage) => p.items.map((n: Notification) => n.title.replace(/^Ada shared “(.*)” with you$/, "$1"));
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
