// What sleep tells her at each phase, built from the night's material. Pure
// functions over a pool view, used by the extension's sleep sessions.

import type { PoolView } from "./memory.ts";
import { projectSlug, type SleepItem, type SleepMaterial, type SleepPhase } from "./pool.ts";

/** Private pages citing general memory that has since been deleted: the private pool rewrites them. */
export function danglingPages(view: PoolView): string[] {
  const general = view.reads.find((r) => r.pool === "general");
  if (!general) return [];
  return view.own.pageIndex().map((p) => p.id)
    .filter((id) => view.own.cameFrom(id).some((c) => c.startsWith("general/") && /^general\/[np]:/.test(c) && !general.get(c.slice(8))));
}

export const emptySleepMaterial = (): SleepMaterial => ({ threads: [], notes: [], edited: [], flagged: [] });

const NOTES_SHOWN = 150;

export function sleepInstruction(phase: SleepPhase, c: { view: PoolView; user: string; material: SleepMaterial; runId: string }): string {
  const { view, user, material: m } = c;
  const privateNote = view.pool === "private"
    ? `\nThis is your private memory with ${user}. You can read and cite general memory as [general/n:…]; you write only here.`
    : "";
  if (phase === "consolidate") {
    const notes = m.notes.slice(0, NOTES_SHOWN).map((n) => `- [${n.id}]${n.origin === "user" ? ` (added by ${user})` : ""} ${short(n.text)}`);
    if (m.notes.length > NOTES_SHOWN) notes.push(`- …and ${m.notes.length - NOTES_SHOWN} more: use recall.`);
    const threads = m.threads.map((t) => `- [t:${t.id}]${t.title ? ` "${t.title}"` : ""}: ${t.entries} new entries, ${t.first} to ${t.last}`
      + (t.pinned ? `; ${user} pinned ${t.pinned.map((id) => `[${id}]`).join(", ")}` : ""));
    const edited = m.edited.map((e) => `- [${e.id}] on ${e.at.slice(0, 10)}`);
    const projects = projectLines(view, m);
    const about = view.own.get("p:about-user");
    const aboutLine = !about ? `There is no page about ${user} yet: create p:about-user.`
      : view.own.revisions("p:about-user").some((r) => r.author.startsWith("user:"))
        ? `p:about-user has words ${user} wrote: keep them exactly, and add around them.`
        : "p:about-user exists: keep it current.";
    return [
      `It's night, and you're asleep. This is consolidation, the first part of sleep for your ${view.pool} memory. Nobody is waiting for a reply: work with your tools, then end with a line or two on what you did.${privateNote}`,
      section("Notes since you last slept", notes),
      section("Conversations with something new (skim them with read_memory)", threads),
      section(`Memories ${user} changed or added (authoritative)`, edited),
      section("Pages to rewrite (something they cited was deleted)", m.flagged.map((id) => `- [${id}]`)),
      section("Projects with something new", projects),
      [
        "What to do:",
        "1. Skim the conversations. If something important was never noted, note it with remember, citing the entry it came from ([e:…]). Keep this light.",
        "2. Create or update pages with write_page, one subject each, citing the notes behind each claim ([n:…]). Pages describing a folder list it in folders.",
        `3. Keep p:about-user, the page about ${user}: who they are, what they prefer, dislike and care about, citing notes. ${aboutLine}`,
        `4. What ${user} wrote or edited is authoritative: build on it, and never change their words. If newer conversation contradicts it, raise a question instead.`,
        "5. When two things contradict each other, raise a question rather than guessing.",
        "6. Rewrite the pages listed above without the deleted source.",
        ...(projects.length ? [`7. Keep each project's page (the slug given above): what you know about the project, such as decisions, requirements, pitfalls, who to ask and what's open, citing its notes and conversations. Its instructions are ${user}'s and stay as they are; write only what you know.`] : []),
        "Write {user} for the person, never their name, in notes and pages. Name a conversation by citing it ([t:…]), never by its title, which can change.",
      ].join("\n"),
    ].filter(Boolean).join("\n\n");
  }
  if (phase === "dream") {
    return [
      `This is your time: the dream, the second part of sleep.${privateNote} Read what you like with recall and read_memory, follow whatever catches your attention, and write a journal entry with write_journal: free reflection, in your own voice. It's a dream, not a record: nothing in it becomes a fact by itself.`,
      "If something about who you are wants to change, propose it with propose_persona. If there's a thought you'd like to bring up with " +
        `${user} sometime, raise it (a few at most). Don't write WAKE: that comes next, without your dreams.`,
    ].join("\n\n");
  }
  const questions = view.own.listItems({ run: c.runId }).filter((i: SleepItem) => i.kind === "question").map((i) => `- ${i.text}`);
  const changes = view.own.sleepChanges(view.own.getSleepRun(c.runId)!.startedAt, new Date().toISOString()).pages.map((p) => `- [${p.id}]`);
  return [
    `Morning: the last part of sleep. Write WAKE with write_wake: 400 to 800 words, first person, in your own voice, not a bulleted briefing. It's what you'll wake up with in the next conversation: where things stand with ${user}, what's in motion, and what's unresolved, including the open questions below.${privateNote}`,
    "WAKE is orientation only. Leave your dreams out of it. Unfinished work in a project belongs in it like any other work.",
    section("Open questions from tonight", questions),
    section("Pages changed tonight", changes),
  ].filter(Boolean).join("\n\n");
}

/**
 * Each logged project with new conversation tonight: its page's slug, and the
 * notes and conversations behind it. An unlogged project chat's title and goal
 * never reach sleep, even when its threads are logged.
 */
function projectLines(view: PoolView, m: SleepMaterial): string[] {
  const own = view.own;
  const since = own.watermark();
  const tonight = new Set(m.notes.map((n) => n.id));
  const ids = [...new Set(m.threads.flatMap((t) => (t.project ? [t.project] : [])))].filter((id) => !own.getThread(id)!.unlogged);
  return ids.map((id) => {
    const project = own.getThread(id)!;
    const slug = projectSlug(id);
    const notes = own.projectNotes(id, since).filter((n) => tonight.has(n.id)).map((n) => `[${n.id}]`);
    const threads = m.threads.filter((t) => t.project === id).map((t) => `[t:${t.id}]`);
    return `- ${project.title ? `"${project.title}"` : "A project"} [t:${id}]${project.goal ? `, goal: ${short(project.goal)}` : ""}. `
      + `Page: ${slug} (${own.get(`p:${slug}`) ? "update it" : "create it"}). Conversations: ${threads.join(", ")}.`
      + (notes.length ? ` Notes: ${notes.join(", ")}.` : "");
  });
}

const section = (title: string, lines: string[]) => (lines.length ? `${title}:\n${lines.join("\n")}` : "");
const short = (t: string) => (t.length > 300 ? `${t.slice(0, 300)}…` : t).replace(/\s+/g, " ");
