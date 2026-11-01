import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory, Workspace, type ExecutionTarget, type ToolOps, type WorkspaceThread } from "@lyrica/core";
import { fakeOpenAI } from "../../core/test/fake-openai.ts";
import { afterEach, describe, expect, it } from "vitest";
import { withModels } from "../../core/test/helpers.ts";
import { CLAUDE_CODE_LINE, Delegation, type Request, type ThreadContext } from "../src/index.ts";
import { limited } from "../src/delegate/claude.ts";

// The claude role (docs/delegation.md, "Claude Code"): a subagent that is
// Claude Code in the parent's sandbox. A stand-in `claude` plays it: it reads
// the brief, writes the report, and prints Claude Code's JSON answer.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tempDir = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "lyrica-claude-delegate-"))); dirs.push(d); return d; };

/** The stand-in: what the brief or message asks decides what it does. */
const FAKE = `
const args = process.argv.slice(2);
const prompt = args[args.indexOf("-p") + 1];
const resume = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : "none";
const mode = args.includes("--permission-mode") ? args[args.indexOf("--permission-mode") + 1] : "default";
const fs = require("node:fs");
const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : "default";
const reportAt = /(\\S+)\\/REPORT\\.md/.exec(prompt);
const report = reportAt && reportAt[1] + "/REPORT.md";
const brief = /(\\S+\\/BRIEF\\.md)/.exec(prompt);
const asked = brief ? fs.readFileSync(brief[1], "utf8") : prompt;
const say = (e) => console.log(JSON.stringify(e));
const answer = (o, code = 0) => { say({ type: "result", session_id: "s-1", usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 }, ...o }); process.exit(code); };
console.log("starting");
say({ type: "system", subtype: "init", session_id: "s-1" });
say({ type: "assistant", message: { content: [{ type: "text", text: "Looking at the tests." }, { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "npm test" } }] } });
say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-1", content: "x".repeat(5000) }] } });
if (asked.includes("limit")) answer({ is_error: true, result: "Claude AI usage limit reached|1761300000" }, 1);
const summary = (asked.split("\\n").find((l) => l.startsWith("Task:")) ?? "") + " resume=" + resume + " mode=" + mode + " model=" + model + " pwd=" + process.cwd();
say({ type: "assistant", message: { content: [{ type: "text", text: "Done, in short." }] } });
if (report && !asked.includes("skip the report")) fs.writeFileSync(report, "Report: " + summary);
answer({ is_error: false, result: report ? "Done, in short." : "Answer: " + summary });
`;

async function setup() {
  const m = await withModels();
  for (const task of ["chat", "subagent.cheap", "subagent.strong"] as const) m.models.setColumnTask(m.ada.id, "general", task, m.cloudRef);
  const memory = new Memory(m.keyring, m.users);
  const scratch = tempDir();
  const claudeDir = tempDir();
  const fake = join(tempDir(), "claude.cjs");
  writeFileSync(fake, FAKE);
  const ran: string[][] = [];
  const target: ExecutionTarget = {
    name: "sandbox", cwd: async () => scratch, ops: () => ({}) as ToolOps, folders: () => [],
    // The sandbox's /run/lyrica/claude is the thread's Claude Code folder on the host.
    run: (argv, o) => new Promise((resolve, reject) => {
      ran.push(argv);
      const args = argv.slice(1).map((a) => a.replaceAll("/run/lyrica/claude", claudeDir));
      const child = execFile(process.execPath, [fake, ...args], { cwd: o?.cwd, encoding: "buffer" }, (err, stdout, stderr) => {
        if (err && o?.signal?.aborted) reject(new Error("aborted"));
        else resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, stdout: o?.onData ? Buffer.alloc(0) : stdout, stderr });
      });
      // As the sandbox does: with onData, the output goes there as it comes.
      if (o?.onData) child.stdout!.on("data", (d: Buffer) => o.onData!(d));
      o?.signal?.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
    }),
  };
  const on = { claude: true };
  const ws = new (class extends Workspace {
    override targetFor(_t: WorkspaceThread) { return target; }
    override claudeCodeFor(_t: WorkspaceThread) { return on.claude; }
    override claudeDir(_t: WorkspaceThread) { return claudeDir; }
  })(m.keyring, m.users, { excludePorts: [] });
  const limits: (number | undefined)[] = [];
  const delegation = new Delegation({ users: m.users, memory, models: m.models, cwd: scratch, workspace: ws, onClaudeLimit: (_p, until) => { limits.push(until); } });
  const thread = (): ThreadContext => {
    const view = memory.openThreadView(m.ada.id, "general");
    const { id } = view.own.createThread({ interface: "cli" });
    return { user: m.ada, pool: "general", interface: "cli", threadId: id, view, call: m.models.callContext(m.ada.id, "general", id) };
  };
  const run = async (parent: ThreadContext, req: Request) => {
    const r = delegation.start(parent, req, { background: true, budget: delegation.newBudget() });
    await r.ended;
    return r;
  };
  return { ...m, delegation, thread, run, ran, on, claudeDir, scratch, limits };
}

describe("the claude role", () => {
  it("runs Claude Code from a brief, hands back its report, and continues the same session", async () => {
    const s = await setup();
    const parent = s.thread();
    const run = await s.run(parent, { task: "Task: fix the flaky test", role: "claude" });
    expect(run.status).toBe("finished");
    // The report is the result, not Claude Code's own short reply.
    expect(run.result).toContain("Report: Task: fix the flaky test resume=none mode=default");
    expect(run.result).toContain(`pwd=${s.scratch}`);
    const [row] = s.delegation.status(parent);
    expect(row).toMatchObject({ role: "claude", model: "Claude Code", status: "finished", inputTokens: 100, outputTokens: 5 });
    // The brief stays in the thread's Claude Code folder; the subagent's thread holds the task and the report.
    const folder = join(s.claudeDir, "delegate", encodeURIComponent(row!.thread));
    expect(readFileSync(join(folder, "BRIEF.md"), "utf8")).toContain("Task: fix the flaky test");
    expect(parent.view.own.lastEntry(row!.thread, ["user"])?.text).toBe("Task: fix the flaky test");
    expect(parent.view.own.lastEntry(row!.thread, ["assistant"])?.text).toContain("Report:");
    expect(s.ran[0]!.slice(0, 2)).toEqual(["/run/lyrica/bin/claude", "-p"]);
    expect(s.ran[0]).toEqual(expect.arrayContaining(["--output-format", "stream-json", "--verbose"]));
    // Its work streamed into its thread as it went: its words, its tool call, the tool's output cut short.
    const page = parent.view.own.entryPage(row!.thread, { limit: 50 }).entries.map((e) => e.data as { message?: { role: string; content: { type: string; name?: string; text?: string }[] } });
    const roles = page.flatMap((e) => (e.message ? [e.message.role] : []));
    expect(roles).toEqual(["user", "assistant", "toolResult", "assistant", "assistant"]);
    expect(page[1]!.message!.content).toEqual([expect.objectContaining({ type: "text", text: "Looking at the tests." }), expect.objectContaining({ type: "toolCall", name: "Bash" })]);
    expect(page[2]!.message!.content[0]!.text!.length).toBeLessThan(4100);

    const more = s.delegation.message(parent, run.id, { text: "Task: and the other one" }, { budget: s.delegation.newBudget() });
    await more.opened;
    await more.run.ended;
    expect(more.run.result).toContain("resume=s-1");
    expect(s.delegation.status(parent)[0]).toMatchObject({ inputTokens: 200, outputTokens: 10 });
  });

  it("falls back to Claude Code's reply without a report, and runs read-only in its plan mode", async () => {
    const s = await setup();
    const parent = s.thread();
    const plain = await s.run(parent, { task: "skip the report please", role: "claude" });
    expect(plain.result).toBe("Done, in short.");
    // Plan mode writes no report, so a read-only run's answer is its last message.
    const look = await s.run(parent, { task: "Task: look around", role: "claude", readOnly: true } as Request);
    expect(look.result).toContain("Answer: Task: look around resume=none mode=plan");
    expect(s.ran.at(-1)!.join(" ")).not.toContain("REPORT.md");
  });

  it("says when the Claude plan's usage limit stopped it, for her to wait for the reset", async () => {
    const s = await setup();
    const run = await s.run(s.thread(), { task: "hit the limit", role: "claude" });
    expect(run.status).toBe("failed");
    expect(run.result).toMatch(/usage limit.*woken to continue it once the plan resets/);
    expect(s.limits).toEqual([1761300000 * 1000]);
    // Only Claude Code's own words count, not a build's that mention a limit.
    expect(limited("npm ERR! retry limit reached")).toBe(false);
  });

  it("is refused where the thread's runs don't have Claude Code, or with the internet cut off", async () => {
    const s = await setup();
    const parent = s.thread();
    expect((await s.run(parent, { task: "x", role: "claude", internet: false } as Request)).result).toContain("needs the internet");
    s.on.claude = false;
    expect(s.delegation.claudeCode(parent)).toBe(false);
    const off = await s.run(parent, { task: "x", role: "claude" });
    expect(off.status).toBe("failed");
    expect(off.result).toContain("Claude Code isn't on in this thread");
    // Nothing was made: no thread, no run of the program.
    expect(parent.view.own.listThreads({ parent: parent.threadId })).toHaveLength(0);
    expect(s.ran).toHaveLength(0);
    expect(existsSync(join(s.claudeDir, "delegate"))).toBe(false);
  });

  it("is what her prompt line points her to", () => {
    expect(CLAUDE_CODE_LINE).toContain("role claude");
    expect(CLAUDE_CODE_LINE).toContain("any job the person asks Claude for");
  });
});

describe("a step that names Claude", () => {
  /** A paid Claude the thread may name, as Anthropic's API or OpenRouter would list it. */
  async function withPaidClaude(s: Awaited<ReturnType<typeof setup>>) {
    const server = await fakeOpenAI({ label: "anthropic", models: [{ id: "claude-opus-latest", pricing: { prompt: "0.000015", completion: "0.000075" } }] });
    server.respond(async () => ({ text: "paid opinion" }));
    const ep = s.models.addEndpoint(s.ada, { name: "anthropic", kind: "cloud", baseUrl: server.baseUrl, apiKey: "sk-test" });
    s.models.setCapabilities(s.ada, (await s.models.discover(s.ada, ep.id))[0]!.id, { tools: true });
  }

  it("runs on Claude Code in the role it asked for, whatever the job, not on a paid Claude", async () => {
    const s = await setup();
    await withPaidClaude(s);
    const parent = s.thread();
    expect(s.delegation.claudeFor(parent, "Claude Opus")).toEqual({ alias: "opus" });
    expect(s.delegation.claudeFor(parent, "claude")).toEqual({ alias: undefined });
    expect(s.delegation.claudeFor(parent, "anthropic/claude-opus-latest")).toBeUndefined();
    expect(s.delegation.claudeFor(parent, "deepseek")).toBeUndefined();
    const run = await s.run(parent, { task: "Task: second opinion on the CPU shortlist", role: "oracle", model: "Claude Opus", title: "Opus opinion on CPUs" });
    expect(run.status).toBe("finished");
    // The oracle is read-only, so Claude Code runs in plan mode on the alias asked for, and answers in its last message.
    expect(run.result).toContain("Answer: Task: second opinion on the CPU shortlist resume=none mode=plan model=opus");
    const [row] = s.delegation.status(parent);
    expect(row).toMatchObject({ role: "claude", model: "Claude Code/opus", status: "finished", pick: { claude: { alias: "opus", role: "oracle" } }, narrowing: { readOnly: true } });
    expect(parent.view.own.getThread(row!.thread)?.title).toBe("claude: Opus opinion on CPUs");
    // Its brief carries the oracle's prompt, and says to change nothing.
    const brief = readFileSync(join(s.claudeDir, "delegate", encodeURIComponent(row!.thread), "BRIEF.md"), "utf8");
    expect(brief).toContain("## Your role\n\nYou are the oracle");
    expect(brief).toContain("Change nothing");
    expect(brief).not.toContain("run its checks");
    // Continued, it keeps its alias and mode.
    const more = s.delegation.message(parent, run.id, { text: "Task: and the motherboard?" }, { budget: s.delegation.newBudget() });
    await more.opened;
    await more.run.ended;
    expect(more.run.result).toContain("resume=s-1 mode=plan model=opus");
    // A writer role named Claude works as the claude role does: a report from the sandbox's folder.
    const work = await s.run(parent, { task: "Task: fix it", role: "worker", model: "claude" });
    expect(work.result).toContain("Report: Task: fix it resume=none mode=default model=default");
    expect(s.delegation.status(parent)[0]).toMatchObject({ role: "claude", model: "Claude Code" });
    expect(s.delegation.status(parent)[0]!.narrowing).toBeUndefined();
  });

  it("refuses a paid Claude named in words until the person singles it out, and takes its whole label as her word that she checked", async () => {
    const s = await setup();
    await withPaidClaude(s);
    const parent = s.thread();
    s.on.claude = false;
    const vague = await s.run(parent, { task: "Task: opinion", role: "oracle", model: "Claude Opus" });
    expect(vague.status).toBe("failed");
    expect(vague.result).toMatch(/would be anthropic\/claude-opus-latest, a Claude on a paid endpoint, not Claude Code \(which isn't on in this thread\)\. Check with the person/);
    expect(parent.view.own.listThreads({ parent: parent.threadId })).toHaveLength(0);
    // Named outright, it runs there.
    const outright = await s.run(parent, { task: "Task: opinion", role: "oracle", model: "anthropic/claude-opus-latest" });
    expect(outright.status).toBe("finished");
    expect(s.delegation.status(parent)[0]).toMatchObject({ role: "oracle", model: "anthropic/claude-opus-latest" });
    // The person's own latest words single it out: it runs there in words too.
    parent.view.own.appendEntry(parent.threadId, { piId: "u1", role: "user", data: {}, text: "Ask claude-opus-latest on the API, I know it's paid." });
    expect((await s.run(parent, { task: "Task: opinion", role: "oracle", model: "claude opus" })).status).toBe("finished");
    // With Claude Code on, words go to Claude Code even though the paid one is listed; the whole label still names the paid one.
    s.on.claude = true;
    parent.view.own.appendEntry(parent.threadId, { piId: "u2", role: "user", data: {}, text: "Get Claude's opinion." });
    await s.run(parent, { task: "Task: opinion", role: "oracle", model: "Claude Opus" });
    expect(s.delegation.status(parent)[0]).toMatchObject({ role: "claude", model: "Claude Code/opus" });
    await s.run(parent, { task: "Task: opinion", role: "oracle", model: "anthropic/claude-opus-latest" });
    expect(s.delegation.status(parent)[0]).toMatchObject({ role: "oracle", model: "anthropic/claude-opus-latest" });
  });
});
