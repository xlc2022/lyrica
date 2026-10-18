import { Memory, Models, Users, Workspace, type Pool } from "@lyrica/core";
import type { Delegation, ThreadContext } from "@lyrica/extension";
import { afterEach, describe, expect, it } from "vitest";
import { freshKeyring, profile } from "../../core/test/helpers.ts";
import { ChildThreads, MAX_WAKE_ROUNDS } from "../src/children.ts";
import type { ThreadHost } from "../src/hosted.ts";

const close: (() => void)[] = [];
afterEach(() => { for (const fn of close.splice(0)) fn(); });

async function setup() {
  const keyring = await freshKeyring();
  const users = new Users(keyring);
  const user = await users.createUser("ada", "pw", profile("Ada"), { admin: true });
  await users.authenticate("ada", "pw");
  const memory = new Memory(keyring, users);
  const models = new Models(keyring, users);
  const workspace = new Workspace(keyring, users, { excludePorts: [] });
  close.push(() => workspace.settings(user.id).close());
  const view = memory.openThreadView(user.id, "general");
  close.push(() => view.close());
  const parent = view.own.createThread({ interface: "web", project: true });
  const child = view.own.createThread({ interface: "web", parent: parent.id, child: true });
  const busy = new Set<string>();
  const wakes: string[] = [];
  const notices: string[] = [];
  const replies: string[] = [];
  const sends: string[] = [];
  let childWakeTurn = false;
  const host = {
    busy: (_u: string, _p: Pool, t: string) => busy.has(t),
    changed: () => {}, delivered: () => {}, peek: () => undefined,
    get: (_u: string, _p: Pool, t: string) => ({
      get childWakeTurn() { return childWakeTurn; },
      appendParent: (text: string) => { replies.push(text); },
      send: async (text: string) => { busy.add(t); sends.push(text); return { queued: false }; },
      wakeChild: async (note?: string) => { childWakeTurn = !note; busy.add(t); wakes.push(t); },
    }),
  } as unknown as ThreadHost;
  let paused = false;
  const children = new ChildThreads({ users, memory, models, workspace, host: () => host,
    delegation: { deliver: (_ref: unknown, text: string) => notices.push(text) } as unknown as Delegation,
    paused: () => paused, limits: { concurrency: 1 } });
  children.adopt(user.id, "general", child.id, parent.id, undefined);
  const from = { user, pool: "general", threadId: child.id, interface: "web", view } as ThreadContext;
  const flush = async () => { await new Promise<void>(r => setImmediate(r)); };
  const end = () => { busy.delete(parent.id); children.turn(user.id, "general", parent.id, false); children.ended(user.id, "general", parent.id, "done"); };
  const parentFrom = { ...from, threadId: parent.id } as ThreadContext;
  return { children, parentFrom, users, user, parent, child, from, busy, wakes, notices, replies, sends, host, flush, end, pause: (p: boolean) => { paused = p; } };
}

describe("child wake guards", () => {
  it("a question wakes its project chat once, and resolving withdraws it and clears waiting immediately", async () => {
    const s = await setup();
    const store = s.from.view.own;
    const args = { action: "ask", question: "Which flowers?", options: [{ label: "Tulips", consequence: "Plant bulbs." }, { label: "Roses", consequence: "Plant shrubs." }], recommended: 0 };
    const n = store.nextEntryN(s.child.id);
    store.appendEntry(s.child.id, { piId: "question", role: "assistant", text: "", data: { type: "message", message: { content: [{ type: "toolCall", id: "q", name: "threads", arguments: args }] } } });
    store.askQuestion(s.child.id, n);
    await s.children.asked(s.from);
    await s.flush();
    expect(s.wakes).toEqual([s.parent.id]);
    expect(s.notices).toHaveLength(1);
    const db = s.users.openUserDb(s.user.id);
    expect(db.prepare("SELECT needs_you FROM child_threads WHERE thread = ?").get(s.child.id)).toEqual({ needs_you: 1 });
    s.children.setResolved(s.user.id, "general", s.child.id, true);
    expect(store.openQuestion(s.child.id)).toBeUndefined();
    expect(store.questions(s.child.id)[0]).toMatchObject({ n, answer: "withdrawn" });
    expect(db.prepare("SELECT needs_you FROM child_threads WHERE thread = ?").get(s.child.id)).toEqual({ needs_you: 0 });
    db.close();
  });

  it("needsYou waits while paused, then wakes on resume", async () => {
    const s = await setup();
    s.pause(true);
    await s.children.message(s.from, "parent", "Choose the flowers.", { needsYou: true });
    await s.flush();
    expect(s.notices).toHaveLength(1);
    expect(s.wakes).toEqual([]);
    s.pause(false);
    s.children.resume(s.user.id);
    await s.flush();
    expect(s.wakes).toEqual([s.parent.id]);
  });

  it("wakes the parent without a child's slot, and coalesces pending questions", async () => {
    const s = await setup();
    // The one slot is taken by the asking child itself: waiting for it would leave both waiting.
    s.busy.add(s.child.id);
    expect(await s.children.message(s.from, "parent", "First?", { question: true })).toBe("wakes");
    expect(await s.children.message(s.from, "parent", "Second?", { question: true })).toBe("wakes");
    await s.flush();
    expect(s.wakes).toEqual([s.parent.id]);
    expect(await s.children.message(s.from, "parent", "Halfway there.")).toBe("update");
  });

  it("saves a message to an idle thread past the limit, and wakes it when a slot frees", async () => {
    const s = await setup();
    const other = s.parentFrom.view.own.createThread({ interface: "web", parent: s.parent.id, child: true });
    s.children.adopt(s.user.id, "general", other.id, s.parent.id, undefined);
    s.busy.add(other.id);
    expect(await s.children.message(s.parentFrom, s.child.id, "Plant the tulips.")).toBe("queued");
    expect(s.replies).toEqual(["Plant the tulips."]);
    expect(s.sends).toEqual([]);
    s.busy.delete(other.id);
    s.children.turn(s.user.id, "general", other.id, false);
    await s.flush();
    expect(s.wakes).toEqual([s.child.id]);
  });

  it("wakes on a final report, including a user-started child's turn", async () => {
    const s = await setup();
    await s.children.message(s.from, "parent", "Beds planned.");
    expect(s.wakes).toEqual([]);
    s.children.ended(s.user.id, "general", s.child.id, "done");
    await s.flush();
    expect(s.wakes).toEqual([s.parent.id]);
  });

  it("a bad end wakes once until the user writes in the child", async () => {
    const s = await setup();
    const fail = async () => {
      await s.children.message(s.parentFrom, s.child.id, "Try the task.");
      s.busy.delete(s.child.id);
      s.children.ended(s.user.id, "general", s.child.id, "error");
      await s.flush();
    };
    await fail();
    expect(s.wakes).toHaveLength(1);
    s.end();
    await fail();
    expect(s.wakes).toHaveLength(1);
    expect(s.notices).toHaveLength(1);
    s.children.userWrote(s.user.id, "general", s.child.id);
    await fail();
    expect(s.wakes).toHaveLength(2);
  });

  it("a queued child that did not start before restart wakes its parent", async () => {
    const s = await setup();
    const db = s.users.openUserDb(s.user.id);
    try { db.prepare("UPDATE child_threads SET queued = 1 WHERE thread = ?").run(s.child.id); }
    finally { db.close(); }
    s.children.recover(s.user.id);
    await s.flush();
    expect(s.notices[0]).toContain("didn't start");
    expect(s.wakes).toEqual([s.parent.id]);
    s.children.recover(s.user.id);
    expect(s.notices).toHaveLength(1);
  });

  it("a woken parent's answer starts the child, for a few rounds until the person writes", async () => {
    const s = await setup();
    const round = async (n: number) => {
      await s.children.message(s.from, "parent", `Question ${n}?`, { question: true });
      await s.flush();
      const d = await s.children.message(s.parentFrom, s.child.id, `Answer ${n}.`);
      s.busy.delete(s.child.id);
      s.children.turn(s.user.id, "general", s.child.id, false);
      s.end();
      return d;
    };
    for (let n = 1; n <= MAX_WAKE_ROUNDS; n++) expect(await round(n)).toBe("started");
    expect(await round(MAX_WAKE_ROUNDS + 1)).toBe("saved");
    expect(s.replies).toEqual([`Answer ${MAX_WAKE_ROUNDS + 1}.`]);
    s.children.userWrote(s.user.id, "general", s.parent.id);
    expect(await round(MAX_WAKE_ROUNDS + 2)).toBe("started");
    expect(s.sends).toHaveLength(MAX_WAKE_ROUNDS + 1);
  });

  it("waits while the daemon drains, then starts one pending wake", async () => {
    const s = await setup();
    s.host.draining = true;
    await s.children.message(s.from, "parent", "Which flowers?", { question: true });
    expect(s.wakes).toEqual([]);
    s.host.draining = false;
    s.children.drainWakes();
    await s.flush();
    expect(s.wakes).toEqual([s.parent.id]);
  });

});
