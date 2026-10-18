import { describe, expect, it } from "vitest";
import { toolCards } from "./tool-cards.ts";

const jobs = ["Plan and build a garden irrigation controller, then verify it. Keep a checklist as you start.", "Migrate a fictional library catalogue, validate the records, then write a report. Keep a checklist as you start.", "Prepare a long workshop: outline, exercises, slides and a rehearsal. Keep a checklist as you start."];
const quick = ["What is irrigation?", "What is a catalogue?", "What is a rehearsal?"];
describe("checklist", () => {
  it("records early calls, validation and correction with a fake model", async () => {
    const m = await toolCards();
    for (const request of jobs) {
      m.cloud.reply({ tools: [{ name: "threads", args: { action: "steps", steps: [{ text: "Plan", state: "wrong" }] } }] });
      m.cloud.reply({ tools: [{ name: "threads", args: { action: "steps", steps: [{ text: "Plan", state: "doing" }] } }] });
      const result = await m.run(request, "steps");
      expect(result.first).toMatchObject({ valid: false, position: 1, response: 1 });
      expect(result.corrected?.valid).toBe(true);
    }
    for (const request of quick) { m.cloud.reply({ text: "A short answer." }); expect((await m.run(request, "steps")).attempts).toEqual([]); }
  });
  it.skipIf(!process.env.LYRICA_EVAL_BASE_URL || !process.env.LYRICA_EVAL_MODEL)("records optional model evidence", async () => {
    const m = await toolCards(true);
    for (const request of [...jobs, ...quick]) console.log({ expected: jobs.includes(request), ...await m.run(request, "steps") });
  }, 300_000);
});
