import { expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FoldConfirm } from "../src/FoldConfirm.tsx";
import type { ThreadSettings, ThreadSummary } from "../src/api.ts";

// The dialog's layout effects only run in a browser; its text is also visible in SSR.
vi.mock("../src/ui.tsx", async original => ({
  ...await original<typeof import("../src/ui.tsx")>(),
  Dialog: ({ children }: { children: import("react").ReactNode }) => children,
}));

it("warns that folding into a local-only project loses cloud models, without offering to restore them", () => {
  const settings = { localOnly: false, grants: [], machines: [], repositories: [], network: { hosts: [], internet: false, services: false } } as unknown as ThreadSettings;
  const thread = { id: "source", title: "Seed notes", children: [] } as unknown as ThreadSummary;
  const html = renderToStaticMarkup(createElement(FoldConfirm, {
    chosen: [{ thread, settings, index: 0 }], tree: [thread], settings: { ...settings, localOnly: true },
    base: "/fake", projectName: "Garden", onFold: vi.fn(), onDone: vi.fn(), onCancel: vi.fn(),
  }));
  expect(html).toContain("Loses");
  expect(html).toContain("Cloud models (becomes local-only)");
  expect(html).not.toContain("Give Garden access to these");
  expect(html).toContain("Cancel");
});
