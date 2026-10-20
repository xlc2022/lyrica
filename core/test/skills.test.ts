import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openEncrypted, SKILL_LIMITS, WorkspaceSettings } from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scratchDb = () => { const dir = mkdtempSync(join(tmpdir(), "lyrica-skills-")); dirs.push(dir); return openEncrypted(join(dir, "user.db"), { raw: Buffer.alloc(32, 7) }); };

function library() {
  const db = scratchDb();
  migrate(db, "user");
  return new WorkspaceSettings(db, () => ({ general: [], private: [] })).skills;
}
const draft = (name: string, body = "Do it.") => ({ name, description: `When ${name} comes up.`, body });

describe("skills", () => {
  it("keep her draft waiting beside the active skill until the person approves it, or decline it", () => {
    const s = library();
    s.put(draft("release", "v1"));
    const waiting = s.propose(draft("release", "v2"), "general", "web/t1", "call-1");
    expect(waiting.state).toBe("waiting");
    expect(s.read("general", "release")?.body).toBe("v1");
    expect(s.byCall("call-1")?.state).toBe("waiting");
    s.approve("general", "release");
    expect(s.read("general", "release")?.body).toBe("v2");
    expect(s.active("general")).toHaveLength(1);
    s.propose(draft("release", "v3"), "general", "web/t1", "call-2");
    s.decline("general", "release");
    expect(s.byCall("call-2")?.state).toBe("declined");
    expect(s.read("general", "release")?.body).toBe("v2");
    expect(() => s.approve("general", "release")).toThrow(/waiting/);
  });

  it("make her drafts active at once when the person turned on auto-approve", () => {
    const s = library();
    s.setAutoApprove(true);
    expect(s.propose(draft("ci-fix"), "general", "web/t1", "c").state).toBe("active");
    expect(s.read("general", "ci-fix")).toBeDefined();
  });

  it("list a Private thread's skills only in Private threads", () => {
    const s = library();
    s.put(draft("everywhere"));
    s.setAutoApprove(true);
    s.propose(draft("secret-recipe"), "private", "private/t", "c");
    expect(s.active("general").map((x) => x.name)).toEqual(["everywhere"]);
    expect(s.active("private").map((x) => x.name)).toEqual(["everywhere", "secret-recipe"]);
    expect(s.read("general", "secret-recipe")).toBeUndefined();
  });

  it("refuse bad names, long fields and a full library", () => {
    const s = library();
    expect(() => s.put(draft("Release Notes"))).toThrow(/lowercase/);
    expect(() => s.put({ ...draft("a"), description: "x".repeat(201) })).toThrow(/200/);
    expect(() => s.put(draft("a", "x".repeat(SKILL_LIMITS.body + 1)))).toThrow(/8000/);
    for (let i = 0; i < SKILL_LIMITS.library; i++) s.put(draft(`s${i}`));
    expect(() => s.put(draft("one-more"))).toThrow(/at most 100/);
    s.put(draft("s0", "replaced"));
    s.remove("general", "s1");
    s.put(draft("one-more"));
  });
});
