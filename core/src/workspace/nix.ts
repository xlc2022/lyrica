import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Nix in her sandbox (docs/workspace.md, "Nix"). Each user's pool keeps a
 * Nix store in the home workspace, mounted read-write at /nix in every run
 * of that pool's threads, so what she builds or downloads lasts between
 * commands. The `nix` program and its closure come with the sandbox's
 * tools: on NixOS in their closure, already mounted read-only at their
 * /nix/store paths; on Debian and Ubuntu as the official binary tarball
 * install.sh unpacks into the tool prefix, whose store paths are mounted
 * read-only the same way. Either way the store's database gets those paths
 * registered and rooted once (`seed`), so Nix treats them as its own and
 * garbage collection never reaches them.
 */
export interface NixTools {
  /** Host folder to mount read-only at each /nix/store path: the tarball's store on Debian; none on NixOS, where the closure is mounted already. */
  binds: [host: string, dest: string][];
  /** The store paths to register and root: the tools' closure, or the tarball's. */
  roots: string[];
  /** Host file in `nix-store --load-db` format registering `roots`. */
  registration: string;
  /** Where `nix` is when it isn't in the tools' bin: the tarball's Nix, added to the end of the PATH. */
  bin?: string;
}

/** Where install.sh unpacks the official Nix binary tarball on Debian and Ubuntu, under the tool prefix. */
export const NIX_TARBALL = "lib/nix";

const STORE = /^[0-9a-z]{32}-[^/]+$/;

/**
 * The Nix this host gives her sandboxes, or undefined when it has none. On
 * NixOS: `nix` among the sandbox tools, with the closure's registration
 * beside its store-paths file. On Debian: the tarball in `prefix/lib/nix`
 * (its `.reginfo`, its `store` and the Nix its `install` script names).
 */
export function nixTools(env: { tools?: string; closure?: string; paths?: string[]; prefix: string }): NixTools | undefined {
  if (env.tools) {
    if (!existsSync(join(env.tools, "bin", "nix")) || !env.closure || !env.paths) return undefined;
    const registration = join(dirname(env.closure), "registration");
    return existsSync(registration) ? { binds: [], roots: env.paths, registration } : undefined;
  }
  const dir = join(env.prefix, NIX_TARBALL);
  try {
    const registration = join(dir, ".reginfo");
    const nix = /^nix="(\/nix\/store\/[0-9a-z]{32}-[^/"]+)"$/m.exec(readFileSync(join(dir, "install"), "utf8"))?.[1];
    const names = readdirSync(join(dir, "store")).filter((n) => STORE.test(n));
    if (!nix || !existsSync(registration) || !names.includes(nix.slice("/nix/store/".length))) return undefined;
    return {
      binds: names.map((n) => [join(dir, "store", n), `/nix/store/${n}`]),
      roots: names.map((n) => `/nix/store/${n}`),
      registration,
      bin: `${nix}/bin`,
    };
  } catch { return undefined; }
}

const seen = new Map<string, { at: number; id: string; text: string }>();
/** The registration's text and an id for it (its hash), read again only when the file changes. */
export function registration(file: string): { id: string; text: string } {
  const at = statSync(file).mtimeMs;
  const got = seen.get(file);
  if (got?.at === at) return got;
  const text = readFileSync(file, "utf8");
  const entry = { at, id: createHash("sha256").update(text).digest("hex"), text };
  seen.set(file, entry);
  return entry;
}

/** Where the store records which registration it has: `${store}/${REGISTERED}` on the host. */
export const REGISTERED = "var/lyrica/registered";

/**
 * Registers the tools' store paths in the store and roots them, once per
 * registration (its id is $1, the paths the rest, the registration on
 * stdin). `nix-store --verify` first drops paths an update took away, so
 * the database never claims a path the sandbox no longer has. A lock keeps
 * two first runs from doing it at once.
 */
export const SEED = [
  "set -eu",
  'id=$1; shift',
  "mkdir -p /nix/store /nix/var/nix/gcroots /nix/var/lyrica",
  "exec 9>/nix/var/lyrica/lock",
  "flock 9",
  `[ "$(cat /nix/${REGISTERED} 2>/dev/null)" = "$id" ] && exit 0`,
  "nix-store --verify >/dev/null 2>&1 || true",
  "nix-store --load-db",
  "roots=/nix/var/nix/gcroots/lyrica",
  'rm -rf "$roots.new"; mkdir "$roots.new"',
  'for p; do ln -s "$p" "$roots.new/${p#/nix/store/}"; done',
  'rm -rf "$roots"; mv "$roots.new" "$roots"',
  `printf '%s\\n' "$id" > /nix/${REGISTERED}`,
].join("\n");

/**
 * Nix's settings in every run with a store: flakes on; a single-user store
 * (no build users or daemon); Nix's own build sandbox where the kernel lets
 * it nest one (it falls back when it can't). Her own nix.conf, under
 * $XDG_CONFIG_HOME or ~/.config/nix, adds to them.
 */
export const NIX_CONFIG = ["experimental-features = nix-command flakes", "build-users-group =", "sandbox = true", "sandbox-fallback = true"].join("\n");
