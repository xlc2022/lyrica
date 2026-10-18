import { describe, expect, it, vi } from "vitest";
import { fakeOpenAI, type Reply } from "../../core/test/fake-openai.ts";
import type { ThreadSummary } from "../src/api.ts";
import { UserEvents } from "../src/user-events.ts";
import { browser, daemon, localModel, login, runtime } from "./helpers.ts";

describe("user events", () => {
  it("coalesces changes per user and cancels unused timers", () => {
    vi.useFakeTimers();
    const events = new UserEvents();
    const ada = vi.fn(), sam = vi.fn();
    const off = events.subscribe("ada", ada);
    events.subscribe("sam", sam);
    try {
      events.changed("ada");
      events.changed("ada");
      vi.advanceTimersByTime(249);
      expect(ada).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(ada).toHaveBeenCalledExactlyOnceWith({ type: "changed" });
      expect(sam).not.toHaveBeenCalled();
      events.changed("ada");
      off();
      vi.advanceTimersByTime(250);
      expect(ada).toHaveBeenCalledTimes(1);
    } finally { events.close(); vi.useRealTimers(); }
  });

  it("notifies another session of API changes, turns and sleep without text, and ends on logout and Lock", async () => {
    const rt = await runtime();
    const { d, base, logs } = await daemon(rt);
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    const writer = await login(base, "ada", "pw");
    const reader = await login(base, "ada", "pw");
    const sam = await login(base, "sam", "pw2");
    const u = `/api/u/${rt.ada.id}`;
    const model = await fakeOpenAI({ models: [{ id: "qwen3.8-27b" }] });
    await localModel(writer, rt.ada.id, model.baseUrl);
    const stream = reader.events(`${u}/events`);
    const other = sam.events(`/api/u/${rt.sam.id}/events`);
    try {
      await stream.until((e) => e.type === "hello");
      await other.until((e) => e.type === "hello");
      expect((await sam.get(`${u}/events`)).status).toBe(401);
      const from = stream.events.length;
      const created = await writer.post<ThreadSummary>(`${u}/threads`, { pool: "general" });
      expect(created.status).toBe(200);
      await stream.until((e) => (e.type as string) === "changed", from);

      let release!: (reply: Reply) => void;
      model.respond(() => new Promise<Reply>((resolve) => { release = resolve; }));
      const hosted = d.services!.host.get(rt.ada.id, "general", created.body.id);
      const started = stream.events.length;
      // Start directly so an HTTP mutation cannot stand in for the turn_start signal.
      await hosted.send("Invented stream privacy marker.");
      await stream.until((e) => (e.type as string) === "changed", started);
      expect(d.services!.host.busy(rt.ada.id, "general", created.body.id)).toBe(true);
      const ended = stream.events.length;
      release({ text: "A fake reply." });
      await d.services!.host.get(rt.ada.id, "general", created.body.id).settled();
      await stream.until((e) => (e.type as string) === "changed", ended);

      const slept = stream.events.length;
      d.services!.sleep.events.emit("event", { userId: rt.ada.id, type: "finished", pool: "general", runId: "fake-run", status: "complete" });
      await stream.until((e) => (e.type as string) === "changed", slept);
      expect(other.events.map((e) => e.event)).toEqual([{ type: "hello" }]);
      expect(stream.events.every((e) => JSON.stringify(e.event) === '{"type":"hello"}' || JSON.stringify(e.event) === '{"type":"changed"}')).toBe(true);
      expect(logs.join("\n")).not.toContain("Invented stream privacy marker.");

      await reader.post("/api/logout");
      d.userEvents.changed(rt.ada.id);
      await stream.done;
      const locked = writer.events(`${u}/events`);
      await locked.until((e) => e.type === "hello");
      await writer.post(`${u}/lock`);
      await locked.done;
      locked.close();
    } finally { stream.close(); other.close(); }
  });
});
