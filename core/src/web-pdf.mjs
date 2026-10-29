// A PDF's text, read in a child process of lyricad (core/src/web.ts, pdfText),
// which kills it past a time and memory limit: pdf.js decodes streams outside
// the JS heap, so a hostile file must not share lyricad's memory. It gets the
// file's bytes as its one IPC message and answers { title, pages, text } or
// { error }, then exits.
import { extractText, getDocumentProxy, getMeta } from "unpdf";

process.once("message", async (bytes) => {
  let answer;
  try {
    const pdf = await getDocumentProxy(new Uint8Array(bytes), { isEvalSupported: false, disableFontFace: true, verbosity: 0 });
    const { info } = await getMeta(pdf).catch(() => ({ info: {} }));
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    const title = typeof info?.Title === "string" ? info.Title.trim() : "";
    answer = { title, pages: totalPages, text: text.map((t) => t.trim()) };
  } catch (err) {
    answer = { error: err instanceof Error ? err.message : String(err) };
  }
  process.send(answer, () => process.exit(0));
});
