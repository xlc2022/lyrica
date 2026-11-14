// Auto-name (docs/ux.md §6): names come from the thread's `vision` model, a photo of the user goes to a cloud model
// only under the user's photo setting, and a name never takes one already in its folder.
import { describe, expect, it, vi } from "vitest";

vi.mock("@lyrica/extension", () => ({
  modelRuntimeFor: async () => ({ streamSimple: () => "stream" }),
  piModelFor: () => ({ model: { contextWindow: 8192 } }),
  timedReply: async () => {
    flight.now++; flight.most = Math.max(flight.most, flight.now);
    await new Promise((r) => setTimeout(r, 5));
    flight.now--;
    return { reply: { stopReason: "stop", content: [{ type: "text", text: reply }] } };
  },
}));
let reply = "Red Bicycle by a Canal.";
const flight = { now: 0, most: 0 };
const { AUTO_NAME_AT_ONCE, autoNames, freeName, machineName, stemOf } = await import("../src/auto-name.ts");

function setup(o: { portrait?: boolean; policy?: "never" | "ask" | "always"; approved?: boolean; gif?: boolean; names?: string[]; poster?: boolean } = {}) {
  const contexts: { localOnly: boolean }[] = [];
  const models = {
    callContext: () => ({ userId: "u", pool: "general", threadId: "t", localOnly: false }),
    callWithFallback: async (_task: string, ctx: { localOnly: boolean }, _need: unknown, call: (r: unknown) => Promise<unknown>) => { contexts.push(ctx); return call({ label: "m" }); },
    recordCall: vi.fn(), recordPace: vi.fn(),
  };
  const workspace = {
    files: () => ({
      list: async () => ({ entries: (o.names ?? ["red-bicycle-by-a-canal.png"]).map((name) => ({ name })) }),
      thumb: async (p: string) => (p.endsWith(".mp4") && !o.poster ? undefined : { bytes: Buffer.from("thumb"), type: "image/png" }),
    }),
    imageFiles: () => ({
      read: async () => { if (o.gif) throw new Error("an input image must be PNG, JPEG or WebP"); return { input: { bytes: Buffer.from("img"), type: "image/png" }, portrait: !!o.portrait }; },
    }),
    settings: () => ({ photoCloudPolicy: () => o.policy ?? "ask", photoCloudApproved: () => !!o.approved }),
  };
  return { contexts, run: (paths: string[], all?: boolean) => autoNames(models as never, workspace as never, { userId: "u", pool: "general", threadId: "t" }, paths, { all }) };
}

describe("auto-name", () => {
  it("makes a free name from the model's reply, keeping the extension", async () => {
    const { run } = setup();
    expect(await run(["/workspace/uploads/IMG_0042.PNG"])).toEqual([{ path: "/workspace/uploads/IMG_0042.PNG", name: "red-bicycle-by-a-canal-2.png" }]);
  });

  it("keeps two suggestions in one folder apart", async () => {
    const { run } = setup({ names: [] });
    const out = await run(["/workspace/IMG_0001.png", "/workspace/IMG_0002.png"]);
    expect(out.map((x) => x.name)).toEqual(["red-bicycle-by-a-canal.png", "red-bicycle-by-a-canal-2.png"]);
  });

  it("asks a few at a time and answers in the order asked", async () => {
    const { run } = setup({ names: [] });
    flight.most = 0;
    const paths = Array.from({ length: 8 }, (_, i) => `/workspace/${i}.png`);
    const out = await run(paths);
    expect(flight.most).toBe(AUTO_NAME_AT_ONCE);
    expect(out.map((x) => x.path)).toEqual(paths);
    expect(new Set(out.map((x) => x.name)).size).toBe(8);
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
    await run(["/workspace/IMG_0001.png"]);
    expect(contexts[0]!.localOnly).toBe(localOnly);
  });

  it("keeps a name a person chose, asking no model, unless all names are asked for", async () => {
    const { run, contexts } = setup({ names: [] });
    expect(await run(["/workspace/beach-trip.png", "/workspace/IMG_0042.jpg"])).toEqual([
      { path: "/workspace/beach-trip.png", name: "beach-trip.png", kept: true },
      { path: "/workspace/IMG_0042.jpg", name: "red-bicycle-by-a-canal.jpg" },
    ]);
    expect(contexts).toHaveLength(1);
    expect((await run(["/workspace/beach-trip.png"], true))[0]).toEqual({ path: "/workspace/beach-trip.png", name: "red-bicycle-by-a-canal.png" });
  });

  it("names a clip by its poster, as a photo of the user unless the setting allows the cloud", async () => {
    const { run, contexts } = setup({ names: [], poster: true, policy: "never" });
    expect((await run(["/workspace/videos/VID_20231101_120000.mp4"]))[0]!.name).toBe("red-bicycle-by-a-canal.mp4");
    expect(contexts[0]!.localOnly).toBe(true);
    const bare = setup({ names: [] });
    expect((await bare.run(["/workspace/uploads/VID_0001.mp4"]))[0]!.error).toBe("it has no poster to look at");
  });

  it.each([
    "IMG_0042.JPG", "IMG_20231101_123456.jpg", "IMG-20231101-WA0001.jpg", "DSC_0001.JPG", "DSCN1234.jpg", "P1010001.JPG",
    "PXL_20231101_123456789.PORTRAIT.jpg", "VID_20231101_120000.mp4", "Screenshot 2023-11-01 at 10.00.00.png",
    "Screenshot_20231101-100000.png", "WhatsApp Image 2023-11-01 at 10.00.00 AM.jpeg", "image.png", "image (1).png",
    "photo-2.jpg", "untitled.png", "Screen Recording.mov", "cover-0001.jpg", "ComfyUI_00001_.png", "1699999999999.jpg", "20231101_123456.mp4",
    "3f2b8c1e-9a4d-4e2f-8b1a-0c9d7e6f5a4b.png", "d41d8cd98f00b204e9800998ecf8427e.jpg", "a8F3kLq9Zx.webp",
  ])("%s looks made up by a machine", (name) => expect(machineName(name)).toBe(true));

  it.each([
    "beach-trip.png", "Mum's birthday.jpg", "red-bicycle-by-a-canal.png", "room101.png", "IMG_0042 beach.jpg",
    "report2023.png", "final.png", "cat.gif", "logo-v2.png", "cover.png", "night.png", "original.jpg", "portrait-edit.png",
  ])("%s looks chosen by a person", (name) => {
    expect(machineName(name)).toBe(false);
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
    expect((await run(["/workspace/IMG_0001.png"]))[0]!.error).toBe("the model gave no name");
    reply = "Red Bicycle by a Canal.";
  });
});
