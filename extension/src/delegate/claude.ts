import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionTarget } from "@lyrica/core";
import { appendReply, appendUserMessage } from "../record.ts";
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

/** A Claude Code process per turn, resumed from its session for the next. */
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
      const argv = [WRAPPER, "-p", prompt, "--output-format", "json", ...(session ? ["--resume", session] : []), ...(o.readOnly ? ["--permission-mode", "plan"] : [])];
      aborter = new AbortController();
      // A run prints nothing until it ends; it counts as a tool at work, so the idle check leaves it be.
      const busy = `claude-${Date.now()}`;
      sub.tools.add(busy);
      let r: { code: number | null; stdout: Buffer; stderr: Buffer };
      try {
        r = await o.target.run!(argv, { signal: aborter.signal, cwd: await o.target.cwd() });
      } catch (err) {
        last = { text: "", error: `Claude Code didn't finish: ${(err as Error).message}` };
        return;
      } finally {
        sub.tools.delete(busy);
        sub.active = Date.now();
      }
      const out = parse(r.stdout.toString("utf8"));
      if (out?.session_id) writeFileSync(sessionFile, out.session_id, { mode: 0o600 });
      if (out?.usage) {
        const u = out.usage;
        sub.usage.inputTokens += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        sub.usage.outputTokens += u.output_tokens ?? 0;
        sub.emit({ type: "usage", ...sub.usage });
      }
      const report = existsSync(join(host, "REPORT.md")) ? readFileSync(join(host, "REPORT.md"), "utf8").trim() : "";
      const reply = report || out?.result?.trim() || "";
      if (out?.is_error || r.code !== 0) {
        const why = out?.result?.trim() || r.stderr.toString("utf8").trim().split("\n").slice(-5).join("\n") || `exit code ${r.code}`;
        last = { text: reply, error: limited(why) ? `Claude Code reached the Claude plan's usage limit: ${why}. Continue this run with delegate action message once it resets; set a wake-up for then.` : `Claude Code failed: ${why}` };
        return;
      }
      last = { text: reply };
      if (reply) appendReply(ctx.view.own, ctx.threadId, reply, CLAUDE_MODEL);
    },
    // A message mid-run waits for the run to end, then resumes its session.
    steer: () => false,
    abort() { aborter.abort(); },
    reply: () => last,
    dispose() {},
  };
}

interface Result { type?: string; is_error?: boolean; result?: string; session_id?: string; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }

/** Claude Code's `--output-format json` answer: one JSON object, perhaps after other lines. */
function parse(stdout: string): Result | undefined {
  for (const line of stdout.trim().split("\n").reverse()) {
    try {
      const v = JSON.parse(line) as Result;
      if (v && typeof v === "object") return v;
    } catch { /* not this line */ }
  }
  return undefined;
}

/** Whether Claude Code stopped on the Claude plan's usage limit. */
export const limited = (why: string) => /usage limit|hit your limit|limit reached/i.test(why);
