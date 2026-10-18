import { describe, expect, it } from "vitest";
import { toolCards } from "./tool-cards.ts";

const forks = [
  "The old backups are on the test disk. Delete them permanently or move them to an archive? Ask me to choose first.",
  "The garden guide can become a printed booklet or an interactive page. Ask which goal I want before starting.",
  "The draft can be published publicly or kept private. Ask me before publishing anything.",
];
const plain = ["What is a backup?", "How many sides has a triangle?", "What does an archive mean?"];
const card = { action: "ask", question: "Which path?", options: [{ label: "Archive", consequence: "Keeps the files." }, { label: "Delete", consequence: "Removes the files." }], recommended: 0 };
describe("question card", () => {
  it("records first validation, one correction, and plain answers with a fake model", async () => {
    const m = await toolCards();
    for (const request of forks) {
      m.cloud.reply({ tools: [{ name: "threads", args: { ...card, options: "bad" } }] });
      m.cloud.reply({ tools: [{ name: "threads", args: { ...card, options: JSON.stringify(card.options) } }] });
      const result = await m.run(request, "ask");
      expect(result.first?.valid).toBe(false);
      expect(result.corrected?.valid).toBe(true);
    }
    for (const request of plain) { m.cloud.reply({ text: "A short answer." }); expect((await m.run(request, "ask")).attempts).toEqual([]); }
  });
  it.skipIf(!process.env.LYRICA_EVAL_BASE_URL || !process.env.LYRICA_EVAL_MODEL)("records optional model evidence", async () => {
    const m = await toolCards(true);
    for (const request of [...forks, ...plain]) console.log({ expected: forks.includes(request), ...await m.run(request, "ask") });
  }, 300_000);
});
