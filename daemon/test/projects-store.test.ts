import { describe, expect, it } from "vitest";
import { Memory, Models, Users, WorkspaceSettings } from "@lyrica/core";
import { freshKeyring, profile } from "../../core/test/helpers.ts";
import { Projects } from "../src/projects.ts";

// Exercise encrypted project state without HTTP listeners or model requests.
async function setup() {
  const keyring = await freshKeyring();
  const users = new Users(keyring);
  const user = await users.createUser("ada", "pw", profile("Ada"), { admin: true });
  await users.authenticate("ada", "pw");
  const view = new Memory(keyring, users).openThreadView(user.id, "general");
  const db = users.openUserDb(user.id);
  return { keyring, users, user, view, projects: new Projects(users), ws: new WorkspaceSettings(db, () => ({ general: [], private: [] })),
    close: () => { view.close(); db.close(); keyring.self().close(); } };
}

describe("project welcome encrypted state", () => {
  it("keeps command rules through draft writes and discard without applying Goal or Instructions", async () => {
    const s = await setup();
    try {
      const chat = s.view.own.createThread({ interface: "web", project: true, goal: "Grow herbs" });
      const rules = [{ prefix: "npm test", decision: "ask" as const }];
      s.ws.setCommandRules("general", chat.id, rules);
      s.projects.set(s.user.id, "general", chat.id, { draftGoal: "Grow roses", draftInstructions: "Measure rainfall" });
      s.projects.set(s.user.id, "general", chat.id, { paused: true, watch: false });
      expect(new Projects(s.users).settings(s.user.id, "general", chat.id)).toMatchObject({ draftGoal: "Grow roses", draftInstructions: "Measure rainfall", paused: true, watch: false });
      expect(s.view.own.getThread(chat.id)?.goal).toBe("Grow herbs");
      expect(s.view.own.pageForProject(chat.id)?.instructions).toBeUndefined();
      s.projects.set(s.user.id, "general", chat.id, { draftGoal: null, draftInstructions: null });
      expect(s.projects.settings(s.user.id, "general", chat.id).draftGoal).toBeUndefined();
      expect(s.ws.commandRules("general", chat.id)).toEqual(rules);
      expect(s.view.own.getThread(chat.id)?.goal).toBe("Grow herbs");
    } finally { s.close(); }
  });

  it("moves existing work with its children, checklist and wake-ups, narrowing network access", async () => {
    const s = await setup();
    try {
      const project = s.view.own.createThread({ interface: "web", project: true });
      const source = s.view.own.createThread({ interface: "web" });
      const child = s.view.own.createThread({ interface: "web", parent: source.id, child: true });
      const steps = [{ text: "Sow seeds", state: "doing" as const }];
      s.view.own.setSteps(child.id, steps);
      const wake = s.view.own.addWakeup(child.id, "2026-10-14T10:00:00Z", "Check the soil");
      s.ws.setThread(project.id, "general", { internet: false, services: false, hosts: [] });
      s.ws.setThread(source.id, "general", { internet: true, services: true, hosts: ["127.0.0.1"] });
      const moved = s.view.own.foldThread(project.id, source.id);
      for (const id of moved) s.ws.reparent(id, project.id, "general");
      expect(moved).toEqual([source.id, child.id]);
      expect(s.view.own.getThread(child.id)).toMatchObject({ parent: project.id, child: true });
      expect(s.view.own.steps(child.id)).toEqual(steps);
      expect(s.view.own.wakeups(child.id)).toEqual([expect.objectContaining({ id: wake })]);
      expect(s.ws.network(source.id, "general")).toEqual({ internet: false, services: false, hosts: [] });
      expect(() => s.view.own.foldThread(project.id, child.id)).toThrow(/top-level/);
    } finally { s.close(); }
  });

  it("copies a named private preset and local-only context without calling a model", async () => {
    const s = await setup();
    try {
      const models = new Models(s.keyring, s.users);
      const source = s.view.own.createThread({ interface: "web" });
      const project = s.view.own.createThread({ interface: "web", project: true });
      const preset = models.addPreset(s.user.id, { name: "Garden models", scope: "private" }, "private");
      models.setLocalOnly(s.user.id, "general", source.id, true);
      models.setThreadPreset(s.user.id, "general", source.id, preset.id);
      const context = models.callContext(s.user.id, "general", source.id);
      expect(models.inheritContext(context, project.id)).toMatchObject({ preset: preset.id, localOnly: true });
    } finally { s.close(); }
  });
});
