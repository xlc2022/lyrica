import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { PushStore, type PushSettings } from "@lyrica/core";
import { PUSH_PHRASES, Push, postPush, pushBody, pushTarget } from "../src/push.ts";
import { browser, daemon, login, runtime } from "./helpers.ts";
import type { PushInfo } from "../src/api.ts";

const settings = { url: "https://receiver.example/secret-topic", token: "private-token", link: false, origin: "https://app.example" };
const resolve = (address: string) => async () => ({ addresses: [address], outside: true });
afterEach(() => vi.restoreAllMocks());

it("uses every fixed phrase, counts and an unknown-type fallback", () => {
  expect(Object.values(PUSH_PHRASES)).toEqual([
    "A question is waiting.", "A permission is waiting.", "A share is waiting.",
    "A suggested persona change is waiting.", "A persona change waits for approval.", "A thread is waiting on you.",
  ]);
  for (const [type, phrase] of Object.entries(PUSH_PHRASES)) expect(pushBody([type])).toBe(phrase);
  expect(pushBody(["future"])).toBe("Something is waiting.");
  expect(pushBody(["question", "share"])).toBe("2 things are waiting.");
});

it("checks schemes, roles, mixed DNS, loopback, mapped IPv4 and link-local on every resolution", async () => {
  for (const scheme of ["http", "https"]) for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "169.254.1.1", "fe80::1"]) {
    await expect(pushTarget(`${scheme}://receiver.example/topic`, true, resolve(ip))).rejects.toThrow();
  }
  await expect(pushTarget("http://receiver.example/topic", true, resolve("8.8.8.8"))).rejects.toThrow();
  await expect(pushTarget("http://receiver.example/topic", false, resolve("10.20.30.40"))).rejects.toThrow();
  await expect(pushTarget(settings.url, false, resolve("10.20.30.40"))).rejects.toThrow();
  await expect(pushTarget(settings.url, false, resolve("8.8.8.8"))).resolves.toBeDefined();
  await expect(pushTarget("http://receiver.example/topic", true, resolve("10.20.30.40"))).resolves.toBeDefined();
  await expect(pushTarget(settings.url, false, async () => ({ addresses: ["8.8.8.8", "127.0.0.1"], outside: true }))).rejects.toThrow();
  await expect(pushTarget(settings.url, true, resolve("8.8.8.8"), ["receiver.example"])).rejects.toThrow();
  await expect(pushTarget(settings.url, true, resolve("8.8.8.8"), ["front-door.example"])).rejects.toThrow();
});

it("posts only fixed text and opt-in headers to a local fake receiver, without redirects", async () => {
  const received: { body: string; headers: import("node:http").IncomingHttpHeaders }[] = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    received.push({ body, headers: req.headers });
    res.writeHead(302, { Location: "https://unused.example" }); res.end();
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as import("node:net").AddressInfo).port;
    // Test transport directly: production validation deliberately refuses this loopback receiver.
    const target = { url: new URL(`http://receiver.example:${port}/secret-topic`), addresses: ["127.0.0.1"] };
    expect((await postPush(target, settings, "Test from Lyrica.")).status).toBe(302);
    await postPush(target, { ...settings, link: true }, pushBody(["question"]));
    expect(received).toHaveLength(2);
    expect(received[0]!.headers).toMatchObject({ title: "Lyrica", tags: "bell", authorization: "Bearer private-token" });
    expect(received[0]!.headers.click).toBeUndefined();
    expect(received[1]!.headers.click).toBe("https://app.example/notifications");
    expect(received[1]!.body).toBe("A question is waiting.");
  } finally { await new Promise<void>(r => server.close(() => r())); }
});

async function setup() {
  const rt = await runtime(), dm = await daemon(rt);
  await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
  const ada = await login(dm.base, "ada", "pw");
  const store = <T>(fn: (s: PushStore) => T) => { const db = dm.d.services!.users.openUserDb(rt.ada.id); try { return fn(new PushStore(db)); } finally { db.close(); } };
  const transport = vi.fn(async (_target: Awaited<ReturnType<typeof pushTarget>>, _settings: PushSettings, _body: string) => ({ status: 200, reason: "Sent" }));
  const target = vi.fn(async (url: string) => ({ url: new URL(url), addresses: ["8.8.8.8"] }));
  const push = new Push(dm.d, transport, target, async () => {});
  return { ...dm, rt, ada, store, push, transport, target };
}

it("batches only visible non-sleep decisions, remembers IDs in a fresh sender, and sends new asks after the gap", async () => {
  const s = await setup();
  const view = s.d.services!.memory.openOwnerView(s.rt.ada.id);
  const unique = "uniquely-secret-question-words";
  const add = (id: string, hidden = false) => {
    const th = view.general.createThread({ interface: "web", title: unique });
    if (hidden) view.general.setHidden(th.id, true);
    view.general.appendEntry(th.id, { piId: id, role: "assistant", text: "", data: { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name: "threads", arguments: { action: "ask", question: unique, options: [{ label: "One", consequence: unique }, { label: "Two", consequence: unique }], recommended: 0 } }] } } });
    view.general.askQuestion(th.id, view.general.questionCall(th.id, id)!);
    return th;
  };
  try {
    const first = add("first"); add("hidden", true);
    const run = view.general.startSleepRun("manual", new Date().toISOString());
    view.general.addItem(run, { kind: "question", text: unique });
    const privateThread = view.private.createThread({ interface: "web", title: unique });
    view.private.appendEntry(privateThread.id, { piId: "private", role: "assistant", text: "", data: { type: "message", message: { content: [{ type: "toolCall", id: "private", name: "threads", arguments: { action: "ask", question: unique, options: [{ label: "One", consequence: unique }, { label: "Two", consequence: unique }], recommended: 0 } }] } } });
    view.private.askQuestion(privateThread.id, view.private.questionCall(privateThread.id, "private")!);
    const displayDb = s.d.services!.users.openUserDb(s.rt.ada.id);
    displayDb.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('display', ?)").run(JSON.stringify({ showPrivate: false }));
    displayDb.close();
    s.store(st => st.save(settings));
    const now = Date.now();
    await s.push.check(s.rt.ada, false, now);
    add("second");
    await s.push.check(s.rt.ada, false, now + 30_000);
    expect(s.transport).toHaveBeenCalledTimes(1);
    expect(s.transport.mock.calls[0]?.[2]).toBe("2 things are waiting.");
    expect(JSON.stringify(s.transport.mock.calls)).not.toContain(unique);
    const again = new Push(s.d, s.transport, s.target);
    await again.check(s.rt.ada, true, now + 90_000);
    expect(s.transport).toHaveBeenCalledTimes(1);
    view.general.closeQuestion(first.id, "words");
    await again.check(s.rt.ada, false, now + 100_000);
    add("third");
    await again.check(s.rt.ada, true, now + 110_000);
    expect(s.transport).toHaveBeenCalledTimes(2);
    await again.check(s.rt.ada, true, now + 120_000);
    expect(s.transport).toHaveBeenCalledTimes(2);
  } finally { view.close(); }
});

it("persists failures, rechecks DNS on retries, and skips a locked user", async () => {
  const s = await setup();
  s.store(st => st.save(settings));
  s.transport.mockResolvedValue({ status: 403, reason: "Refused" });
  await s.push.send(s.rt.ada, settings, "Test from Lyrica.");
  expect(s.transport).toHaveBeenCalledTimes(3);
  expect(s.target).toHaveBeenCalledTimes(3);
  expect(s.store(st => st.failure()?.status)).toBe(403);
  s.target.mockRejectedValue(new Error("DNS changed"));
  await s.push.send(s.rt.ada, settings, "Test from Lyrica.");
  expect(s.transport).toHaveBeenCalledTimes(3);
  expect(s.logs.join(" ")).not.toContain("secret-topic");
  s.d.keyring.lockUser(s.rt.ada.id);
  await s.push.check(s.rt.ada, true);
  expect(s.transport).toHaveBeenCalledTimes(3);
});

it("authenticates routes, masks saved secrets, sends tests, reports failure and turns off", async () => {
  const s = await setup(), path = `/api/u/${s.rt.ada.id}/push`;
  const send = vi.spyOn(s.d.push, "send").mockImplementation((user, saved, body) => s.push.send(user, saved, body));
  // Literal public address avoids external DNS; the send itself is an in-memory fake.
  expect((await s.ada.put(path, { ...settings, url: "https://8.8.8.8/private-topic" })).status).toBe(200);
  const info = (await s.ada.get<PushInfo>(path)).body;
  expect(info).toEqual({ host: "8.8.8.8", path: "/•••", set: true, token: true, link: false });
  expect(JSON.stringify(info)).not.toContain("private-token");
  expect((await browser(s.base).get(path)).status).toBe(401);
  expect((await s.ada.post(path + "/test")).status).toBe(204);
  expect(send.mock.calls.at(-1)?.[2]).toBe("Test from Lyrica.");
  s.transport.mockResolvedValue({ status: 403, reason: "Refused" });
  expect(await s.ada.post(path + "/test")).toMatchObject({ status: 502, body: { status: 403, reason: "Refused" } });
  expect((await s.ada.get<PushInfo>(path)).body.lastFailure).toMatchObject({ at: expect.any(String), status: 403 });
  s.transport.mockResolvedValue({ status: 200, reason: "Sent" });
  expect((await s.ada.post(path + "/test")).status).toBe(204);
  expect((await s.ada.get<PushInfo>(path)).body.lastFailure).toBeUndefined();
  for (const url of ["http://8.8.8.8/topic", "https://127.0.0.1/topic", "https://169.254.1.2/topic"]) expect((await s.ada.put(path, { ...settings, url })).status).toBe(400);
  expect((await s.ada.del(path)).status).toBe(204);
  expect((await s.ada.get<PushInfo>(path)).body.set).toBe(false);
  const sam = await login(s.base, "sam", "pw2");
  for (const url of ["http://10.20.30.40/topic", "https://10.20.30.40/topic"]) expect((await sam.put(`/api/u/${s.rt.sam.id}/push`, { ...settings, url })).status).toBe(400);
  expect((await sam.get(path)).status).toBe(401);

});

it("first enable sends existing decisions once, survives a real restart, and catches new asks on unlock", async () => {
  const s = await setup();
  const send = vi.spyOn(s.d.push, "send").mockResolvedValue({ status: 200, reason: "Sent" });
  const share = () => s.d.services!.shares.send({ from: s.rt.sam.id, to: s.rt.ada.id, pool: "general", unlogged: false, localOnly: false, entries: [], title: "secret-share-title" });
  share(); share();
  const path = `/api/u/${s.rt.ada.id}/push`;
  expect((await s.ada.put(path, { ...settings, url: "https://8.8.8.8/topic" })).status).toBe(200);
  // Save doesn't wait for the first-enable push; it lands just after.
  await expect.poll(() => send.mock.calls.length).toBe(1);
  await new Promise(r => setImmediate(r));
  expect(send.mock.calls[0]?.[2]).toBe("2 things are waiting.");
  await s.d.push.check(s.rt.ada, true, Date.now() + 60_000);
  expect(send).toHaveBeenCalledTimes(1);
  await s.stop();
  const again = await daemon(s.rt);
  const restarted = vi.spyOn(again.d.push, "send").mockResolvedValue({ status: 200, reason: "Sent" });
  await browser(again.base).post("/api/unlock", { passphrase: "passphrase" });
  const ada = await login(again.base, "ada", "pw");
  await again.d.push.check(s.rt.ada, true, Date.now() + 60_000);
  expect(restarted).not.toHaveBeenCalled();
  await ada.post(`/api/u/${s.rt.ada.id}/lock`);
  again.d.services!.shares.send({ from: s.rt.sam.id, to: s.rt.ada.id, pool: "general", unlogged: false, localOnly: false, entries: [] });
  again.d.push.tick(true);
  expect(restarted).not.toHaveBeenCalled();
  // Advance the durable rate limiter without waiting a minute on the shared test host.
  await again.d.services!.users.authenticate("ada", "pw");
  const db = again.d.services!.users.openUserDb(s.rt.ada.id);
  new PushStore(db).attempted(Date.now() - 60_001); db.close();
  again.d.keyring.lockUser(s.rt.ada.id);
  await login(again.base, "ada", "pw");
  await expect.poll(() => restarted.mock.calls.length).toBe(1);
  expect(restarted.mock.calls[0]?.[2]).toBe("A share is waiting.");
});

it("pushes the same Waiting on you ID again after it clears", async () => {
  const s = await setup(), view = s.d.services!.memory.openOwnerView(s.rt.ada.id);
  try {
    const th = view.general.createThread({ interface: "web", title: "secret-title" });
    const updates = vi.spyOn(s.d.services!.children, "updates");
    const item = { pool: "general" as const, thread: th.id, parent: "project", unseen: 0, needsYou: true };
    updates.mockReturnValue([item]);
    s.store(st => st.save(settings));
    const now = Date.now();
    await s.push.check(s.rt.ada, true, now);
    expect(s.transport.mock.calls.at(-1)?.[2]).toBe("A thread is waiting on you.");
    updates.mockReturnValue([]);
    await s.push.check(s.rt.ada, false, now + 10_000);
    updates.mockReturnValue([item]);
    await s.push.check(s.rt.ada, false, now + 20_000);
    await s.push.check(s.rt.ada, false, now + 50_000);
    expect(s.transport).toHaveBeenCalledTimes(1);
    await s.push.check(s.rt.ada, false, now + 60_000);
    expect(s.transport).toHaveBeenCalledTimes(2);
  } finally { view.close(); }
});
