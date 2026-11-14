// Auto-name (docs/ux.md §6): names come from the thread's `vision` model, a photo of the user goes to a cloud model
// only under the user's photo setting, and a name never takes one already in its folder.
import { describe, expect, it, vi } from "vitest";

vi.mock("@lyrica/extension", () => ({
  modelRuntimeFor: async () => ({ streamSimple: () => "stream" }),
  piModelFor: () => ({ model: { contextWindow: 8192 } }),
  timedReply: async () => ({ reply: { stopReason: "stop", content: [{ type: "text", text: reply }] } }),
}));
let reply = "Red Bicycle by a Canal.";
const { autoNames, freeName, stemOf } = await import("../src/auto-name.ts");

function setup(o: { portrait?: boolean; policy?: "never" | "ask" | "always"; approved?: boolean; gif?: boolean; names?: string[] } = {}) {
  const contexts: { localOnly: boolean }[] = [];
  const models = {
    callContext: () => ({ userId: "u", pool: "general", threadId: "t", localOnly: false }),
    callWithFallback: async (_task: string, ctx: { localOnly: boolean }, _need: unknown, call: (r: unknown) => Promise<unknown>) => { contexts.push(ctx); return call({ label: "m" }); },
    recordCall: vi.fn(), recordPace: vi.fn(),
  };
  const workspace = {
    files: () => ({
      list: async () => ({ entries: (o.names ?? ["red-bicycle-by-a-canal.png"]).map((name) => ({ name })) }),
      thumb: async () => ({ bytes: Buffer.from("thumb"), type: "image/png" }),
    }),
    imageFiles: () => ({
      read: async () => { if (o.gif) throw new Error("an input image must be PNG, JPEG or WebP"); return { input: { bytes: Buffer.from("img"), type: "image/png" }, portrait: !!o.portrait }; },
    }),
    settings: () => ({ photoCloudPolicy: () => o.policy ?? "ask", photoCloudApproved: () => !!o.approved }),
  };
  return { contexts, run: (paths: string[]) => autoNames(models as never, workspace as never, { userId: "u", pool: "general", threadId: "t" }, paths) };
}

describe("auto-name", () => {
  it("makes a free name from the model's reply, keeping the extension", async () => {
    const { run } = setup();
    expect(await run(["/workspace/uploads/IMG_0042.PNG"])).toEqual([{ path: "/workspace/uploads/IMG_0042.PNG", name: "red-bicycle-by-a-canal-2.png" }]);
  });

  it("keeps two suggestions in one folder apart", async () => {
    const { run } = setup({ names: [] });
    const out = await run(["/workspace/a.png", "/workspace/b.png"]);
    expect(out.map((x) => x.name)).toEqual(["red-bicycle-by-a-canal.png", "red-bicycle-by-a-canal-2.png"]);
  });

  it.each([
    [{ portrait: true, policy: "never" as const }, true],
    [{ portrait: true, policy: "ask" as const }, true],
    [{ portrait: true, policy: "ask" as const, approved: true }, false],
    [{ portrait: true, policy: "always" as const }, false],
    [{ portrait: false, policy: "never" as const }, false],
    [{ gif: true, policy: "always" as const }, false],
    [{ gif: true, policy: "never" as const }, true],
  ])("a photo of the user stays local unless the setting allows the cloud: %j → local only %s", async (o, localOnly) => {
    const { run, contexts } = setup(o);
    await run(["/workspace/a.png"]);
    expect(contexts[0]!.localOnly).toBe(localOnly);
  });

  it("names nothing outside the thread's folder", async () => {
    const { run, contexts } = setup();
    const out = await run(["photos-of-me/me.png", "/workspace/../photos-of-me/me.png", "/workspace/notes.md"]);
    expect(out.every((x) => x.error && !x.name)).toBe(true);
    expect(contexts).toEqual([]);
  });

  it("turns a reply into a name's stem", () => {
    expect(stemOf("\"Sunset over Lake Bled\"\nextra")).toBe("sunset-over-lake-bled");
    expect(stemOf("café-terrace.jpg")).toBe("cafe-terrace");
    expect(stemOf("   ")).toBe("");
    expect(freeName("a", ".png", new Set(["a.png", "a-2.png"]))).toBe("a-3.png");
  });

  it("reports a reply with no name as that image's error", async () => {
    reply = "…";
    const { run } = setup();
    expect((await run(["/workspace/a.png"]))[0]!.error).toBe("the model gave no name");
    reply = "Red Bicycle by a Canal.";
  });
});
