import { describe, expect, it } from "vitest";
import { matchModel, sameModelName, singledOut } from "../src/index.ts";

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
});
