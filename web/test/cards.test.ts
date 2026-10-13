import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModelsPage, NotificationPage, SleepOverview } from "../src/api.ts";
import type { ShellContext } from "../src/Shell.tsx";
import { ComposerRow } from "../src/Composer.tsx";
import { NotificationsCard } from "../src/Notifications.tsx";
import { SleepCard } from "../src/Sleep.tsx";
import { BackendCard } from "../src/Models.tsx";
import { useLoad } from "../src/ui.tsx";

vi.mock("../src/ui.tsx", async (original) => ({ ...await original<typeof import("../src/ui.tsx")>(), useLoad: vi.fn() }));

const ctx = {
  user: { id: "user", displayName: "the user", pronouns: "they" },
  me: { display: { showGeneral: true, showPrivate: true } },
  cleanup: { count: 0, reload: vi.fn() },
  sleep: { overview: { items: [], runs: [] }, error: "", reload: vi.fn(), set: vi.fn() },
} as unknown as ShellContext;
const loaded = (data: unknown) => ({ data, error: "", reload: vi.fn(), set: vi.fn() });
beforeEach(() => { vi.mocked(useLoad).mockReset(); });

describe("welcome cards", () => {
  it("renders Notifications and its All link with zero items", () => {
    const page: NotificationPage = { items: [], total: 0, waiting: 0, types: [] };
    vi.mocked(useLoad).mockReturnValue(loaded(page));
    const html = renderToStaticMarkup(createElement(NotificationsCard, { ctx }));
    expect(html).toContain('class="card"');
    expect(html).toContain("Notifications</h2>");
    expect(html).toContain("Nothing waiting.");
    expect(html).toContain('href="#/u/user/notifications">All 0</a>');
  });

  it("shows the last sleep time in mono, or only the empty sentence before any run", () => {
    expect(renderToStaticMarkup(createElement(SleepCard, { ctx }))).toContain("Nothing she wants to raise.</p>");
    const startedAt = "2026-10-12T04:00:00Z";
    const overview = { items: [], runs: [{ pool: "general", status: "complete", startedAt }] } as unknown as SleepOverview;
    const html = renderToStaticMarkup(createElement(SleepCard, { ctx: { ...ctx, sleep: { ...ctx.sleep, overview } } }));
    expect(html).toContain('href="#/u/user/sleep">Sleep</a>');
    expect(html).toContain('She slept at <span class="num"');
    expect(html).toContain(new Date(startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  });

  it("shows private locks and both actions, leaving out old items and hidden pools", () => {
    const overview = { runs: [], items: [
      { pool: "private", id: "private-item", new: true, text: "A garden question" },
      { pool: "general", id: "old-item", new: false, text: "An old question" },
    ] } as unknown as SleepOverview;
    const cardCtx = { ...ctx, sleep: { ...ctx.sleep, overview } };
    const html = renderToStaticMarkup(createElement(SleepCard, { ctx: cardCtx }));
    expect(html).toContain("A garden question");
    expect(html).toContain('title="Private"');
    expect(html).toContain("Start a chat</button>");
    expect(html).toContain("Dismiss</button>");
    expect(html).not.toContain("An old question");
    const hiddenCtx = { ...cardCtx, me: { ...ctx.me, display: { ...ctx.me.display, showPrivate: false } } };
    expect(renderToStaticMarkup(createElement(SleepCard, { ctx: hiddenCtx }))).not.toContain("A garden question");
  });

  it("shows pool models, kinds, presets and host states from Models data", () => {
    const local = { id: "builtin.local", name: "Local", scope: "private", builtin: "local", entries: { chat: [{ offeringId: "local" }] }, updatedAt: "2026-10-12T00:00:00Z" };
    const page = {
      presets: {
        presets: [
          local,
          { id: "builtin.cloud", name: "Cloud", scope: "general", builtin: "cloud", entries: {}, updatedAt: "2026-10-12T00:00:00Z" },
        ],
        columns: {
          private: { column: "private", preset: local, fromPreset: null, entries: {} },
          general: { column: "general", preset: null, fromPreset: null, entries: { chat: { same: "compaction" }, compaction: [{ groupId: "group" }] } },
        },
        thinking: "off", fallback: true, sleepFallback: true, readAloudLive: false,
      },
      endpoints: [
        { id: "cloud-ep", name: "Cloud host", kind: "cloud", models: [{ id: "cloud", modelId: "cloud-model" }], state: "up" },
        { id: "local-ep", name: "Local host", kind: "local", api: "host", models: [{ id: "local", modelId: "local-model" }], state: "up" },
      ],
      hosts: [{ endpointId: "local-ep", status: { state: "paused" } }],
    } as unknown as ModelsPage;
    vi.mocked(useLoad).mockReturnValueOnce(loaded(page)).mockReturnValueOnce(loaded([{ id: "group", members: ["cloud"] }]));
    const html = renderToStaticMarkup(createElement(BackendCard, { ctx }));
    expect(html).toContain('href="#/u/user/models">Models</a>');
    expect(html).toContain('class="facts"');
    expect(html).toContain('class="badge kind cloud">cloud</span> cloud-model · Cloud host · Custom');
    expect(html).toContain('class="badge kind local">local</span> local-model · Local host · Local');
    expect(html).toContain('class="dot away"');
    expect(html).toContain("Paused");
  });
});

it("the shared home row has tools and dictation without Mode or Thinking", () => {
  const html = renderToStaticMarkup(createElement(ComposerRow, {
    onSettings: vi.fn(), onAttach: vi.fn(),
    mic: { state: "idle", seconds: 0, onStart: vi.fn(), onStop: vi.fn() },
    children: createElement("div", { className: "seg" }, "General / Private"),
  }));
  expect(html).toContain('aria-label="Attach or switch tools"');
  expect(html).toContain('type="file"');
  expect(html).toContain('aria-label="Dictate"');
  expect(html).toContain("General / Private");
  expect(html).not.toContain("mode-picker");
  expect(html).not.toContain("Thinking");
});
