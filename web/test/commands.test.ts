import { describe, expect, it, vi } from "vitest";
import { commandList, menuRows, parseCommand, type CommandEnv } from "../src/Commands.tsx";
import type { ThreadSettings } from "../src/api.ts";

const settings = {
  code: false, mode: "auto", bypassAllowed: false, webSearch: true, images: false,
  thinking: "medium", thinkingSet: false, thinkingLevels: ["low", "medium", "high"], thinkingNames: {},
  context: { percent: 31 },
  models: { chat: { source: "thread", model: { offeringId: "o1" }, modelId: "qwen3.8-27b" }, code: { source: "none" } },
  allowed: [{ id: "e1", name: "Blackwell", kind: "local", models: [{ id: "o1", modelId: "qwen3.8-27b" }, { id: "o2", modelId: "glm-5.3-flash" }] }],
} as unknown as ThreadSettings;

const env = (over: Partial<CommandEnv> = {}): CommandEnv => ({
  settings, title: "Garden", onSettings: vi.fn(), setModel: vi.fn(async () => {}), openModel: vi.fn(), openContext: vi.fn(),
  compact: vi.fn(async () => {}), rename: vi.fn(async () => {}), newThread: vi.fn(), ...over,
});

describe("commands in the message box", () => {
  it("lists every command after a bare slash, and narrows as the name is typed", () => {
    const list = commandList(env());
    expect(menuRows("/", list).map((r) => r.command.name)).toEqual(["compact", "context", "model", "thinking", "mode", "code", "web", "images", "rename", "new"]);
    expect(menuRows("/co", list).map((r) => r.command.name)).toEqual(["compact", "context", "code"]);
    // A path or a sentence is a message: nothing opens, and nothing runs.
    expect(menuRows("/usr/bin is broken", list)).toEqual([]);
    expect(parseCommand("/usr/bin is broken", list)).toBeUndefined();
    expect(menuRows("hello /co", list)).toEqual([]);
  });

  it("leaves out what the thread can't do: New thread in a project, Context before it is measured", () => {
    const names = commandList(env({ newThread: undefined, openContext: undefined })).map((c) => c.name);
    expect(names).not.toContain("new");
    expect(names).not.toContain("context");
  });

  it("switches web search and images, or sets them with on and off", () => {
    const e = env();
    const list = commandList(e);
    expect(list.find((c) => c.name === "web")!.run("")).toBe("Web search: Off");
    expect(list.find((c) => c.name === "images")!.run("on")).toBe("Images: On");
    expect(e.onSettings).toHaveBeenCalledWith({ webSearch: false });
    expect(() => list.find((c) => c.name === "code")!.run("maybe")).toThrow(/on or off/);
  });

  it("shows a command's choices after its name, and runs the one picked", () => {
    const e = env();
    const list = commandList(e);
    expect(menuRows("/thinking ", list).map((r) => r.kind === "choice" && r.choice.label)).toEqual(["Default (Medium)", "Low", "Medium", "High"]);
    expect(menuRows("/thinking h", list).map((r) => r.kind === "choice" && r.choice.label)).toEqual(["High"]);
    const hit = parseCommand("/thinking high", list)!;
    expect(hit.command.run(hit.arg)).toBe("Thinking: High");
    expect(e.onSettings).toHaveBeenCalledWith({ thinking: "high" });
    // Bypass permissions is offered only where it is allowed.
    expect(menuRows("/mode ", list).map((r) => r.kind === "choice" && r.choice.value)).not.toContain("bypass");
  });

  it("never compacts from the menu alone: picking /compact waits for its text, a sent line runs it", () => {
    expect(commandList(env()).find((c) => c.name === "compact")!.bare).toBe("complete");
    expect(commandList(env({ settings: { ...settings, code: true } })).find((c) => c.name === "model")!.label).toBe("Coding");
  });

  it("compacts with what follows the name as the summary's notes", async () => {
    const e = env();
    const hit = parseCommand("/compact keep the migration plan", commandList(e))!;
    await hit.command.run(hit.arg);
    expect(e.compact).toHaveBeenCalledWith("keep the migration plan");
  });

  it("picks the first model that matches a name, and opens the picker without one", async () => {
    const e = env();
    const model = commandList(e).find((c) => c.name === "model")!;
    expect(await model.run("glm")).toBe("Model: glm-5.3-flash · Blackwell");
    expect(e.setModel).toHaveBeenCalledWith({ offeringId: "o2" });
    await model.run("");
    expect(e.openModel).toHaveBeenCalled();
    await expect(Promise.resolve().then(() => model.run("nothing-like-it"))).rejects.toThrow(/No model matches/);
  });
});
