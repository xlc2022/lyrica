import { describe, expect, it } from "vitest";
import { cleanAsk, Memory, Users } from "../src/index.ts";
import { freshKeyring, profile } from "./helpers.ts";

const ask = { question: "Which path?", options: [{ label: "Small", consequence: "A quick change." }, { label: "Large", consequence: "A wider change." }], recommended: 0 };

describe("question cards", () => {
  it("validates every bound, unique labels and the recommendation structurally", () => {
    for (const count of [2, 4]) expect(cleanAsk({ ...ask, options: Array.from({ length: count }, (_, i) => ({ label: `${i}`, consequence: "Outcome" })) }).options).toHaveLength(count);
    for (const value of [null, {}, { ...ask, question: "" }, { ...ask, question: "x".repeat(301) }, { ...ask, context: "x".repeat(1201) }, { ...ask, options: [] }, { ...ask, options: [ask.options[0]] }, { ...ask, options: Array(5).fill(ask.options[0]) }, ...["", "x".repeat(41)].map(label => ({ ...ask, options: [{ label, consequence: "Fine" }, ask.options[1]] })), ...["", "x".repeat(201)].map(consequence => ({ ...ask, options: [{ label: "Small", consequence }, ask.options[1]] })), { ...ask, options: [ask.options[0], { ...ask.options[1], label: "SMALL" }] }, ...[-1, 2, 0.5, "0"].map(recommended => ({ ...ask, recommended }))]) expect(() => cleanAsk(value)).toThrow(Error);
    expect(cleanAsk({ ...ask, question: "x".repeat(300), context: "x".repeat(1200), options: [{ label: "x".repeat(40), consequence: "x".repeat(200) }, ask.options[1]] })).toBeDefined();
  });

  it("stores only pointers, withdraws replacements, and clears the child flag in the closing transaction", async () => {
    const keyring = await freshKeyring();
    const users = new Users(keyring);
    const user = await users.createUser("ada", "pw", profile("Ada"), { admin: true });
    await users.authenticate("ada", "pw");
    const view = new Memory(keyring, users).openThreadView(user.id, "private");
    const parent = view.own.createThread({ interface: "web", project: true });
    const child = view.own.createThread({ interface: "web", parent: parent.id, child: true });
    const db = users.openUserDb(user.id);
    db.prepare("INSERT INTO child_threads (pool, thread, parent, started_at) VALUES ('private', ?, ?, '2026-01-01')").run(child.id, parent.id);
    const put = (id: string) => {
      const n = view.own.nextEntryN(child.id);
      view.own.appendEntry(child.id, { piId: id, role: "assistant", text: "", data: { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name: "threads", arguments: { action: "ask", ...ask } }] } } });
      view.own.askQuestion(child.id, n);
      return n;
    };
    const first = put("one");
    const second = put("two");
    expect(view.own.questions(child.id)[0]).toMatchObject({ n: first, answer: "withdrawn" });
    expect(db.prepare("SELECT needs_you FROM child_threads").get()).toEqual({ needs_you: 1 });
    db.exec("CREATE TRIGGER hold_question BEFORE UPDATE OF needs_you ON child_threads WHEN NEW.needs_you = 0 BEGIN SELECT RAISE(ABORT, 'synthetic refusal'); END");
    expect(() => view.own.closeQuestion(child.id, 1, second)).toThrow("synthetic refusal");
    expect(view.own.openQuestion(child.id)?.n).toBe(second);
    expect(db.prepare("SELECT needs_you FROM child_threads").get()).toEqual({ needs_you: 1 });
    db.exec("DROP TRIGGER hold_question");
    expect(view.own.closeQuestion(child.id, 1, second)).toBe(true);
    expect(db.prepare("SELECT needs_you FROM child_threads").get()).toEqual({ needs_you: 0 });
    expect(view.own.closeQuestion(child.id, 0, second)).toBe(false);
    expect(view.own.readAsk(child.id, second)).toEqual(ask);
    db.close(); view.close();
  });
});
