/**
 * Installing a clone's dependencies (docs/workspace.md, "Dependencies"): after
 * `cloneFor` clones or fetches a repository, this runs in the thread's sandbox
 * in the clone, so her checks find the packages they need. The project's setup
 * command wins; without one the lockfile picks the install. It runs again only
 * when the command or a lockfile changes: `.git/lyrica-setup` holds a hash of
 * both from the last install that succeeded.
 */

/** Install scripts stay skipped: node-gyp can't build in the sandbox's user namespace, and nothing needs them. */
export const DEFAULT_SETUPS: readonly { lockfile: string; command: string }[] = [
  { lockfile: "package-lock.json", command: "npm ci --ignore-scripts --no-audit --no-fund" },
  { lockfile: "npm-shrinkwrap.json", command: "npm ci --ignore-scripts --no-audit --no-fund" },
  { lockfile: "pnpm-lock.yaml", command: "pnpm install --frozen-lockfile --ignore-scripts" },
  { lockfile: "yarn.lock", command: "yarn install --frozen-lockfile --ignore-scripts" },
  { lockfile: "uv.lock", command: "uv sync --frozen" },
  { lockfile: "requirements*.txt", command: 'python3 -m venv .venv && for f in requirements*.txt; do .venv/bin/pip install -q -r "$f" || exit 1; done' },
];

const sq = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/**
 * `sh -c SETUP_SCRIPT sh <clone> <setup command or ""> <hash to skip or "">`.
 * It names the command and the hash on stderr first ("lyrica-setup <hash> <command>"),
 * then the install's own output; "lyrica-setup-same" means the hash was the one
 * to skip, so nothing ran. Exits 0 with nothing to install, or when the
 * last install is still current.
 */
export const SETUP_SCRIPT = `cd "$1" || exit 0
cmd=$2
if [ -z "$cmd" ]; then
${DEFAULT_SETUPS.map((d, i) => {
  const test = d.lockfile.includes("*") ? `ls ${d.lockfile} >/dev/null 2>&1` : `[ -f ${d.lockfile} ]`;
  // Yarn 2 and later name the same install differently.
  const command = d.lockfile === "yarn.lock" ? `$( [ -f .yarnrc.yml ] && echo ${sq("yarn install --immutable --mode=skip-build")} || echo ${sq(d.command)} )` : sq(d.command);
  return `  ${i ? "elif" : "if"} ${test}; then cmd=${command}`;
}).join("\n")}
  else exit 0; fi
fi
key=$( { printf '%s\\n' "$cmd"; cat ${[...new Set(DEFAULT_SETUPS.map((d) => d.lockfile))].join(" ")} 2>/dev/null; } | sha256sum | cut -c1-64)
echo "lyrica-setup $key $cmd" >&2
if [ "$key" = "$3" ]; then echo lyrica-setup-same >&2; exit 0; fi
if [ "$(cat .git/lyrica-setup 2>/dev/null)" = "$key" ] && { [ -n "$2" ] || [ -d node_modules ] || [ -d .venv ]; }; then exit 0; fi
sh -c "$cmd" >&2 || exit $?
printf '%s\\n' "$key" > .git/lyrica-setup
`;

/** How one run of SETUP_SCRIPT went. */
export type SetupOutcome =
  | { kind: "none" }
  | { kind: "same"; key: string }
  | { kind: "failed"; key: string; problem: string };

/**
 * Reads a run of SETUP_SCRIPT: a failure is one plain line for her prompt,
 * naming the command, its exit code and its last lines, with the run's secrets masked.
 */
export function setupOutcome(repo: string, out: { code: number | null; stderr: string }, mask: (s: string) => string): SetupOutcome {
  const head = /^lyrica-setup ([0-9a-f]{64}) (.*)$/m.exec(out.stderr);
  if (!head) return out.code === 0 ? { kind: "none" } : { kind: "failed", key: "", problem: `${repo}: dependencies didn't install: ${mask(lastLines(out.stderr)) || `exit code ${out.code}`}` };
  const [, key, command] = head as unknown as [string, string, string];
  const rest = out.stderr.slice(head.index + head[0].length);
  if (/^lyrica-setup-same$/m.test(rest)) return { kind: "same", key };
  if (out.code === 0) return { kind: "none" };
  const missing = out.code === 127 ? ", a program it needs isn't installed in the sandbox" : "";
  const tail = mask(lastLines(rest));
  return { kind: "failed", key, problem: `${repo}: dependencies didn't install (\`${mask(command)}\` exited ${out.code}${missing})${tail ? `. Its last lines:\n${tail}` : "."}` };
}

/** The last 20 lines, each cut to 300 characters and indented under the problem's line. */
function lastLines(text: string): string {
  return text.trimEnd().split("\n").filter((l) => l.trim()).slice(-20).map((l) => `    ${l.slice(0, 300)}`).join("\n");
}
