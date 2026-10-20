import { describe, expect, it } from "vitest";
import { fakeOpenAI } from "../../core/test/fake-openai.ts";
import type { NotificationPage, SkillInfo, Skills, ThreadSummary } from "../src/api.ts";
import { browser, daemon, enc, localModel, login, runtime } from "./helpers.ts";

const draft = { name: "render-check", description: "Before saying a scene renders.", body: "1. Take a screenshot.\n2. Look at it." };

async function setup(pool: "general" | "private" = "general") {
  const rt = await runtime();
  const dm = await daemon(rt);
  await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
  const ada = await login(dm.base, "ada", "pw");
  const model = await fakeOpenAI({ label: "local", models: [{ id: "qwen3.8-27b" }] });
  await localModel(ada, rt.ada.id, model.baseUrl);
  const u = `/api/u/${rt.ada.id}`;
  const thread = (await ada.post<ThreadSummary>(`${u}/threads`, { pool })).body;
  const path = `${u}/threads/${pool}/${enc(thread.id)}`;
  const stream = ada.events(`${path}/events`);
  await stream.ready;
  /** She saves the draft with save_skill, then says so. */
  const save = async () => {
    const from = stream.events.length;
    model.reply({ tools: [{ id: "call_skill", name: "save_skill", args: draft }] });
    model.reply({ text: "Saved it." });
    expect((await ada.post(`${path}/messages`, { text: "Remember how you checked that." })).status).toBe(200);
    await stream.until((e) => e.type === "turn_end", from);
  };
  /** One more turn: what her prompt carried. */
  const prompt = async () => {
    const from = stream.events.length;
    model.reply({ text: "Hello." });
    await ada.post(`${path}/messages`, { text: "hi" });
    await stream.until((e) => e.type === "turn_end", from);
    return JSON.stringify(model.requests.at(-1)!.messages);
  };
  return { ...dm, rt, ada, model, u, path, stream, save, prompt, thread };
}

describe("skills", () => {
  it("wait for the person's approval when she saves one, then show in every thread's prompt", async () => {
    const s = await setup();
    await s.save();
    const page = (await s.ada.get<Skills>(`${s.u}/skills`)).body;
    expect(page).toMatchObject({ autoApprove: false, skills: [{ ...draft, pool: "general", state: "waiting", author: "lyrica", thread: s.thread.id, call: "call_skill" }] });
    expect(await s.prompt()).not.toContain('<skill name=\\"render-check\\"');

    const notifications = (await s.ada.get<NotificationPage>(`${s.u}/notifications`)).body.items.filter((n) => n.id.startsWith("skill:"));
    expect(notifications).toEqual([expect.objectContaining({ type: "suggestion", title: "A new skill: render-check", decision: true, section: "settings/skills" })]);
    expect(notifications[0]!.actions.map((a) => a.label)).toEqual(["Approve", "Decline"]);
    expect((await s.ada.post(notifications[0]!.actions[0]!.path)).status).toBe(200);
    expect((await s.ada.post(notifications[0]!.actions[0]!.path)).status).toBe(404);

    expect(await s.prompt()).toContain('<skill name=\\"render-check\\" read=\\"s:render-check\\">Before saying a scene renders.</skill>');
    expect((await s.ada.get<NotificationPage>(`${s.u}/notifications`)).body.items.filter((n) => n.id.startsWith("skill:"))).toEqual([]);
    s.stream.close();
  });

  it("are the person's at once, refuse what doesn't fit, and make hers active at once with auto-approve", async () => {
    const s = await setup();
    const mine = await s.ada.post<SkillInfo>(`${s.u}/skills`, { name: "release", description: "When cutting a release.", body: "Tag it." });
    expect(mine.body).toMatchObject({ name: "release", state: "active", author: "user", pool: "general" });
    expect((await s.ada.post(`${s.u}/skills`, { name: "Release Notes", description: "x", body: "y" })).status).toBe(400);
    expect((await s.ada.put<Skills>(`${s.u}/skills/auto-approve`, { autoApprove: true })).body.autoApprove).toBe(true);
    await s.save();
    const page = (await s.ada.get<Skills>(`${s.u}/skills`)).body;
    expect(page.skills.map((k) => [k.name, k.state])).toEqual([["release", "active"], ["render-check", "active"]]);
    expect((await s.ada.del<Skills>(`${s.u}/skills/general/release`)).body.skills.map((k) => k.name)).toEqual(["render-check"]);
    expect((await s.ada.post(`${s.u}/skills/elsewhere/render-check/approve`)).status).toBe(404);
    s.stream.close();
  });

  it("keep a Private thread's skill in the Private pool: out of General threads, and out of Settings while the display hides Private", async () => {
    const s = await setup("private");
    await s.ada.put(`${s.u}/skills/auto-approve`, { autoApprove: true });
    await s.save();
    expect((await s.ada.get<Skills>(`${s.u}/skills`)).body.skills).toEqual([expect.objectContaining({ name: "render-check", pool: "private", state: "active" })]);
    expect(await s.prompt()).toContain("render-check");
    const general = (await s.ada.post<ThreadSummary>(`${s.u}/threads`, { pool: "general" })).body;
    const gpath = `${s.u}/threads/general/${enc(general.id)}`;
    const stream = s.ada.events(`${gpath}/events`);
    await stream.ready;
    s.model.reply({ text: "Hello." });
    await s.ada.post(`${gpath}/messages`, { text: "hi" });
    await stream.until((e) => e.type === "turn_end", 0);
    expect(JSON.stringify(s.model.requests.at(-1)!.messages)).not.toContain("render-check");
    stream.close();

    await s.ada.patch(`${s.u}/me/display`, { showPrivate: false });
    expect((await s.ada.get<Skills>(`${s.u}/skills`)).body.skills).toEqual([]);
    expect((await s.ada.del(`${s.u}/skills/private/render-check`)).status).toBe(404);
    s.stream.close();
  });
});
