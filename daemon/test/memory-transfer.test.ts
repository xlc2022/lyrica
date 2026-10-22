import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MemoryDetail, MemoryExport, MemoryImportResult, Skills, SkillsExport, SkillsImportResult } from "../src/api.ts";
import { browser, daemon, login, runtime } from "./helpers.ts";

/** Every file under `dir`, for checking nothing plain reached the disk. */
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f), st = statSync(p); return st.isDirectory() ? files(p) : st.isFile() ? [p] : []; });

describe("export and import", () => {
  it("hands the export to the browser only, and imports it into the other user's own pool as theirs", async () => {
    const rt = await runtime();
    const dm = await daemon(rt);
    await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
    const ada = await login(dm.base, "ada", "pw");
    const sam = await login(dm.base, "sam", "pw2");
    const a = `/api/u/${rt.ada.id}`, s = `/api/u/${rt.sam.id}`;
    const note = (await ada.post<MemoryDetail>(`${a}/memory/private/notes`, { text: "{user} keeps marigold seeds in a tin" })).body;

    const out = await ada.post<MemoryExport>(`${a}/memory/export`, { items: [{ pool: "private", id: note.item.id }] });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ count: 1, skipped: 0, name: expect.stringMatching(/\.md$/) });
    expect(out.body.markdown).toContain("{user} keeps marigold seeds in a tin");
    // Nobody else's routes, and nothing written or logged.
    expect((await sam.post(`${a}/memory/export`, { items: [{ pool: "private", id: note.item.id }] })).status).toBe(401);
    expect(dm.logs.join("\n")).not.toContain("marigold");
    for (const f of files(rt.home)) expect(readFileSync(f).includes("marigold"), f).toBe(false);

    const imported = await sam.post<MemoryImportResult>(`${s}/memory/import`, { files: [{ name: "seeds.md", text: out.body.markdown }] });
    expect(imported.body).toMatchObject({ imported: [{ pool: "private", id: note.item.id }], duplicates: 0 });
    const theirs = (await sam.get<MemoryDetail>(`${s}/memory/private/${encodeURIComponent(note.item.id)}`)).body;
    expect(theirs.item).toMatchObject({ origin: "user", text: `[[u:${rt.sam.id}]] keeps marigold seeds in a tin` });
    // Again is a duplicate, and Ada's own memory is untouched.
    expect((await sam.post<MemoryImportResult>(`${s}/memory/import`, { files: [{ text: out.body.markdown }] })).body).toMatchObject({ imported: [], duplicates: 1 });
    expect((await ada.get<MemoryDetail>(`${a}/memory/private/${encodeURIComponent(note.item.id)}`)).body.item.text).toBe(`[[u:${rt.ada.id}]] keeps marigold seeds in a tin`);
    expect(dm.logs.join("\n")).not.toContain("marigold");
  });

  it("exports skills to the browser only, and imports them into the other user's own library as theirs", async () => {
    const rt = await runtime();
    const dm = await daemon(rt);
    await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
    const ada = await login(dm.base, "ada", "pw");
    const sam = await login(dm.base, "sam", "pw2");
    const a = `/api/u/${rt.ada.id}`, s = `/api/u/${rt.sam.id}`;
    await ada.post(`${a}/skills`, { name: "seed-saving", description: "When saving seeds.", body: "Dry the marigold heads first.", pool: "private" });
    const out = (await ada.post<SkillsExport>(`${a}/skills/export`, {})).body;
    expect(out).toMatchObject({ count: 1, name: "seed-saving.md" });
    expect(dm.logs.join("\n")).not.toContain("marigold");
    for (const f of files(rt.home)) expect(readFileSync(f).includes("marigold"), f).toBe(false);
    expect((await sam.post<SkillsImportResult>(`${s}/skills/import`, { files: [{ text: out.markdown }] })).body).toMatchObject({ imported: [{ pool: "private", name: "seed-saving" }] });
    expect((await sam.get<Skills>(`${s}/skills`)).body.skills).toMatchObject([{ name: "seed-saving", pool: "private", author: "user", state: "active" }]);
  });
});
