// The portrait permission card names the resolved model and grants only daily consent (principle 2).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PermissionRequest } from "../src/api.ts";
import { PortraitPrompt } from "../src/Messages.tsx";

describe("portrait consent", () => {
  it("shows the model, the daily consequence and exactly Send today and Not today, including for a subagent", () => {
    const p: PermissionRequest = { requestId: "portrait", toolCallId: "image", tool: "image",
      args: { model: "cloud-images/gpt-image-1", provider: "cloud-images", question: "Send photos of you to cloud-images?" },
      expiresAt: "2026-10-12T12:00:00Z", suspect: true,
      subagent: { runId: "run", threadId: "child", parentThreadId: "parent", role: "builder" } };
    const html = renderToStaticMarkup(createElement(PortraitPrompt, { p, answer: () => {}, busy: false, left: "1m", error: "" }));
    expect(html).toContain("Send your portrait photos to cloud-images/gpt-image-1 (cloud) for this image? A yes lasts until the end of the day.");
    expect(html.match(/<button\b/g)).toHaveLength(2);
    expect(html).toContain('class="primary">Send today</button>');
    expect(html).toContain(">Not today</button>");
    expect(html).not.toContain("Allow");
    expect(html).not.toContain("<pre>");
  });
});
