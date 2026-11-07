// `lyrica chat`: her threads in the terminal, the `cli` interface. A client
// of lyricad over its socket; it keeps nothing (docs/briefs/terminal-clients.md).
import type { MessagePage, PermissionRequest, Pool, ThreadEvent, ThreadSummary } from "@lyrica/daemon/api";
import { type Client, Interrupted, type Io, printable, signIn, socketPath, terminalIo } from "./client.ts";

export const CHAT_USAGE = `  lyrica chat [--private] [--login <login>] [<thread id>]   (talk with her in a terminal thread)`;

const HELP = "Type to talk. /exit or Ctrl-D leaves; Ctrl-C stops her reply.";

/** Entry point for `lyrica chat`. */
export async function chat(args: string[], opts: { socket?: string; runtime?: string }, io: Io = terminalIo()): Promise<void> {
  const pool: Pool = take(args, "--private") ? "private" : "general";
  const login = value(args, "--login");
  const client = await signIn(io, socketPath(opts), login);
  try {
    const thread = await pick(io, client, pool, args[0]);
    if (!thread) return;
    await converse(io, client, pool, thread);
  } finally {
    await client.logout();
  }
}

function take(args: string[], flag: string): boolean {
  const i = args.indexOf(flag);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

function value(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${flag} needs a value`);
  args.splice(i, 2);
  return v;
}

/** The thread to talk in: the one named, or one picked from her recent terminal threads, or a new one. */
async function pick(io: Io, client: Client, pool: Pool, id?: string): Promise<ThreadSummary | undefined> {
  const threads = (await client.get<ThreadSummary[]>(client.u("/threads?interface=cli"))).filter((t) => t.pool === pool && !t.subagent);
  if (id) {
    const found = threads.find((t) => t.id === id);
    if (!found) throw new Error(`no terminal thread ${id} in ${pool}`);
    return found;
  }
  const recent = threads.slice(0, 9);
  if (recent.length) {
    io.err(`${pool === "private" ? "Private" : "General"} threads:`);
    recent.forEach((t, i) => io.err(`  ${i + 1}. ${printable(t.title ?? "Untitled")}  ${t.updatedAt.slice(0, 16).replace("T", " ")}`));
    io.err("  n. New thread");
    const choice = (await io.ask("Open [n]: ")).trim().toLowerCase();
    const n = Number(choice);
    if (choice && choice !== "n") {
      if (!Number.isInteger(n) || n < 1 || n > recent.length) throw new Error("choose a number from the list, or n");
      return recent[n - 1];
    }
  }
  return client.post<ThreadSummary>(client.u("/threads"), { pool, interface: "cli" });
}

interface Ask { question: string; options: { label: string; consequence?: string }[] }

/** The conversation loop: a line in, her reply streamed out, until /exit. */
async function converse(io: Io, client: Client, pool: Pool, thread: ThreadSummary): Promise<void> {
  const path = client.u(`/threads/${pool}/${encodeURIComponent(thread.id)}`);
  io.err(`${printable(thread.title ?? "New thread")} (${thread.id}). ${HELP}`);
  let turn: { resolve: () => void } | undefined;
  let midLine = false;
  let lastAsk: Ask | undefined;
  const prompts: (() => Promise<void>)[] = [];
  let prompting = Promise.resolve();
  const write = (text: string) => { const t = printable(text); if (t) { io.out(t); midLine = !t.endsWith("\n"); } };
  const line = (text: string) => { if (midLine) { io.out("\n"); midLine = false; } io.err(printable(text)); };
  let thinking = false;

  const onEvent = (e: ThreadEvent) => {
    switch (e.type) {
      case "text": thinking = false; write(e.delta); break;
      case "thinking": if (!thinking) { thinking = true; line("(reasoning…)"); } break;
      case "tool_start":
        line(`· ${e.name}`);
        if (e.name === "threads" && (e.args as { action?: string })?.action === "ask") lastAsk = e.args as Ask;
        break;
      case "tool_end": if (e.isError) line(`· ${e.name} failed: ${e.result.split("\n")[0]}`); break;
      case "recall": if (e.ids.length) line(`· recalled ${e.ids.length} ${e.ids.length === 1 ? "memory" : "memories"}`); break;
      case "permission": {
        const req = e as PermissionRequest;
        prompts.push(() => answerPermission(io, client, path, req));
        prompting = prompting.then(() => prompts.shift()?.());
        break;
      }
      case "error": line(`Error: ${e.message}`); break;
      case "offline": line(`No model could be reached (${e.tried.map((t) => `${t.label}: ${t.reason}`).join("; ")}). Your message waits and goes when one answers.`); turn?.resolve(); break;
      case "turn_end": if (midLine) { io.out("\n"); midLine = false; } thinking = false; turn?.resolve(); break;
      case "reset": if (!turn) break; line("The thread was reset."); turn.resolve(); break;
      default: break;
    }
  };
  /** Starts a turn and waits for its end, answering permission cards meanwhile; Ctrl-C stops it. */
  const runTurn = async (start: () => Promise<unknown>) => {
    lastAsk = undefined;
    const done = new Promise<void>((resolve) => { turn = { resolve }; });
    const stop = io.onInterrupt(() => { line("Stopping…"); void client.post(`${path}/stop`).catch(() => {}); });
    try {
      await start();
      await done;
      await prompting;
    } finally {
      stop();
      turn = undefined;
    }
  };
  const stream = client.events(pool, thread.id, onEvent);
  try {
    for (;;) {
      let text: string;
      try {
        text = await io.ask("> ");
      } catch (err) {
        if (err instanceof Interrupted) break;
        throw err;
      }
      const trimmed = text.trim();
      if (!trimmed) continue;
      if (trimmed === "/exit" || trimmed === "/quit") break;
      if (trimmed === "/help") { io.err(HELP); continue; }
      await runTurn(() => client.post(`${path}/messages`, { text }));
      // Her question card: a pick starts her next turn, as on the web.
      while (lastAsk) {
        const ask: Ask = lastAsk;
        const option = await pickOption(io, client, path, ask);
        if (!option) break;
        await runTurn(() => client.post(`${path}/questions/${option.n}/answer`, { option: option.index }));
      }
    }
  } finally {
    stream.close();
  }
}

/** A permission card at the prompt. Anything but y denies it. */
async function answerPermission(io: Io, client: Client, path: string, req: PermissionRequest): Promise<void> {
  const what = req.tool === "bash" ? String((req.args as { command?: string })?.command ?? "") : JSON.stringify(req.args);
  io.err(printable(`She asks to run ${req.tool}${req.machine ? ` on ${req.machine}` : ""}${req.cwd ? ` in ${req.cwd}` : ""}:\n  ${what.slice(0, 2000)}`));
  if (req.warning) io.err(printable(`  ${req.warning}`));
  let answer = "";
  try { answer = (await io.ask("Allow? [y/N] ")).trim().toLowerCase(); } catch (err) { if (!(err instanceof Interrupted)) throw err; }
  try {
    await client.post(`${path}/permissions/${encodeURIComponent(req.requestId)}`, { allow: answer === "y" || answer === "yes" });
  } catch (err) {
    io.err((err as Error).message);
  }
}

/** Her question card, if it is still open: a numbered pick, or Enter to answer in words at the next prompt. */
async function pickOption(io: Io, client: Client, path: string, ask: Ask): Promise<{ n: number; index: number } | undefined> {
  const page = await client.get<MessagePage>(`${path}/messages?limit=1`);
  const open = (page.questions ?? []).filter((q) => !q.closed).at(-1);
  if (!open || !ask.options?.length) return undefined;
  io.err(printable(ask.question));
  ask.options.forEach((o, i) => io.err(printable(`  ${i + 1}. ${o.label}${o.consequence ? `: ${o.consequence}` : ""}`)));
  let choice = "";
  try { choice = (await io.ask("Answer [number, or Enter to reply in words]: ")).trim(); } catch (err) { if (!(err instanceof Interrupted)) throw err; }
  const n = Number(choice);
  if (!choice || !Number.isInteger(n) || n < 1 || n > ask.options.length) return undefined;
  return { n: open.n, index: n - 1 };
}
