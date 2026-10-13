import { Memory, Models, Users, Workspace, type Pool } from "@lyrica/core";
import type { Delegation, ThreadContext } from "@lyrica/extension";
import { afterEach, describe, expect, it } from "vitest";
import { freshKeyring, profile } from "../../core/test/helpers.ts";
import { ChildThreads } from "../src/children.ts";
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
  const host = {
    busy: (_u: string, _p: Pool, t: string) => busy.has(t),
    changed: () => {}, delivered: () => {},
    get: (_u: string, _p: Pool, t: string) => ({ send: async () => { busy.add(t); return { queued: false }; }, wakeChild: async () => { busy.add(t); wakes.push(t); } }),
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
  return { children, parentFrom, users, user, parent, child, from, busy, wakes, notices, flush, end, pause: (p: boolean) => { paused = p; } };
}

describe("child wake guards", () => {
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

  it("waits for the concurrency slot and coalesces pending questions", async () => {
    const s = await setup();
    s.busy.add(s.child.id);
    await s.children.message(s.from, "parent", "First?", { question: true });
    await s.children.message(s.from, "parent", "Second?", { question: true });
    expect(s.wakes).toEqual([]);
    s.busy.delete(s.child.id);
    s.children.turn(s.user.id, "general", s.child.id, false);
    s.children.ended(s.user.id, "general", s.child.id, "done");
    await s.flush();
    expect(s.wakes).toEqual([s.parent.id]);
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

});
