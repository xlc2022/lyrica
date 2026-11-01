import { describe, expect, it } from "vitest";
import { claudeAlias, isClaudeModel, matchModel, meansClaude, namedOutright, sameModelName, singledOut } from "../src/index.ts";

const models = [
  { id: "1", label: "gpu/qwen3.8-flash-next" },
  { id: "2", label: "gpu/qwen3.8-27b" },
  { id: "3", label: "chatgpt/gpt-6.1-sol" },
  { id: "4", label: "openrouter/deepseek/deepseek-4.1-flash" },
];
const pick = (name: string) => { const m = matchModel(name, models); return "model" in m ? m.model.label : m.closest.map((x) => x.label); };

describe("naming a model in plain words", () => {
  it("finds the one model a name fits", () => {
    expect(pick("gpu/qwen3.8-27b")).toBe("gpu/qwen3.8-27b");
    expect(pick("GPT-6.1-Sol")).toBe("chatgpt/gpt-6.1-sol");
    expect(pick("qwen flash")).toBe("gpu/qwen3.8-flash-next");
    expect(pick("deepseek")).toBe("openrouter/deepseek/deepseek-4.1-flash");
    expect(pick("4")).toBe("openrouter/deepseek/deepseek-4.1-flash");
  });

  it("offers the closest when a name fits several or none", () => {
    expect(pick("qwen")).toEqual(["gpu/qwen3.8-flash-next", "gpu/qwen3.8-27b"]);
    expect(pick("flash")).toEqual(["gpu/qwen3.8-flash-next", "openrouter/deepseek/deepseek-4.1-flash"]);
    expect(pick("gpt 6.2 sol")[0]).toBe("chatgpt/gpt-6.1-sol");
    expect(pick("llama")).toEqual([]);
  });

  it("tells whether the person's words single out one model", () => {
    const paid = { id: "5", label: "router/qwen/qwen3.8-27b" };
    const all = [...models, paid];
    expect(singledOut("use router/qwen/qwen3.8-27b", paid, all)).toBe(true);
    expect(singledOut("use qwen3.8-27b", paid, all)).toBe(false);
    expect(singledOut("use deepseek-4.1-flash please", models[3]!, all)).toBe(true);
    expect(singledOut("what's in this picture?", paid, all)).toBe(false);
    expect(sameModelName("router/qwen/qwen3.8-27b", "gpu/qwen3.8-27b")).toBe(true);
    expect(sameModelName("gpu/qwen3.8-flash-next", "gpu/qwen3.8-27b")).toBe(false);
  });

  it("tells a name that means Claude itself from one of Claude's copies, and which alias it asks for", () => {
    for (const n of ["Claude", "claude opus", "Claude Sonnet 4.5", "Anthropic Claude", "opus", "Claude Code"]) expect(meansClaude(n), n).toBe(true);
    for (const n of ["", "deepseek", "claude-opus-latest", "anthropic/claude-opus-latest", "openrouter/anthropic/claude-sonnet-4", "qwen opus"]) expect(meansClaude(n), n).toBe(false);
    expect(claudeAlias("Claude Opus")).toBe("opus");
    expect(claudeAlias("use haiku")).toBe("haiku");
    expect(claudeAlias("Claude")).toBeUndefined();
    expect(isClaudeModel("anthropic/claude-opus-latest")).toBe(true);
    expect(isClaudeModel("openrouter/anthropic/claude-sonnet-4")).toBe(true);
    expect(isClaudeModel("openrouter/deepseek/deepseek-4.1-flash")).toBe(false);
    const paid = [...models, { id: "5", label: "anthropic/claude-opus-latest" }];
    expect(namedOutright("anthropic/claude-opus-latest", paid)).toBe(true);
    expect(namedOutright("5", paid)).toBe(true);
    expect(namedOutright("claude-opus-latest", paid)).toBe(false);
    expect(namedOutright("claude opus", paid)).toBe(false);
  });
});
