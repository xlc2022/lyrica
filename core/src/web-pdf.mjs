// A PDF's text, read in a worker thread so a large or hostile file can't stall
// lyricad (core/src/web.ts, pdfText). workerData is the file's bytes; it
// posts { title, pages, text } or { error }.
import { parentPort, workerData } from "node:worker_threads";
import { extractText, getDocumentProxy, getMeta } from "unpdf";

try {
  const pdf = await getDocumentProxy(new Uint8Array(workerData), { isEvalSupported: false, disableFontFace: true, verbosity: 0 });
  const { info } = await getMeta(pdf).catch(() => ({ info: {} }));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const title = typeof info?.Title === "string" ? info.Title.trim() : "";
  parentPort.postMessage({ title, pages: totalPages, text: text.map((t) => t.trim()) });
} catch (err) {
  parentPort.postMessage({ error: err instanceof Error ? err.message : String(err) });
}
