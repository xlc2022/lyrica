import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, type ExtensionAPI, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ThreadImages, Workspace, type CallContext, type JobProgress } from "@lyrica/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeImages, mp4, png } from "../../core/test/fake-images.ts";
import { ASK_INSTEAD, createImageExtension, imageParameters, ratioSize, type ApprovalRequest, type ClipMade, type ImageTools } from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const noUI = { hasUI: false } as ExtensionToolContext;
const create = { action: "create", prompt: "A garden", tier: "quality", references: ["/photos-of-me/portrait.png"] };
const edit = { action: "edit", instruction: "Add flowers", image: "/photos-of-me/portrait.png" };

async function setup() {
  const s = await fakeImages();
  // A mounted-home stand-in for these socket/FUSE-free tests; only synthetic bitmap bytes land here.
  const home = mkdtempSync(join(tmpdir(), "lyrica-images-")); dirs.push(home);
  const thread = "web/a", folder = join(home, "threads", encodeURIComponent(thread));
  mkdirSync(join(home, "photos-of-me")); mkdirSync(join(folder, "uploads"), { recursive: true });
  writeFileSync(join(home, "photos-of-me", "portrait.png"), png);
  writeFileSync(join(folder, "uploads", "landscape.png"), png);
  const workspace = new Workspace(s.keyring, s.users, { excludePorts: [] });
  const settings = workspace.settings(s.ada.id);
  const files = new ThreadImages(() => home, () => ["threads", encodeURIComponent(thread)], async path => {
    const local = path.replace(/^\/workspace\//, "");
    if (local.includes("..") || local.startsWith("/")) throw new Error("outside the thread");
    const bytes = readFileSync(join(folder, local));
    return { stream: Readable.from([bytes]), size: bytes.length };
  }, settings);
  let date = new Date(2026, 9, 12, 10), context: Partial<CallContext> = {}, enabled = true, allowed = true;
  const asked: ApprovalRequest[] = [];
  const options = { models: s.models, threadId: thread, files, call: () => s.ctx(context), settings: () => settings,
    enabled: () => enabled, now: () => date, approve: async (r: ApprovalRequest) => { asked.push(r); return allowed; } };
  let tool!: ToolDefinition;
  const factory = createImageExtension(options);
  // Each run is a turn of its own: the user wrote again.
  let turn = () => {};
  factory({ on: (event: string, f: () => void) => { if (event === "agent_start") turn = f; }, registerTool: (t: ToolDefinition) => { tool = t; } } as unknown as ExtensionAPI);
  const run = (args: unknown, id = "call") => { turn(); return tool.execute(id, args, undefined, undefined, noUI); };
  return { ...s, files, home, folder, settings, asked, run, factory, options, tool,
    tomorrow: () => { date = new Date(2026, 9, 13, 10); }, context: (c: Partial<CallContext>) => { context = c; },
    allow: (yes: boolean) => { allowed = yes; }, enable: (yes: boolean) => { enabled = yes; } };
}

describe("image tool: portrait photos (principle 2)", () => {
  it("Never refuses cloud edits of derived portraits after copying, renaming and another local edit", async () => {
    const s = await setup(); s.settings.setPhotoCloudPolicy("never"); s.context({ localOnly: true });
    const first = await s.run(edit);
    const path = (first.details as { image: { paths: string[] } }).image.paths[0]!;
    renameSync(join(s.folder, path.slice("/workspace/".length)), join(s.folder, "uploads", "renamed.png"));
    copyFileSync(join(s.folder, "uploads", "renamed.png"), join(s.folder, "uploads", "copy.png"));
    const input = "/workspace/uploads/copy.png";
    expect((await s.files.read(input)).portrait).toBe(true);
    // Reopening settings demonstrates that provenance persists in encrypted user.db.
    const reopened = new Workspace(s.keyring, s.users, { excludePorts: [] }).settings(s.ada.id);
    const reader = new ThreadImages(() => s.home, () => ["threads", "web%2Fa"], async () => {
      const bytes = readFileSync(join(s.folder, "uploads", "copy.png")); return { stream: Readable.from([bytes]), size: bytes.length };
    }, reopened);
    try { expect((await reader.read(input)).portrait).toBe(true); } finally { reopened.close(); }
    s.context({ localOnly: false });
    await expect(s.run({ ...edit, image: input })).rejects.toThrow(/aren't allowed/);
    // A different output proves the next generation gets its own hash marker.
    const next = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    s.workstation.server.replyImage(next);
    s.context({ localOnly: true });
    const second = await s.run({ ...edit, image: input });
    const secondPath = (second.details as { image: { paths: string[] } }).image.paths[0]!;
    expect((await s.files.read(secondPath)).portrait).toBe(true);
    s.context({ localOnly: false });
    await expect(s.run({ ...edit, image: secondPath })).rejects.toThrow(/aren't allowed/);
    expect(s.heard).toEqual([]); expect(s.asked).toEqual([]);
  });
  it("Never refuses create references, edit inputs and masks before any bytes reach cloud", async () => {
    const s = await setup(); s.settings.setPhotoCloudPolicy("never");
    for (const args of [create, edit, { action: "edit", instruction: "Add flowers", image: "/workspace/uploads/landscape.png", mask: "/photos-of-me/portrait.png" }]) {
      await expect(s.run(args)).rejects.toThrow(/aren't allowed/);
    }
    expect(s.heard).toEqual([]); expect(s.asked).toEqual([]);
    await s.run({ action: "edit", instruction: "Add flowers", image: "/workspace/uploads/landscape.png" });
    expect(s.heard).toHaveLength(1);
  });
  it("Ask denies without sending, allows once per user per day, and asks again tomorrow", async () => {
    const s = await setup(); expect(s.settings.photoCloudPolicy()).toBe("ask");
    s.allow(false);
    await expect(s.run(create)).rejects.toThrow(/wasn't approved/);
    expect(s.heard).toEqual([]);
    s.allow(true); await s.run(create); await s.run(edit);
    // Another thread of the same user reuses the encrypted daily approval.
    let second!: ToolDefinition;
    createImageExtension({ ...s.options, threadId: "web/b" })({ on: () => {}, registerTool: (t: ToolDefinition) => { second = t; } } as unknown as ExtensionAPI);
    await second.execute("second", edit, undefined, undefined, noUI);
    expect(s.asked).toHaveLength(2);
    expect(s.asked[1]).toMatchObject({ tool: "image", input: { question: "Send photos of you to openai?", provider: "openai", model: "openai/gpt-image-1" } });
    s.tomorrow(); await s.run(edit);
    expect(s.asked).toHaveLength(3); expect(s.heard).toHaveLength(4);
  });
  it("shares one pending daily question across concurrent threads", async () => {
    const s = await setup();
    let answer!: (yes: boolean) => void;
    const approve = vi.fn(() => new Promise<boolean>(resolve => { answer = resolve; }));
    const tools: ToolDefinition[] = [];
    for (const threadId of ["web/a", "web/b"]) createImageExtension({ ...s.options, threadId, approve })({
      on: () => {}, registerTool: (t: ToolDefinition) => { tools.push(t); },
    } as unknown as ExtensionAPI);
    const runs = tools.map((t, n) => t.execute(`concurrent-${n}`, create, undefined, undefined, noUI));
    await vi.waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
    answer(true); await Promise.all(runs);
    expect(approve).toHaveBeenCalledTimes(1); expect(s.heard).toHaveLength(2);
  });
  it("daily approvals belong to one user and changing the policy clears them", async () => {
    const s = await setup(); await s.run(create);
    expect(s.settings.photoCloudApproved("2026-10-12")).toBe(true);
    const sam = await s.users.createUser("sam", "pw", { displayName: "Sam", pronouns: s.ada.profile.pronouns }, { admin: false });
    await s.users.authenticate("sam", "pw");
    const workspace = new Workspace(s.keyring, s.users, { excludePorts: [] });
    expect(workspace.settings(sam.id).photoCloudApproved("2026-10-12")).toBe(false);
    s.settings.setPhotoCloudPolicy("never");
    expect(s.settings.photoCloudApproved("2026-10-12")).toBe(false);
    s.settings.setPhotoCloudPolicy("ask"); await s.run(create);
    expect(s.asked).toHaveLength(2);
  });
  it("Always and local models allow photos without asking, including upscale", async () => {
    const s = await setup(); s.settings.setPhotoCloudPolicy("always");
    await s.run(create); await s.run(edit);
    s.settings.setPhotoCloudPolicy("never"); s.context({ localOnly: true });
    await s.run(create); await s.run(edit); await s.run({ action: "upscale", image: "/photos-of-me/portrait.png", scale: 2 });
    expect(s.asked).toEqual([]); expect(s.heard).toHaveLength(2);
    expect(s.workstation.server.images.map(i => i.action)).toEqual(["create", "edit", "upscale"]);
  });
  it("checks the actual fallback model, before a local to cloud fallback sends portraits", async () => {
    const s = await setup();
    s.models.setColumnTask(s.ada.id, "general", "image.create", [s.workstation.ref, s.ref]);
    s.context({}); s.workstation.server.imagesOff();
    s.settings.setPhotoCloudPolicy("never");
    await expect(s.run(create)).rejects.toThrow(/aren't allowed/);
    expect(s.heard).toEqual([]); expect(s.asked).toEqual([]);
    s.settings.setPhotoCloudPolicy("ask"); await s.run(create);
    expect(s.asked[0]?.input).toMatchObject({ provider: "openai" }); expect(s.heard).toHaveLength(1);
  });
  it("has no approval without a viewer and rechecks policy and local-only changes while asking", async () => {
    const s = await setup();
    let tool!: ToolDefinition;
    const capture = { on: () => {}, registerTool: (t: ToolDefinition) => { tool = t; } } as unknown as ExtensionAPI;
    createImageExtension({ ...s.options, approve: undefined })(capture);
    await expect(tool.execute("no-viewer", create, undefined, undefined, noUI)).rejects.toThrow(/wasn't approved/);
    createImageExtension({ ...s.options, approve: async () => { s.settings.setPhotoCloudPolicy("never"); return true; } })(capture);
    await expect(tool.execute("changed", create, undefined, undefined, noUI)).rejects.toThrow(/wasn't approved/);
    s.settings.setPhotoCloudPolicy("ask");
    createImageExtension({ ...s.options, approve: async () => { s.context({ localOnly: true }); return true; } })(capture);
    await expect(tool.execute("local", create, undefined, undefined, noUI)).rejects.toThrow(/local models only/);
    expect(s.heard).toEqual([]);
  });
});

describe("image tool results (principles 1 and 4)", () => {
  it("tries a model asked for by name first, and says when the name matches none", async () => {
    const s = await setup();
    const named = await s.run({ action: "create", prompt: "A garden", model: "GPT Image" });
    const text = (named.content as { type: string; text?: string }[]).find(c => c.type === "text")!.text!;
    expect(text).toMatch(/^Made with gpt-image-1 on openai\. Saved /);
    const unknown = await s.run({ action: "create", prompt: "A garden", model: "Flux" });
    expect(unknown.content).toContainEqual({ type: "text", text: expect.stringMatching(/No image model here is called "Flux"; the ones that can: .*gpt-image-1/) });
  });

  it("sends LoRAs asked for by name to a model that takes them, says which, and lists the library when one isn't found", async () => {
    const s = await setup();
    const styles = await s.host("styles", undefined, undefined, undefined, ["l/pixel_art_v2.safetensors", "w/detail_high_noise.safetensors", "w/detail_low_noise.safetensors"]);
    const tool = (o: ImageTools) => { let t!: ToolDefinition; createImageExtension(o)({ on: () => {}, registerTool: (d: ToolDefinition) => { t = d; } } as unknown as ExtensionAPI); return t; };
    const loras = (tool(s.options as ImageTools).parameters as { properties: { loras: { description: string } } }).properties.loras;
    expect(loras.description).toContain("The LoRAs here: detail high noise, detail low noise, pixel art v2.");
    // The thread's list is a cloud model, which takes none: the model that takes it goes first.
    const made = await s.run({ action: "create", prompt: "A garden", loras: [{ name: "Pixel Art", strength: 0.7 }] });
    expect((made.content as { type: string; text?: string }[]).find(c => c.type === "text")!.text).toMatch(/^Made with Art on styles\. With pixel art v2 at 0\.7\. Saved /);
    expect(styles.server.images.map(i => i.body)).toEqual([{ recipe: "art", prompt: "A garden", loras: [{ file: "l/pixel_art_v2.safetensors", strength: 0.7 }] }]);
    await expect(s.run({ action: "create", prompt: "A garden", loras: [{ name: "ink", strength: 1 }] }))
      .rejects.toThrow('No image model here takes "ink". The LoRAs here: detail high noise, detail low noise, pixel art v2.');
    await expect(s.run({ action: "upscale", image: "/workspace/uploads/landscape.png", loras: [{ name: "pixel art", strength: 1 }] })).rejects.toThrow(/upscale takes no LoRAs/);
    expect(s.heard).toEqual([]);
  });

  it("stores PNGs under the thread's images/ and returns image content and path/model/tier details", async () => {
    const s = await setup(); s.settings.setPhotoCloudPolicy("always");
    const out = await s.run({ action: "create", prompt: "A garden", tier: "fast", aspectRatio: "16:9", count: 2 });
    const part = (out.details as { image: { paths: string[]; model: string; tier: string } }).image;
    expect(part).toMatchObject({ type: "image", model: "openai/gpt-image-1", tier: "fast" });
    expect(s.heard[0]?.body).toMatchObject({ size: "1536x1024", n: 2, quality: "low" });
    expect(part.paths).toHaveLength(2);
    expect(part.paths[0]).toMatch(/^\/workspace\/images\/[a-f\d-]+\.png$/);
    const saved = readFileSync(join(s.folder, "images", part.paths[0]!.split("/").at(-1)!));
    expect(saved).toEqual(png); expect(saved.toString()).not.toContain("A garden");
    expect(readdirSync(join(s.folder, "images"))).toHaveLength(2);
    expect(out.content).toContainEqual({ type: "text", text: expect.stringContaining("Made with gpt-image-1 on openai.") });
    expect(out.content).toContainEqual({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
    const image = await s.files.read(part.paths[0]!);
    expect(image.portrait).toBe(false); expect(image.input.bytes).toEqual(png);
    await s.run({ action: "edit", instruction: "Add flowers", image: part.paths[0] });
    // A create without a tier is a quality one, rather than an error the model has to fix.
    const plain = await s.run({ action: "create", prompt: "A pond" });
    expect((plain.details as { image: { tier: string } }).image.tier).toBe("quality");
    expect(s.heard.at(-1)?.body).toMatchObject({ quality: "high" });
    expect(s.models.recentCalls(s.ada.id)).toHaveLength(3);
    expect(JSON.stringify(s.models.recentCalls(s.ada.id))).not.toMatch(/garden|flowers/);
  });
  it("makes a clip from a prompt or a portrait's first frame on the host, keeps it in videos/ with its poster, and shows her the poster", async () => {
    const s = await setup(); s.settings.setPhotoCloudPolicy("never");
    s.models.setColumnTask(s.ada.id, "general", "video", [s.workstation.clip]);
    const out = await s.run({ action: "video", prompt: "A fox in the snow", aspectRatio: "16:9", duration: 5, steps: 20 });
    const part = (out.details as { video: { path: string } }).video;
    expect(part).toMatchObject({ type: "video", model: "shared.workstation/Clip", width: 1280, height: 704, duration: 5.04, audio: false });
    expect(part.path).toMatch(/^\/workspace\/videos\/[a-f\d-]+\.mp4$/);
    const name = part.path.split("/").at(-1)!;
    expect(readFileSync(join(s.folder, "videos", name))).toEqual(mp4);
    expect(readFileSync(join(s.folder, ".lyrica", "thumbs", "videos", `${name}.png`))).toEqual(png);
    expect(out.content).toContainEqual({ type: "text", text: expect.stringContaining("Made with Clip on workstation: 5.0 s at 1280×704.") });
    expect(out.content).toContainEqual({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
    // A portrait's first frame goes only to a model host, so even Never lets it through, with no question.
    await s.run({ action: "animate", prompt: "She waves", image: "/photos-of-me/portrait.png" });
    expect(s.asked).toEqual([]);
    expect(s.workstation.server.videos).toEqual([
      { recipe: "clip", prompt: "A fox in the snow", aspectRatio: "16:9", duration: 5, steps: 20 },
      { recipe: "clip", prompt: "She waves", image: png.toString("base64") },
    ]);
    expect(s.models.recentCalls(s.ada.id).map(c => c.task)).toEqual(["video", "video"]);
    expect(JSON.stringify(s.models.recentCalls(s.ada.id))).not.toMatch(/fox|waves/);
    await expect(s.run({ action: "animate", prompt: "It runs" })).rejects.toThrow("animate needs image");
    s.models.setColumnTask(s.ada.id, "general", "video", []);
    await expect(s.run({ action: "video", prompt: "A fox" })).rejects.toThrow();
    expect(s.heard).toEqual([]);
  });
  it("moves a portrait as the person in a workspace clip moves, on the host only, with no question", async () => {
    const s = await setup(); s.settings.setPhotoCloudPolicy("never");
    s.models.setColumnTask(s.ada.id, "general", "video", [s.workstation.clip, s.workstation.moves]);
    writeFileSync(join(s.folder, "uploads", "dance.mp4"), mp4);
    const out = await s.run({ action: "motion", prompt: "A plain studio", image: "/photos-of-me/portrait.png", video: "/workspace/uploads/dance.mp4" });
    expect((out.details as { video: { model: string } }).video.model).toBe("shared.workstation/Moves");
    expect(s.asked).toEqual([]);
    expect(s.workstation.server.videos).toEqual([{ recipe: "moves", prompt: "A plain studio", image: png.toString("base64"), drive: mp4.toString("base64") }]);
    await expect(s.run({ action: "motion", prompt: "x", image: "/photos-of-me/portrait.png" })).rejects.toThrow("motion needs video");
    await expect(s.run({ action: "motion", prompt: "x", image: "/photos-of-me/portrait.png", video: "/workspace/uploads/landscape.png" })).rejects.toThrow(/isn't an MP4/);
    expect(s.heard).toEqual([]);
  });
  it("makes a workspace clip longer on a recipe that extends, and says the Videos model's longest in duration", async () => {
    const s = await setup();
    const tool = (o: ImageTools) => { let t!: ToolDefinition; createImageExtension(o)({ on: () => {}, registerTool: (d: ToolDefinition) => { t = d; } } as unknown as ExtensionAPI); return t; };
    const duration = (t: ToolDefinition) => (t.parameters as { properties: { duration: { maximum: number; description: string } } }).properties.duration;
    s.models.setColumnTask(s.ada.id, "general", "video", [s.workstation.long]);
    expect(duration(tool(s.options as ImageTools))).toMatchObject({ maximum: 60, description: expect.stringContaining("Long makes up to 60 s, joining clips into one") });
    s.models.setColumnTask(s.ada.id, "general", "video", [s.workstation.clip, s.workstation.long]);
    expect(duration(tool(s.options as ImageTools))).toMatchObject({ maximum: 8, description: expect.stringContaining("Clip makes up to 8 s.") });
    writeFileSync(join(s.folder, "uploads", "walk.mp4"), mp4);
    const out = await s.run({ action: "extend", prompt: "She keeps walking", video: "/workspace/uploads/walk.mp4", duration: 6 });
    expect((out.details as { video: { model: string; path: string } }).video).toMatchObject({ model: "shared.workstation/Long", path: expect.stringMatching(/^\/workspace\/videos\//) });
    expect(s.workstation.server.videos).toEqual([{ recipe: "long", prompt: "She keeps walking", extend: mp4.toString("base64"), duration: 6 }]);
    await expect(s.run({ action: "extend", prompt: "x" })).rejects.toThrow("extend needs video");
    // A clip given to video is refused, not ignored: a new clip isn't the one they meant to go on.
    await expect(s.run({ action: "video", prompt: "x", video: "/workspace/uploads/walk.mp4" })).rejects.toThrow("video doesn't take video: extend makes a clip longer");
    expect(s.workstation.server.videos).toHaveLength(1);
    // An empty field, as smaller models send for ones they don't use, isn't a file given.
    await s.run({ action: "extend", prompt: "She turns", video: "/workspace/uploads/walk.mp4", references: [], image: "" });
    expect(s.workstation.server.videos).toHaveLength(2);
    expect(s.heard).toEqual([]);
  });
  it("hands a clip to the background when lyricad runs clips, so her turn ends, and the clip comes back when it's made", async () => {
    const s = await setup();
    s.models.setColumnTask(s.ada.id, "general", "video", [s.workstation.clip]);
    const started: ((signal: AbortSignal, onProgress: (p: JobProgress) => void) => Promise<ClipMade>)[] = [];
    const ids: string[] = [];
    (s.options as ImageTools).background = (make, id) => { started.push(make); ids.push(id); };
    const out = await s.run({ action: "video", prompt: "A fox in the snow" });
    expect(out.details).toEqual({ clip: "started" });
    expect(out.content).toEqual([{ type: "text", text: expect.stringContaining("Making the clip in the background") }]);
    // Nothing has gone to the host yet: the job does that, after the call returned.
    expect(s.workstation.server.videos).toEqual([]);
    const made = await started[0]!(new AbortController().signal, () => {});
    expect(made.video).toMatchObject({ type: "video", model: "shared.workstation/Clip", width: 1280, height: 704 });
    expect(made.text).toMatch(/^The clip for "A fox in the snow" is ready\. Made with Clip on workstation: 5\.0 s at 1280×704\. Saved \/workspace\/videos\/.+\.mp4\.$/);
    expect(readFileSync(join(s.folder, "videos", made.video.path.split("/").at(-1)!))).toEqual(mp4);
    // The call's arguments come back with it, for the clip's marker.
    expect(made.args).toMatchObject({ action: "video", prompt: "A fox in the snow" });
    expect(s.models.recentCalls(s.ada.id).map(c => c.task)).toEqual(["video"]);
    // Images turned off while it waited: nothing is sent.
    await s.run({ action: "video", prompt: "A cat" });
    s.enable(false);
    await expect(started[1]!(new AbortController().signal, () => {})).rejects.toThrow("Images are off");
    expect(s.workstation.server.videos).toHaveLength(1);
  });
  it("passes a host's progress to Pi as the call's update, for the chat's placeholder", async () => {
    const s = await setup();
    s.context({ localOnly: true });
    const image = s.models.image.bind(s.models);
    vi.spyOn(s.models, "image").mockImplementation(async (ctx, request, opts) => { opts?.onProgress?.({ queued: false, progress: 0.5 }); return image(ctx, request, opts); });
    const updates: unknown[] = [];
    await s.tool.execute("call", { action: "create", prompt: "A garden", tier: "quality" }, undefined, (u: unknown) => updates.push(u), noUI);
    expect(updates).toEqual([{ content: [], details: { progress: { queued: false, progress: 0.5 } } }]);
  });
  it("names the host and recipe that made the image, by the recipe's name", async () => {
    const s = await setup();
    s.context({ localOnly: true });
    const out = await s.run({ action: "create", prompt: "A garden", tier: "quality" });
    expect(out.content).toContainEqual({ type: "text", text: expect.stringContaining("Made with Art on workstation.") });
  });
  it.each(["image", "refusal"] as const)("Pi passes the %s result back to the model, with no disk session", async kind => {
    const s = await setup();
    if (kind === "refusal") vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: "content_policy_violation" } }, { status: 400 })));
    const faux = fauxProvider({ provider: "faux", models: [{ id: "vision", input: ["text", "image"] }] });
    let seen: unknown;
    faux.setResponses([fauxAssistantMessage([fauxToolCall("image", { action: "create", prompt: "A garden", tier: "quality" })]),
      (ctx: { messages: unknown[] }) => { seen = ctx.messages; return fauxAssistantMessage("done"); }]);
    const loader = new DefaultResourceLoader({ cwd: s.home, agentDir: s.home, noContextFiles: true, noSkills: true, noExtensions: true, noPromptTemplates: true,
      extensionFactories: [pi => pi.registerProvider(faux.provider), s.factory] });
    await loader.reload();
    const { session } = await createAgentSession({ cwd: s.home, agentDir: s.home, resourceLoader: loader, sessionManager: SessionManager.inMemory(s.home), noTools: "builtin" });
    try {
      await session.bindExtensions({}); await session.setModel(faux.getModel()); await session.prompt("Make a garden image.");
      if (kind === "refusal") expect(seen).toEqual(expect.arrayContaining([expect.objectContaining({ role: "toolResult", toolName: "image", isError: true,
        details: { imageRefusal: expect.objectContaining({ code: "image_refusal" }) } })]));
      else expect(seen).toEqual(expect.arrayContaining([expect.objectContaining({ role: "toolResult", toolName: "image",
        content: expect.arrayContaining([{ type: "image", data: png.toString("base64"), mimeType: "image/png" }]) })]));
    } finally { session.dispose(); }
  });
  it("is one object schema, and names the fields an action is missing", async () => {
    // LM Studio refuses a tool whose parameters aren't `"type": "object"`; a top-level anyOf also shows small models no fields.
    expect(imageParameters).toMatchObject({ type: "object", properties: { action: expect.anything(), prompt: expect.anything(), image: expect.anything() } });
    expect(imageParameters).not.toHaveProperty("anyOf");
    const s = await setup();
    await expect(s.run({ action: "create" })).rejects.toThrow("create needs prompt: prompt is required");
    await expect(s.run({ action: "edit", image: "/photos-of-me/portrait.png" })).rejects.toThrow("edit needs instruction");
    expect(s.heard).toHaveLength(0);
  });
  it("says which model a failed call reached and what it answered", async () => {
    const s = await setup();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: "bad size" } }, { status: 400 })));
    await expect(s.run({ action: "create", prompt: "A garden", tier: "fast" })).rejects.toThrow(/^Image create failed with openai\/gpt-image-1 \[invalid\]: .+/);
  });
  it("uses recipe defaults with no size, converts ratios, and refuses conflicting size and ratio", async () => {
    expect(ratioSize("16:9")).toEqual({ width: 1360, height: 768 });
    expect(() => ratioSize("0:1")).toThrow(/aspect ratio/);
    const s = await setup(); s.enable(false);
    await expect(s.run(create)).rejects.toThrow(/Images are off/);
    s.enable(true);
    await expect(s.run({ action: "create", prompt: "A garden", tier: "fast", size: { width: 1024, height: 1024 }, aspectRatio: "1:1" })).rejects.toThrow(/size or an aspect ratio/);
  });
});

it("runs no image call after a refusal for the rest of the turn, passing the refusal's reason on", async () => {
  const s = await setup();
  const fetch = vi.fn(async () => Response.json({ error: { code: "content_policy_violation" } }, { status: 400 }));
  vi.stubGlobal("fetch", fetch);
  const faux = fauxProvider({ provider: "faux", models: [{ id: "vision", input: ["text", "image"] }] });
  const call = fauxToolCall("image", { action: "create", prompt: "A garden", tier: "quality" });
  let seen: unknown[] = [];
  faux.setResponses([fauxAssistantMessage([call]), fauxAssistantMessage([fauxToolCall("image", { action: "create", prompt: "A garden, reworded", tier: "quality" })]),
    (ctx: { messages: unknown[] }) => { seen = ctx.messages; return fauxAssistantMessage("done"); },
    fauxAssistantMessage([call]), fauxAssistantMessage("done")]);
  const loader = new DefaultResourceLoader({ cwd: s.home, agentDir: s.home, noContextFiles: true, noSkills: true, noExtensions: true, noPromptTemplates: true,
    extensionFactories: [pi => pi.registerProvider(faux.provider), s.factory] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: s.home, agentDir: s.home, resourceLoader: loader, sessionManager: SessionManager.inMemory(s.home), noTools: "builtin" });
  try {
    await session.bindExtensions({}); await session.setModel(faux.getModel()); await session.prompt("Make a garden image.");
    const results = (seen as { role: string; content: { text?: string }[] }[]).filter(m => m.role === "toolResult").map(m => m.content[0]?.text);
    expect(results).toEqual(["Image generation was refused (image_refusal).", expect.stringContaining("no more image calls run in this turn")]);
    expect(fetch).toHaveBeenCalledTimes(1);
    await session.prompt("Try once more.");
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally { session.dispose(); }
});

it("keeps a content refusal as fixed metadata and stops before another endpoint", async () => {
  const s = await setup();
  s.models.setColumnTask(s.ada.id, "general", "image.create", [s.ref, s.workstation.ref]);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: "content_policy_violation", message: "synthetic provider text" } }, { status: 400 })));
  const result = await s.run({ action: "create", prompt: "A garden", tier: "quality" });
  expect(result).toMatchObject({ isError: true, details: { imageRefusal: { code: "image_refusal", offeringId: s.ref.offeringId } } });
  expect(JSON.stringify(result)).not.toContain("synthetic provider text");
  expect(s.workstation.server.images).toHaveLength(0);
  const next = s.models.nextImageModel(s.ctx(), "create", { imageTier: "quality" }, s.models.offering(s.ada.id, s.ref.offeringId)!.endpoint.id);
  expect(next?.ref).toEqual(s.workstation.ref);
  s.context({ overrides: { "image.create": [s.workstation.ref] } });
  expect((await s.run({ action: "create", prompt: "A garden", tier: "quality" })).details).toHaveProperty("image");
});

it("Try follows named presets and tier rules, and never offers cloud in restricted contexts", async () => {
  const s = await setup();
  const ep = s.models.offering(s.ada.id, s.ref.offeringId)!.endpoint;
  const sameEndpoint = { offeringId: s.models.addModel(s.ada, ep.id, { modelId: "other-art", image: true }).id };
  s.models.setColumnTask(s.ada.id, "general", "image.create", [s.ref, sameEndpoint, s.workstation.ref, s.spare.ref]);
  s.models.setCapabilities(s.ada, s.workstation.ref.offeringId, { useFor: "fast" });
  const preset = s.models.addPreset(s.ada.id, { name: "Pictures", scope: "general" }, "general");
  s.context({ preset: preset.id });
  expect(s.models.nextImageModel(s.ctx({ preset: preset.id }), "create", { imageTier: "quality" }, ep.id)?.ref).toEqual(s.spare.ref);
  for (const restricted of [{ pool: "private" as const }, { localOnly: true }]) {
    s.models.setColumnTask(s.ada.id, "private", "image.create", [s.workstation.ref, s.spare.ref]);
    expect(s.models.nextImageModel(s.ctx(restricted), "create", { imageTier: "fast" }, s.workstation.ep.id)?.endpoint.kind).toBe("local");
    expect(s.models.nextImageModel(s.ctx(restricted), "create", { imageTier: "quality" }, s.spare.ep.id)).toBeUndefined();
  }
  expect(s.models.nextImageModel(s.ctx({ fallback: false }), "create", {}, ep.id)).toBeUndefined();
});

it("Try skips a maskless plan for masked edits and skips cloud endpoints for forbidden portraits", async () => {
  const s = await setup();
  const plan = s.models.addPlan(s.ada, { name: "plan", plan: "chatgpt", credential: { access: "fake-plan", refresh: "fake-refresh", expires: Date.now() + 3600000 } });
  const planRef = { offeringId: s.models.addModel(s.ada, plan.id, { modelId: "chatgpt-images", image: true, edit: true }).id };
  s.models.setColumnTask(s.ada.id, "general", "image.edit", [s.ref, planRef, s.workstation.ref]);
  const after = s.models.offering(s.ada.id, s.ref.offeringId)!.endpoint.id;
  expect(s.models.nextImageModel(s.ctx(), "edit", {}, after)?.ref).toEqual(planRef);
  expect(s.models.nextImageModel(s.ctx(), "edit", { imageMask: true }, after)?.ref).toEqual(s.workstation.ref);
  expect(s.models.nextImageModel(s.ctx(), "edit", {}, after, true)?.ref).toEqual(s.workstation.ref);
  expect(s.heard).toEqual([]);
});

describe("image tool: rejected attempts", () => {
  it("rejects attempts without a model call, picks one back as an image part, and clears the rest", async () => {
    const s = await setup(); s.context({ localOnly: true });
    const made = async () => ((await s.run({ action: "create", prompt: "A garden", tier: "fast" })).details as { image: { paths: string[] } }).image.paths[0]!;
    const a = await made(), b = await made();
    const rejected = await s.run({ action: "reject", images: [a, b] });
    expect(rejected.details).toEqual({ rejected: [a, b].map(p => p.replace("/images/", "/images/rejected/")) });
    expect(readdirSync(join(s.folder, "images", "rejected"))).toHaveLength(2);
    const picked = await s.run({ action: "pick", image: a });
    expect(picked.details).toEqual({ image: { type: "image", paths: [a], model: "", picked: true } });
    await expect(s.run({ action: "reject", images: [] })).rejects.toThrow(/reject needs images/);
    expect((await s.run({ action: "clear_rejected" })).content[0]).toMatchObject({ text: "Deleted 1 rejected image for good." });
    expect(readdirSync(join(s.folder, "images"))).toEqual([a.split("/").at(-1)]);
  });
});

describe("image tool: asking after a few rejects", () => {
  it("nudges her to ask the person on the eighth rejected attempt in a turn, and starts over next turn", async () => {
    const s = await setup(); s.context({ localOnly: true });
    let turn = () => {};
    let tool!: ToolDefinition;
    createImageExtension(s.options)({ on: (e: string, f: () => void) => { if (e === "agent_start") turn = f; }, registerTool: (t: ToolDefinition) => { tool = t; } } as unknown as ExtensionAPI);
    const call = (args: unknown) => tool.execute("c", args, undefined, undefined, noUI);
    const made = async () => ((await call({ action: "create", prompt: "A garden", tier: "fast" })).details as { image: { paths: string[] } }).image.paths[0]!;
    const texts = (r: { content: { type: string; text?: string }[] }) => r.content.map(c => c.text);
    turn();
    const seven = []; for (let i = 0; i < 7; i++) seven.push(await made());
    expect(texts(await call({ action: "reject", images: seven }))).not.toContain(ASK_INSTEAD);
    // One rejected again doesn't count twice.
    expect(texts(await call({ action: "reject", images: [seven[0]!] }))).not.toContain(ASK_INSTEAD);
    expect(texts(await call({ action: "reject", images: [await made()] }))).toContain(ASK_INSTEAD);
    turn();
    expect(texts(await call({ action: "reject", images: [await made()] }))).not.toContain(ASK_INSTEAD);
  });
});
