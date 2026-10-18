import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PUSH_DESCRIPTION, PushFailure, PushSection, savePush, testPush, turnOffPush } from "../src/Push.tsx";
import { HttpError } from "../src/api.ts";

afterEach(() => vi.unstubAllGlobals());

describe("Settings Push", () => {
  it("makes the privacy explanation available to hover and screen readers", () => {
    const html = renderToStaticMarkup(createElement(PushSection, { userId: "user" }));
    expect(html).toContain(`title="${PUSH_DESCRIPTION.replaceAll("'", "&#x27;")}"`);
    expect(html).not.toContain("tabindex");
    expect(html).toContain('aria-describedby="push-description"');
    expect(html).toContain('id="push-description" class="sr-only"');
  });
  it("shows the last failure with a machine-readable time and monospace numbers, and clears it when absent", () => {
    const html = renderToStaticMarkup(createElement(PushFailure, { failure: { at: "2026-10-18T14:02:00Z", status: 403 } }));
    expect(html).toContain('Last push failed at');
    expect(html).toContain('class="num" dateTime="2026-10-18T14:02:00Z"');
    expect(html).toContain('14:02');
    expect(html).toContain('class="num">403');
    expect(renderToStaticMarkup(createElement(PushFailure, {}))).toBe("");
  });
  it("saves a fresh destination and link choice with the browser origin, receiving only masked settings", async () => {
    const masked = { host: "receiver.test", path: "/•••", set: true, token: true, link: true };
    const fake = vi.fn().mockResolvedValue(new Response(JSON.stringify(masked)));
    vi.stubGlobal("fetch", fake);
    const settings = { url: "https://receiver.test/synthetic-topic", token: "synthetic-token", link: true, origin: "https://lyrica.test" };
    expect(await savePush("user", settings)).toEqual(masked);
    expect(fake).toHaveBeenCalledWith("/api/u/user/push", expect.objectContaining({ method: "PUT", body: JSON.stringify(settings) }));
  });
  it("turns off the saved destination without sending credentials", async () => {
    const fake = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fake);
    await turnOffPush("user");
    expect(fake).toHaveBeenCalledWith("/api/u/user/push", expect.objectContaining({ method: "DELETE", body: undefined }));
  });
  it("sends a test only through lyricad's addressed-user endpoint", async () => {
    const fake = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fake);
    expect(await testPush("user/one")).toBe("Sent");
    expect(fake).toHaveBeenCalledExactlyOnceWith("/api/u/user%2Fone/push/test", { method: "POST", credentials: "same-origin" });
  });
  it.each([403, 0])("shows receiver status %s and its fixed reason from a 502", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ status, reason: "Push destination refused." }), { status: 502 })));
    expect(await testPush("user")).toBe(`${status}: Push destination refused.`);
  });
  it("keeps ordinary API refusals as errors instead of reporting Sent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Save a push URL first." }), { status: 400 })));
    await expect(testPush("user")).rejects.toBeInstanceOf(HttpError);
  });
});
