// Checks each starter part against its hub: the file exists and its SHA-256
// is the one pinned here. Run in CI (it needs the internet):
//   node host/recipes/check.ts          report, and fail on a mismatch or a missing pin
//   node host/recipes/check.ts --write  fill in missing pins from the hub
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const dir = new URL(".", import.meta.url).pathname;
const write = process.argv.includes("--write");
let failed = false;
const trees = new Map<string, { path: string; lfs?: { oid: string; size: number } }[]>();

for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  const starter = JSON.parse(readFileSync(dir + f, "utf8"));
  for (const p of starter.parts) {
    if (!trees.has(p.repo)) {
      const res = await fetch(`https://huggingface.co/api/models/${p.repo}/tree/main?recursive=true`);
      trees.set(p.repo, res.ok ? ((await res.json()) as { path: string; lfs?: { oid: string; size: number } }[]) : []);
    }
    const hub = trees.get(p.repo)!.find((x) => x.path === p.path)?.lfs;
    const line = `${f}: ${p.repo}/${p.path}`;
    if (!hub) {
      console.log(`MISSING ${line}`);
      failed = true;
    } else if (!/^[0-9a-f]{64}$/.test(hub.oid)) {
      // A gated repository hides its checksums from anonymous callers; the
      // host still checks the hub's checksum when it downloads with a token.
      console.log(`GATED ${line} (the hub hides its checksum)`);
    } else if (!p.sha256) {
      console.log(`UNPINNED ${line} sha256=${hub.oid} size=${hub.size}`);
      if (write) p.sha256 = hub.oid;
      else failed = true;
    } else if (p.sha256 !== hub.oid) {
      console.log(`MISMATCH ${line} pinned=${p.sha256} hub=${hub.oid}`);
      failed = true;
    } else console.log(`ok ${line}`);
    if (hub) p.size = hub.size;
  }
  if (write) writeFileSync(dir + f, JSON.stringify(starter, null, 2) + "\n");
}
process.exit(failed ? 1 : 0);
