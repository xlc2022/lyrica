import { describe, expect, it, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QuestionCard, ProjectQuestion, loadProjectQuestion } from "../src/Question.tsx";
import { NotificationsCard, sharedActions } from "../src/Notifications.tsx";
import { useLoad } from "../src/ui.tsx";
import type { ShellContext } from "../src/Shell.tsx";
import { get } from "../src/api.ts";
import type { Notification, NotificationPage, QuestionState } from "../src/api.ts";

vi.mock("../src/api.ts", async original => ({ ...await original<typeof import("../src/api.ts")>(), get: vi.fn() }));
vi.mock("../src/ui.tsx", async original => ({ ...await original<typeof import("../src/ui.tsx")>(), useLoad: vi.fn() }));
const args = { question: "Which format?", context: "The draft is ready.", recommended: 1, options: [
  { label: "Page", consequence: "Keep it editable." }, { label: "PDF", consequence: "Ready to print." },
] };
const state: QuestionState = { n: 12, asked: "2026-10-18T12:00:00Z" };
const card = (s?: QuestionState) => renderToStaticMarkup(createElement(QuestionCard, { args, state: s, base: "/thread", onChange: vi.fn() }));
const loaded = (data: unknown) => ({ data, error: "", reload: vi.fn(), set: vi.fn() });
const notification: Notification = { id: "question:private/thread/12", type: "question", title: args.question, detail: "Ready to print.", decision: true, scope: "private", at: state.asked, thread: { pool: "private", id: "thread" }, actions: [
  { label: "PDF", method: "POST", path: "/thread/questions/12/answer", body: { option: 1 } },
  { label: "Page", method: "POST", path: "/thread/questions/12/answer", body: { option: 0 } },
] };
const ctx = { user: { id: "user" }, refreshThreads: vi.fn(), refreshNotifications: vi.fn() } as unknown as ShellContext;
beforeEach(() => { vi.mocked(useLoad).mockReset(); vi.mocked(get).mockReset(); });

describe("question cards", () => {
  it("shows context, consequences and exactly one recommended primary answer", () => {
    const html = card(state);
    expect(html).toContain('data-pending="Question"');
    expect(html).toContain(args.context);
    for (const o of args.options) expect(html).toContain(o.consequence);
    expect(html.match(/class="primary"/g)).toHaveLength(1);
    expect(html).toContain('PDF<span class="question-recommended">Recommended');
    expect(html).not.toContain("disabled");
  });
  it("disables answers until the stored question pointer arrives", () => {
    expect(card().match(/disabled=""/g)).toHaveLength(2);
    expect(card()).not.toContain("data-pending");
  });
  it.each([[1, "PDF"], ["words", "Answered in words."], ["withdrawn", "Withdrawn."]] as const)("collapses %s without active controls", (answer, label) => {
    const html = card({ ...state, closed: state.asked, answer });
    expect(html).toContain(args.question);
    expect(html).toContain(label);
    expect(html).not.toContain("<button");
    expect(html).not.toContain("data-pending");
    expect(html).not.toContain(args.context);
    if (typeof answer === "number") expect(html).toContain("<svg");
  });
  it("uses the same question and controls on the project card", () => {
    vi.mocked(useLoad).mockReturnValue(loaded({ args, state }));
    const html = renderToStaticMarkup(createElement(ProjectQuestion, { base: "/thread", n: 12, onChange: vi.fn() }));
    expect(html).toContain(args.question);
    expect(html).toContain('data-pending="Question"');
    expect(html).toContain("Ready to print.");
  });
  it("finds an older project question using its original option indexes and current state", async () => {
    vi.mocked(get).mockResolvedValueOnce({ messages: [{ n: 40, parts: [] }], hasMore: true, questions: [state] })
      .mockResolvedValueOnce({ messages: [{ n: 12, parts: [{ type: "tool", name: "threads", toolCallId: "ask", args: { ...args, action: "ask" } }] }], hasMore: false });
    const result = await loadProjectQuestion("/private/thread", 12);
    expect(result).toEqual({ args: { ...args, action: "ask" }, state });
    expect(vi.mocked(get).mock.calls).toEqual([["/private/thread/messages"], ["/private/thread/messages?before=40"]]);
  });
  it("offers no project answers when the question call is no longer readable", async () => {
    vi.mocked(get).mockResolvedValue({ messages: [], hasMore: false, questions: [state] });
    expect(await loadProjectQuestion("/thread", 12)).toBeUndefined();
  });
  it("never bulk answers matching question options or mixed selections", () => {
    expect(sharedActions([notification, { ...notification, id: "another-question" }])).toEqual([]);
    const ordinary: Notification = { ...notification, id: "share", type: "share" };
    expect(sharedActions([ordinary, notification])).toEqual([]);
    expect(sharedActions([ordinary, { ...ordinary, id: "other-share" }])).toEqual(ordinary.actions);
  });
  it("shows private decisions and recommended-first actions on the welcome card", () => {
    const page: NotificationPage = { items: [notification], total: 1, waiting: 1, types: ["question"] };
    vi.mocked(useLoad).mockReturnValue(loaded(page));
    const html = renderToStaticMarkup(createElement(NotificationsCard, { ctx }));
    expect(html).toContain(args.question);
    expect(html).toContain("Ready to print.");
    expect(html).toContain('class="k private"');
    expect(html.indexOf('>PDF')).toBeLessThan(html.indexOf('>Page'));
    expect(html.indexOf('>Page')).toBeLessThan(html.indexOf('>Open thread'));
    expect(html).toContain('class="sm primary"');
  });
});
