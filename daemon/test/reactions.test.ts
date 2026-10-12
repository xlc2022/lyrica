// Reactions (DESIGN.md, Threads): the user's on any message, hers through the
// `react` tool, both shown as one set of chips and told to every open tab.
import { describe, expect, it } from "vitest";
import { fakeOpenAI } from "../../core/test/fake-openai.ts";
import type { MessagePage, Reactions, ThreadEvent, ThreadSummary } from "../src/api.ts";
import { browser, daemon, enc, localModel, login, runtime } from "./helpers.ts";

async function setup() {
  const rt = await runtime();
  const dm = await daemon(rt);
  await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
  const li = await login(dm.base, "li", "pw");
  const model = await fakeOpenAI({ label: "local", models: [{ id: "qwen3.8-27b" }] });
  await localModel(li, rt.li.id, model.baseUrl);
  const thread = (await li.post<ThreadSummary>(`/api/u/${rt.li.id}/threads`, { pool: "general", title: "Garden" })).body;
  const path = `/api/u/${rt.li.id}/threads/general/${enc(thread.id)}`;
  const stream = li.events(`${path}/events`);
  await stream.ready;
  const say = async (text: string) => {
    const from = stream.events.length;
    expect((await li.post(`${path}/messages`, { text })).status).toBe(200);
    await stream.until((e) => e.type === "turn_end", from);
  };
  const messages = async () => (await li.get<MessagePage>(`${path}/messages`)).body.messages;
  return { rt, ...dm, li, model, path, stream, say, messages };
}

const reactionsOn = (n: number) => (e: ThreadEvent) => e.type === "reactions" && e.n === n;

describe("reactions", () => {
  it("the user's go on and off any message, every open tab hears, and she is told in her next turn", async () => {
    const { li, model, path, stream, say, messages } = await setup();
    model.reply({ text: "Tulips, in bed two." }, { text: "Noted." });
    await say("what should I plant?");
    const [question, reply] = await messages();
    const emoji = encodeURIComponent("🎉");

    let from = stream.events.length;
    expect((await li.put<Reactions>(`${path}/messages/${reply!.n}/reactions/${emoji}`, {})).body).toEqual({ reactions: [{ emoji: "🎉", you: true, her: false }] });
    await stream.until(reactionsOn(reply!.n), from);
    expect((await messages())[1]!.reactions).toEqual([{ emoji: "🎉", you: true, her: false }]);
    // Her own message too, and the same emoji twice is one reaction.
    expect((await li.put<Reactions>(`${path}/messages/${question!.n}/reactions/${encodeURIComponent("👀")}`, {})).status).toBe(200);
    expect((await li.put<Reactions>(`${path}/messages/${reply!.n}/reactions/${emoji}`, {})).body.reactions).toHaveLength(1);

    // Her next turn's message names them; the stored user message carries no mark.
    await say("thanks");
    const sent = JSON.stringify(model.requests.at(-1)!.messages);
    expect(sent).toContain(`Li reacted 🎉 to your message [e:${reply!.id.slice(2)}]`);
    expect(sent).toContain(`Li reacted 👀 to their own message [e:${question!.id.slice(2)}]`);
    expect((await messages()).at(-2)!.parts).toEqual([{ type: "text", text: "thanks" }]);
    // Taken off: the chip goes, and she hears of that too, once.
    from = stream.events.length;
    expect((await li.del<Reactions>(`${path}/messages/${reply!.n}/reactions/${emoji}`)).body).toEqual({ reactions: [] });
    await stream.until(reactionsOn(reply!.n), from);
    expect((await messages())[1]!.reactions).toBeUndefined();
    model.reply({ text: "Sure." });
    await say("ok");
    const last = JSON.stringify(model.requests.at(-1)!.messages.at(-1));
    expect(last).toContain("Li took back 🎉 from your message");
    expect(last).not.toContain("reacted 👀");
  });

  it("she reacts with her react tool, on the message she is answering, and both show as one chip", async () => {
    const { li, model, path, stream, say, messages } = await setup();
    model.reply({ tools: [{ name: "react", args: { emoji: "🎉" } }] }, { text: "Congratulations!" });
    const from = stream.events.length;
    await say("I got the job!");
    const [mine] = await messages();
    expect(stream.events.slice(from).some((e) => reactionsOn(mine!.n)(e.event))).toBe(true);
    expect(mine!.reactions).toEqual([{ emoji: "🎉", you: false, her: true }]);
    expect((await li.put<Reactions>(`${path}/messages/${mine!.n}/reactions/${encodeURIComponent("🎉")}`, {})).body).toEqual({ reactions: [{ emoji: "🎉", you: true, her: true }] });
  });

  it("refuses what isn't a message, and an emoji that isn't one", async () => {
    const { li, model, path, say, messages } = await setup();
    model.reply({ text: "A." });
    await say("one");
    const first = (await messages())[0]!;
    expect((await li.put(`${path}/messages/1/reactions/${encodeURIComponent("👍")}`, {})).status).toBe(400);
    expect((await li.put(`${path}/messages/99/reactions/${encodeURIComponent("👍")}`, {})).status).toBe(404);
    expect((await li.put(`${path}/messages/${first.n}/reactions/${encodeURIComponent("not an emoji")}`, {})).status).toBe(400);
    expect((await li.put(`${path}/messages/${first.n}/reactions/lol`, {})).status).toBe(400);
    expect((await li.put(`${path}/messages/${first.n}/reactions/${encodeURIComponent("</reactions>")}`, {})).status).toBe(400);
    for (const ok of ["👍🏽", "🇫🇷", "1️⃣", "👩‍👩‍👧"]) expect((await li.put(`${path}/messages/${first.n}/reactions/${encodeURIComponent(ok)}`, {})).status).toBe(200);
  });
});
