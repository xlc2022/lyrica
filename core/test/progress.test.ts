import { describe, expect, it } from "vitest";
import { withProgress, type JobProgress } from "../src/models/progress.ts";

const json = (status: number, body?: object) => new Response(body ? JSON.stringify(body) : null, { status, headers: { "content-type": "application/json" } });
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("a host job's progress", () => {
  it("tags the job, reports each change while it runs, and stops reading when it ends", async () => {
    const answers = [json(200, { state: "queued", progress: null }), json(200, { state: "running", progress: 0.2 }), json(200, { state: "running", progress: 0.2 }), json(200, { state: "running", progress: 0.5 })];
    const asked: string[] = [];
    const fetch = (async (url: string) => { asked.push(url); return answers.shift() ?? json(404, { error: { code: "not_found" } }); }) as typeof globalThis.fetch;
    const seen: JobProgress[] = [];
    let tag: Record<string, string> = {};
    const out = await withProgress({ fetch, baseUrl: "https://h" }, (p) => seen.push(p), async (headers) => { tag = headers; await tick(60); return "made"; }, 5);
    expect(out).toBe("made");
    expect(tag["x-lyrica-job"]).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(asked[0]).toBe(`https://h/host/v1/jobs/${tag["x-lyrica-job"]}`);
    expect(seen).toEqual([{ queued: true }, { queued: false, progress: 0.2 }, { queued: false, progress: 0.5 }]);
    const after = asked.length;
    await tick(30);
    expect(asked.length).toBe(after);
  });

  it("leaves a host that never knows the job alone after a few reads, and runs untagged without a listener", async () => {
    let reads = 0;
    const fetch = (async () => { reads++; return json(404, { error: { code: "not_found" } }); }) as typeof globalThis.fetch;
    await withProgress({ fetch, baseUrl: "https://h" }, () => {}, () => tick(100), 5);
    expect(reads).toBe(5);
    let tag: Record<string, string> | undefined;
    await withProgress({ fetch, baseUrl: "https://h" }, undefined, async (h) => { tag = h; });
    expect(tag).toEqual({});
  });
});
