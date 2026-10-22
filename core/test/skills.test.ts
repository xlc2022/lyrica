import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportSkills, importSkills, migrate, openEncrypted, SKILL_LIMITS, SkillLibrary, WorkspaceSettings } from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scratchDb = (file: string) => { const dir = mkdtempSync(join(tmpdir(), "lyrica-skills-")); dirs.push(dir); return openEncrypted(join(dir, file), { raw: Buffer.alloc(32, 7) }); };

function library(pool: "general" | "private" = "general") {
  const db = scratchDb(`${pool}.db`);
  migrate(db, "pool");
  return new SkillLibrary(db, pool);
}
const draft = (name: string, body = "Do it.") => ({ name, description: `When ${name} comes up.`, body });

describe("skills", () => {
  it("keep her draft waiting beside the active skill until the person approves it, or decline it", () => {
    const s = library();
    s.put(draft("release", "v1"));
    const waiting = s.propose(draft("release", "v2"), "web/t1", "call-1", false);
    expect(waiting).toMatchObject({ state: "waiting", pool: "general" });
    expect(s.read("release")?.body).toBe("v1");
    expect(s.byCall("call-1")?.state).toBe("waiting");
    s.approve("release");
    expect(s.read("release")?.body).toBe("v2");
    expect(s.active()).toHaveLength(1);
    s.propose(draft("release", "v3"), "web/t1", "call-2", false);
    s.decline("release");
    expect(s.byCall("call-2")?.state).toBe("declined");
    expect(s.read("release")?.body).toBe("v2");
    expect(() => s.approve("release")).toThrow(/waiting/);
  });

  it("make her drafts active at once when the person turned on auto-approve, a user.db setting", () => {
    const db = scratchDb("user.db");
    migrate(db, "user");
    const settings = new WorkspaceSettings(db, () => ({ general: [], private: [] }));
    expect(settings.skillsAutoApprove()).toBe(false);
    settings.setSkillsAutoApprove(true);
    const s = library();
    expect(s.propose(draft("ci-fix"), "web/t1", "c", settings.skillsAutoApprove()).state).toBe("active");
    expect(s.read("ci-fix")).toBeDefined();
  });

  it("refuse bad names, long fields and a full pool", () => {
    const s = library();
    expect(() => s.put(draft("Release Notes"))).toThrow(/lowercase/);
    expect(() => s.put({ ...draft("a"), description: "x".repeat(201) })).toThrow(/200/);
    expect(() => s.put(draft("a", "x".repeat(SKILL_LIMITS.body + 1)))).toThrow(/8000/);
    for (let i = 0; i < SKILL_LIMITS.library; i++) s.put(draft(`s${i}`));
    expect(() => s.put(draft("one-more"))).toThrow(/at most 100/);
    s.put(draft("s0", "replaced"));
    s.remove("s1");
    s.put(draft("one-more"));
  });
});

describe("skills export and import", () => {
  it("round-trips active skills by pool, as the person's, skipping duplicates and renaming clashes without replacing anything", () => {
    const from = { general: library(), private: library("private") };
    from.general.put(draft("release", "List what changed."));
    from.private.put(draft("diary", "Write it down."));
    from.general.propose(draft("waiting-one"), "web/t1", "call-1", false);
    const out = exportSkills([...from.general.all(), ...from.private.all()]);
    expect(out.count).toBe(2);
    expect(out.markdown).not.toContain("waiting-one");

    const to = { general: library(), private: library("private") };
    to.general.propose(draft("release", "Her own steps."), "web/t2", "call-2", false);
    const r = importSkills(to, [out.markdown]);
    expect(r).toMatchObject({ duplicates: 0, renamed: 1, skipped: 0 });
    expect(r.imported).toEqual([{ pool: "general", name: "release-2" }, { pool: "private", name: "diary" }]);
    expect(to.general.byCall("call-2")?.state).toBe("waiting");
    expect(to.private.read("diary")).toMatchObject({ author: "user", state: "active", body: "Write it down." });
    // Again: everything is already here.
    expect(importSkills(to, [out.markdown])).toMatchObject({ imported: [], duplicates: 2 });
    // Into one chosen pool, and a block that isn't a valid skill is skipped.
    const one = { general: library(), private: library("private") };
    const bad = "---\nlyrica: skill 1\nname: Not Valid\ndescription: x\n---\n\nsteps\n";
    expect(importSkills(one, [out.markdown, bad], "private")).toMatchObject({ imported: [{ pool: "private", name: "release" }, { pool: "private", name: "diary" }], skipped: 1 });
    expect(one.general.active()).toEqual([]);
  });

  it("takes credentials out of what it exports", () => {
    const s = library();
    s.put(draft("deploy", "Use the token ghp_abcdefghijklmnopqrstuvwxyz0123456789 to push."));
    expect(exportSkills(s.all()).markdown).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });
});
