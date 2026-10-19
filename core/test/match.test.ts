import { describe, expect, it } from "vitest";
import { matchModel } from "../src/index.ts";

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
});
