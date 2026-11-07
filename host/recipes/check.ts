// Checks each starter part against its hub: the file exists and its SHA-256
// is the one pinned here. Run in CI (it needs the internet):
//   node host/recipes/check.ts          report, and fail on a mismatch or a missing pin
//   node host/recipes/check.ts --write  fill in missing pins from the hub
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const dir = new URL(".", import.meta.url).pathname;
const write = process.argv.includes("--write");
let failed = false;
type Tree = { path: string; lfs?: { oid: string; size: number } }[];
const trees = new Map<string, Tree>();

async function huggingFace(repo: string): Promise<Tree> {
  const res = await fetch(`https://huggingface.co/api/models/${repo}/tree/main?recursive=true`);
  return res.ok ? ((await res.json()) as Tree) : [];
}

// Civitai's files as host/src/fetch/hubs.ts lists them: <version>/<file name>, with Civitai's SHA-256.
async function civitai(model: string): Promise<Tree> {
  const res = await fetch(`https://civitai.com/api/v1/models/${model}`);
  if (!res.ok) return [];
  const body = (await res.json()) as { modelVersions?: { id: number; files?: { name: string; sizeKB: number; hashes?: { SHA256?: string } }[] }[] };
  return (body.modelVersions ?? []).flatMap((v) => (v.files ?? []).map((x) => ({
    path: `${v.id}/${x.name}`,
    lfs: { oid: (x.hashes?.SHA256 ?? "").toLowerCase(), size: Math.round(x.sizeKB * 1024) },
  })));
}

for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  const starter = JSON.parse(readFileSync(dir + f, "utf8"));
  for (const p of starter.parts) {
    const key = `${p.source} ${p.repo}`;
    if (!trees.has(key)) trees.set(key, p.source === "civitai" ? await civitai(p.repo) : await huggingFace(p.repo));
    const hub = trees.get(key)!.find((x) => x.path === p.path)?.lfs;
    const line = `${f}: ${p.source === "civitai" ? "civitai:" : ""}${p.repo}/${p.path}`;
    if (!hub) {
      console.log(`MISSING ${line}`);
      // A Civitai model's files, to pick the right one from.
      if (p.source === "civitai") for (const x of trees.get(key)!) console.log(`  has ${x.path} sha256=${x.lfs?.oid} size=${x.lfs?.size}`);
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
