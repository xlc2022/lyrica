import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionTarget } from "@lyrica/core";
import { appendPiMessage, appendUserMessage } from "../record.ts";
import type { Said, Subagent, SubagentBody } from "./runs.ts";

// The claude role (docs/delegation.md, "Claude Code"): a subagent that is one
// `claude -p` run per turn in the parent's sandbox, through the same wrapper
// and relay as her bash's `claude`, so the user's token never enters it. It
// works from BRIEF.md and writes REPORT.md in a folder of its own in the
// thread's Claude Code folder, which is in the encrypted home workspace.

export const CLAUDE_ROLE = "claude";
/** Its model, as the run card and the records name it. */
export const CLAUDE_MODEL = "Claude Code";
/** The wrapper, first on a Claude Code run's PATH (core/src/workspace/claude.sh). */
const WRAPPER = "/run/lyrica/bin/claude";
/** Where the thread's Claude Code folder is mounted in the sandbox. */
const SANDBOX_DIR = "/run/lyrica/claude";

export interface ClaudeRun {
  /** Runs in the parent's sandbox, with Claude Code on. */
  target: ExecutionTarget;
  /** The thread's Claude Code folder on the host (Workspace.claudeDir). */
  dir: string;
  /** Claude Code's read-only mode, for a read-only run. */
  readOnly: boolean;
  /** Her set name, in place of Lyrica. */
  name: string;
  /** The Claude plan's usage limit stopped it, with when it resets if Claude Code said: lyricad wakes the parent to continue it then. */
  onLimit?: (until?: number) => void;
}

/** The subagent's own folder in the thread's Claude Code folder: host path and the path Claude Code sees. */
function folders(dir: string, threadId: string): { host: string; seen: string } {
  const name = encodeURIComponent(threadId);
  return { host: join(dir, "delegate", name), seen: `${SANDBOX_DIR}/delegate/${name}` };
}

const reportAsk = (seen: string, name: string) => `Before you end, write ${seen}/REPORT.md: what you changed (files and commits), what's left, and the checks you ran with their results. Your reply goes back to ${name} only if there's no report.`;

/** What BRIEF.md says for its first turn. */
export function brief(task: string, name: string): string {
  return `# Brief\n\n${task}\n\nYou are working for ${name}, who handed you this task. You see none of her conversation, only this brief. Follow the repository's own instructions (AGENTS.md, CLAUDE.md) and run its checks before you report.\n`;
}

/** A Claude Code process per turn, resumed from its session for the next. Its work is stored in its thread as it streams. */
export function claudeBody(sub: Subagent, o: ClaudeRun): SubagentBody {
  const { ctx } = sub;
  const { host, seen } = folders(o.dir, ctx.threadId);
  const sessionFile = join(host, "session");
  let aborter = new AbortController();
  let last: { text: string; error?: string } = { text: "" };
  return {
    async send(said: Said) {
      mkdirSync(host, { recursive: true, mode: 0o700 });
      rmSync(join(host, "REPORT.md"), { force: true });
      const session = existsSync(sessionFile) ? readFileSync(sessionFile, "utf8").trim() : "";
      const text = said.from ? `${said.from.profile.displayName}, the person ${o.name} works with, writes to you directly:\n\n${said.text}` : said.text;
      // The first turn's task is its brief; a later message continues the same session.
      let prompt: string;
      if (session) prompt = `${text}\n\n${reportAsk(seen, o.name)}`;
      else {
        writeFileSync(join(host, "BRIEF.md"), brief(text, o.name), { mode: 0o600 });
        prompt = `Read ${seen}/BRIEF.md and do what it asks. ${reportAsk(seen, o.name)}`;
      }
      appendUserMessage(ctx.view.own, ctx.threadId, text);
      const argv = [WRAPPER, "-p", prompt, "--output-format", "stream-json", "--verbose", ...(session ? ["--resume", session] : []), ...(o.readOnly ? ["--permission-mode", "plan"] : [])];
      aborter = new AbortController();
      // While it runs it counts as a tool at work, so a long build inside it doesn't trip the idle check.
      const busy = `claude-${Date.now()}`;
      sub.tools.add(busy);
      const stream = new Stream(sub);
      let code: number | null;
      try {
        ({ code } = await o.target.run!(argv, { signal: aborter.signal, cwd: await o.target.cwd(), onData: (d) => stream.push(d) }));
      } catch (err) {
        last = { text: "", error: `Claude Code didn't finish: ${(err as Error).message}` };
        return;
      } finally {
        stream.end();
        sub.tools.delete(busy);
        sub.active = Date.now();
      }
      const out = stream.result;
      if (stream.session) writeFileSync(sessionFile, stream.session, { mode: 0o600 });
      if (out?.usage) {
        const u = out.usage;
        sub.usage.inputTokens += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        sub.usage.outputTokens += u.output_tokens ?? 0;
        sub.emit({ type: "usage", ...sub.usage });
      }
      const report = existsSync(join(host, "REPORT.md")) ? readFileSync(join(host, "REPORT.md"), "utf8").trim() : "";
      const reply = report || out?.result?.trim() || "";
      if (out?.is_error || code !== 0) {
        const why = out?.result?.trim() || stream.other.join("\n").trim() || `exit code ${code}`;
        if (!limited(why)) last = { text: reply, error: `Claude Code failed: ${why}` };
        else {
          o.onLimit?.(resetOf(why));
          last = { text: reply, error: `Claude Code reached the Claude plan's usage limit (${why}). ${o.onLimit ? "This thread is woken to continue it once the plan resets." : "Continue this run with delegate action message once it resets; set a wake-up for then."}` };
        }
        return;
      }
      last = { text: reply };
      // Its last words are in its thread already; a report goes there too, as its result.
      if (report) appendPiMessage(ctx.view.own, ctx.threadId, claudeMessage(report));
    },
    // A message mid-run waits for the run to end, then resumes its session.
    steer: () => false,
    abort() { aborter.abort(); },
    reply: () => last,
    dispose() {},
  };
}

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
/** An assistant message of Claude Code's, as Pi stores one. */
const claudeMessage = (text: string, content: object[] = [{ type: "text", text }]) =>
  ({ role: "assistant", content, api: "claude-code", provider: "claude-code", model: CLAUDE_MODEL, usage: ZERO, stopReason: "stop", timestamp: Date.now() });
/** How much of a tool's output its thread keeps: enough to follow the work, not every file it read. */
const RESULT_CHARS = 4000;

interface Result { type?: string; is_error?: boolean; result?: string; session_id?: string; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }
type Block = { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };

/**
 * Claude Code's `--output-format stream-json`, a JSON event a line: its
 * messages go into the subagent's thread as they come (text and tool calls,
 * tool results cut short), each one telling the run card to reload; its
 * session and its result are kept. Other lines are kept for an error.
 */
class Stream {
  result?: Result;
  session?: string;
  readonly other: string[] = [];
  private held = "";
  private readonly names = new Map<string, string>();
  constructor(private readonly sub: Subagent) {}

  push(data: Buffer): void {
    const lines = (this.held + data.toString("utf8")).split("\n");
    this.held = lines.pop()!;
    for (const line of lines) this.line(line);
  }

  end(): void {
    if (this.held) this.line(this.held);
    this.held = "";
  }

  private line(line: string): void {
    if (!line.trim()) return;
    let e: { type?: string; session_id?: string; message?: { content?: Block[] } } & Result;
    try { e = JSON.parse(line); } catch { this.other.splice(0, Math.max(0, this.other.length - 19), line); return; }
    const { ctx } = this.sub;
    this.sub.active = Date.now();
    if (e.session_id) this.session = e.session_id;
    if (e.type === "result") { this.result = e; return; }
    const blocks = Array.isArray(e.message?.content) ? e.message.content : [];
    try {
      if (e.type === "assistant") {
        const content = blocks.flatMap((b): object[] => b.type === "text" && b.text ? [{ type: "text", text: b.text }]
          : b.type === "tool_use" ? [{ type: "toolCall", id: b.id, name: b.name, arguments: b.input ?? {} }] : []);
        for (const b of blocks) if (b.type === "tool_use" && b.id && b.name) { this.names.set(b.id, b.name); this.sub.emit({ type: "tool_call", toolName: b.name, args: b.input }); }
        if (content.length) appendPiMessage(ctx.view.own, ctx.threadId, claudeMessage("", content));
      } else if (e.type === "user") {
        for (const b of blocks) {
          if (b.type !== "tool_result") continue;
          const text = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? (b.content as Block[]).map((c) => c.text ?? "").join("\n") : "";
          appendPiMessage(ctx.view.own, ctx.threadId, {
            role: "toolResult", toolCallId: b.tool_use_id, toolName: this.names.get(b.tool_use_id ?? "") ?? "tool", isError: !!b.is_error, timestamp: Date.now(),
            content: [{ type: "text", text: text.length > RESULT_CHARS ? `${text.slice(0, RESULT_CHARS)}\n[… cut]` : text }],
          });
        }
      } else return;
    } catch { return; /* its thread closed meanwhile */ }
    // The card reloads its thread on a usage event; the counts themselves come with the result.
    this.sub.emit({ type: "usage", ...this.sub.usage });
  }
}

/** Whether Claude Code stopped on the Claude plan's usage limit. */
export const limited = (why: string) => /usage limit|hit your limit|limit reached/i.test(why);
/** When the plan resets, where Claude Code's message gives it (`…|<seconds>`). */
const resetOf = (why: string) => { const m = /\|(\d{10})\b/.exec(why); return m ? Number(m[1]) * 1000 : undefined; };
