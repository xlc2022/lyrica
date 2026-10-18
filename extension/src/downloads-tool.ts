import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Downloading models when asked (docs/models.md, "Downloads"): `model_files`
// reads what a repository on Hugging Face or ModelScope offers, as a model
// host sees it, and `download_model` starts downloads to that host. A download
// changes the host and goes out to the internet, so it always asks on the
// approval card first. lyricad registers these only in general threads, for a
// user who can manage a host: the repository's name leaves the host, so
// private and local-only threads never have them.

type Hub = "huggingface" | "modelscope";

/** A host she may download to. */
export interface DownloadHost { id: string; name: string }

/** A repository's files as a host sees them (host/API.md, "GET /host/v1/hub/files"). */
export interface HubListing {
  repo: string;
  gated: boolean;
  free: number;
  files: { path: string; size: number; allowed: boolean; present: boolean; fits: boolean }[];
}

export interface DownloadsHost {
  /** The hosts the person can manage. Empty in a thread that has become private or local-only. */
  hosts(): DownloadHost[];
  files(hostId: string, source: Hub, repo: string): Promise<HubListing>;
  /** Starts one download per file; a gated repository uses the person's saved token. */
  start(hostId: string, source: Hub, repo: string, files: string[]): Promise<void>;
}

/** A vision projector or an MTP draft: a file that goes with a model, as the host tells them. */
export function companionKind(path: string): "vision" | "mtp" | undefined {
  const parts = path.split("/");
  const name = parts[parts.length - 1]!.toLowerCase();
  if (name.includes("mmproj")) return "vision";
  if (/^mtp[-_.]/.test(name) || parts.slice(0, -1).some((p) => p.toLowerCase() === "mtp")) return "mtp";
  return undefined;
}

const SHARD = /-\d{5}-of-\d{5}\.gguf$/i;
const stem = (p: string) => (p.split("/").pop() ?? p).toLowerCase().replace(SHARD, "").replace(/\.gguf$/, "").replace(/^mtp[-_.]/, "");
function shared(a: string, b: string): number {
  let head = 0, tail = 0;
  while (head < a.length && a[head] === b[head]) head++;
  while (tail < a.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return head + tail;
}

/**
 * The files to download for what she named: a split GGUF's every shard, and,
 * with a model GGUF, its vision projector (F16 or BF16 first) and the MTP
 * draft closest to its name, as the Download text model page ticks them.
 * Files already on the host are left out.
 */
export function filesFor(listing: HubListing, named: string[], companions = true): string[] {
  const usable = listing.files.filter((f) => f.allowed && !f.present);
  const out = new Set<string>();
  for (const name of named) {
    const prefix = SHARD.test(name) ? name.replace(SHARD, "") : null;
    for (const f of usable) if (f.path === name || (prefix && f.path.replace(SHARD, "") === prefix && SHARD.test(f.path))) out.add(f.path);
  }
  const models = [...out].filter((p) => p.toLowerCase().endsWith(".gguf") && !companionKind(p));
  if (companions && models.length) {
    const vision = usable.filter((f) => companionKind(f.path) === "vision");
    const projector = vision.find((f) => /bf16|f16/i.test(f.path)) ?? vision[0];
    if (projector) out.add(projector.path);
    for (const m of models) {
      const draft = usable.filter((f) => companionKind(f.path) === "mtp").sort((a, b) => shared(stem(b.path), stem(m)) - shared(stem(a.path), stem(m)))[0];
      if (draft) out.add(draft.path);
    }
  }
  return [...out];
}

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], details: undefined, ...(isError ? { isError: true } : {}) });
const GB = 2 ** 30;

/** The host she named, or the only one; otherwise a message naming the ones there are. */
function pickHost(host: DownloadsHost, name: string | undefined): DownloadHost | string {
  const all = host.hosts();
  if (!all.length) return "There is no model host you can manage here.";
  const found = name ? all.find((h) => h.name.toLowerCase() === name.trim().toLowerCase()) : all.length === 1 ? all[0] : undefined;
  if (found) return found;
  return `${name ? `${name} isn't one of the hosts. ` : ""}Ask which host to download to: ${all.map((h) => h.name).join(", ")}.`;
}

const PARAMS = {
  host: Type.Optional(Type.String({ description: "The model host's name. Leave it out when there is only one; with more, ask the person which." })),
  source: Type.Optional(Type.Union([Type.Literal("huggingface"), Type.Literal("modelscope")], { description: "huggingface unless the person named ModelScope." })),
  repo: Type.String({ description: "The repository: owner/name, or its page's link." }),
};

const repoName = (text: string) => text.trim()
  .replace(/^https?:\/\/(www\.)?(huggingface\.co|hf\.co|modelscope\.cn)\//i, "").replace(/^models\//, "")
  .replace(/[?#].*$/, "").replace(/\/(tree|blob|resolve|files|summary)(\/.*)?$/, "").replace(/\/+$/, "");

export function createDownloadsExtension(host: DownloadsHost): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: "model_files",
      label: "Model files",
      description: "Lists the files a Hugging Face or ModelScope repository offers, as a model host sees them: each file's size, "
        + "whether it is already on the host and fits, and which are a vision projector or an MTP file.",
      promptSnippet: "see which files a model repository offers before downloading one to a model host",
      // Reads the internet through the host; changes nothing.
      annotations: { openWorldHint: true, readOnlyHint: true },
      parameters: Type.Object(PARAMS),
      async execute(_id, p) {
        const h = pickHost(host, p.host);
        if (typeof h === "string") return text(h, true);
        try {
          const listing = await host.files(h.id, p.source ?? "huggingface", repoName(p.repo));
          return text(JSON.stringify({
            host: h.name, repo: listing.repo, gated: listing.gated, freeGB: +(listing.free / GB).toFixed(1),
            files: listing.files.filter((f) => f.allowed).map((f) => ({
              path: f.path, sizeGB: +(f.size / GB).toFixed(2), ...(f.present ? { present: true } : {}), ...(!f.fits ? { fits: false } : {}),
              ...(companionKind(f.path) ? { kind: companionKind(f.path) } : {}),
            })),
          }));
        } catch (err) {
          return text((err as Error).message, true);
        }
      },
    });
    pi.registerTool({
      name: "download_model",
      label: "Download model",
      description: "Downloads files from a Hugging Face or ModelScope repository to a model host. With a GGUF model it also downloads its vision projector "
        + "and MTP file, and every part of a split one. The person allows it on a card first. Progress shows on the Models page's Downloads.",
      promptSnippet: "download a model to a model host when the person asks",
      promptGuidelines: [
        "Look the repository up with model_files first, and pick the quant the person asked for; if they didn't say, ask, naming two or three that fit.",
        "With more than one model host and none named, ask which one before downloading.",
      ],
      // Goes out to the internet and fills the host's disk: it always asks.
      annotations: { openWorldHint: true, readOnlyHint: false },
      parameters: Type.Object({
        ...PARAMS,
        files: Type.Array(Type.String(), { description: "The files to download, by path as model_files lists them. For a split GGUF, any one part." }),
        companions: Type.Optional(Type.Boolean({ description: "false to leave out the vision projector and MTP file." })),
      }),
      async execute(_id, p) {
        const h = pickHost(host, p.host);
        if (typeof h === "string") return text(h, true);
        const source = p.source ?? "huggingface";
        try {
          const listing = await host.files(h.id, source, repoName(p.repo));
          const files = filesFor(listing, p.files, p.companions !== false);
          if (!files.length) return text("None of those files can be downloaded to this host: they aren't in the repository, aren't allowed, or are there already.", true);
          const size = files.reduce((n, f) => n + (listing.files.find((x) => x.path === f)?.size ?? 0), 0);
          if (size > listing.free) return text(`Those files need ${(size / GB).toFixed(1)} GB; ${h.name} has ${(listing.free / GB).toFixed(1)} GB free.`, true);
          await host.start(h.id, source, listing.repo, files);
          return text(JSON.stringify({ started: files, host: h.name, sizeGB: +(size / GB).toFixed(1) }));
        } catch (err) {
          return text((err as Error).message, true);
        }
      },
    });
  };
}
