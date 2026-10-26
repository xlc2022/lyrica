// What sleep tells her at each phase, built from the night's material. Pure
// functions over a pool view, used by the extension's sleep sessions.

import type { PoolView } from "./memory.ts";
import { projectSlug, type Item, type SleepItem, type SleepMaterial, type SleepPhase } from "./pool.ts";

/** Private pages citing general memory that has since been deleted: the private pool rewrites them. */
export function danglingPages(view: PoolView): string[] {
  const general = view.reads.find((r) => r.pool === "general");
  if (!general) return [];
  return view.own.pageIndex().map((p) => p.id)
    .filter((id) => view.own.cameFrom(id).some((c) => c.startsWith("general/") && /^general\/[np]:/.test(c) && !general.get(c.slice(8))));
}

/**
 * In a private pool, general memory's page about the user: every private
 * thread loads it after the private one, so private sleep keeps out of its
 * own page what this one already says.
 */
export function generalAbout(view: PoolView): Item | undefined {
  if (view.pool !== "private") return undefined;
  const page = view.reads.find((r) => r.pool === "general")?.get("p:about-user");
  return page && !page.archived && page.text.trim() ? page : undefined;
}

/** A private page about the user that general's page, changed since the last sleep, may now repeat. */
export function aboutToTidy(view: PoolView): boolean {
  const general = generalAbout(view);
  const own = view.own.get("p:about-user");
  return !!general && !!own && !own.archived && general.updatedAt > (view.own.watermark() ?? "");
}

export const emptySleepMaterial = (): SleepMaterial => ({ threads: [], notes: [], edited: [], flagged: [] });

const NOTES_SHOWN = 150;
/** How much of general's page about the user private consolidation is shown; read_memory has the rest. */
const GENERAL_ABOUT_SHOWN = 4000;

export function sleepInstruction(phase: SleepPhase, c: { view: PoolView; user: string; pronouns?: string; material: SleepMaterial; runId: string }): string {
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
    const general = generalAbout(view);
    const aboutLine = !about ? `There is no page about ${user} yet: create p:about-user.`
      : view.own.revisions("p:about-user").some((r) => r.author.startsWith("user:"))
        ? `p:about-user has words ${user} wrote: keep them exactly, and add around them.`
        : "p:about-user exists: keep it current.";
    const generalText = general && (general.text.length > GENERAL_ABOUT_SHOWN
      ? `${general.text.slice(0, GENERAL_ABOUT_SHOWN)}…\n(The rest: read_memory general/p:about-user.)` : general.text);
    const aboutStep = general
      ? `3. Keep p:about-user, the private page about ${user}. Every private conversation also loads general memory's page about them (below), so yours holds only what that one doesn't say: what's private, and detail it lacks. Drop anything it already says, and cite [general/p:about-user] where you build on it. Where the two disagree, keep yours and raise a question. If nothing is left, write one line pointing to [general/p:about-user]. ${aboutLine}`
      : `3. Keep p:about-user, the page about ${user}: what ${user} is like, prefers, dislikes and cares about, citing notes. ${aboutLine}`;
    return [
      `It's night, and you're asleep. This is consolidation, the first part of sleep for your ${view.pool} memory. Nobody is waiting for a reply: work with your tools, then end with a line or two on what you did.${privateNote}`,
      section("Notes since you last slept", notes),
      section("Conversations with something new (skim them with read_memory)", threads),
      section(`Memories ${user} changed or added (authoritative)`, edited),
      section("Pages to rewrite (something they cited was deleted or replaced)", m.flagged.map((id) => `- [${id}]`)),
      section("Projects with something new", projects),
      generalText ? `General memory's page about ${user} [general/p:about-user]:\n${generalText}` : "",
      [
        "What to do:",
        "1. First create or update pages with write_page from the notes above, one subject each, citing the notes behind each claim ([n:…]). Pages describing a folder list it in folders.",
        "2. Then skim the conversations for anything important that was never noted, and note it with remember, citing the entry it came from ([e:…]). A few reads are enough; don't note again what a note above already says.",
        aboutStep,
        `4. What ${user} wrote or edited is authoritative: build on it, and never change their words. If newer conversation contradicts it, raise a question instead.`,
        "5. When a newer note records a change (a rule, a plan, a decision, a status), the newer one holds: supersede the older notes with it, and keep only the current version on pages. Raise a question only when notes disagree and neither is plainly the later word.",
        "6. Fold notes that say the same thing, or track work step by step, into one: once work such as a pull request is finished, keep one note with its outcome and anything learned (remember, citing the entry it came from), and supersede the step-by-step notes with it. Superseded notes stay readable and citable, so pages that learn from them keep their sources.",
        "7. Rewrite the pages listed above from current notes: something they cited was deleted or replaced.",
        ...(projects.length ? [`8. Keep each project's page (the slug given above): what you know about the project, such as decisions, requirements, pitfalls, who to ask and what's open, citing its notes and conversations. Its instructions are ${user}'s and stay as they are; write only what you know.`] : []),
        "Keep working in the about tags of notes you merge; add it to notes that plainly state a coding or workflow preference.",
        `Write {user} for the person, never their name, in notes and pages, and {user:obj}, {user:poss}, {user:poss-pro} or {user:refl} for their pronouns${c.pronouns ? ` (${c.pronouns})` : ""}; there is no subject form, so write {user} where "she" or "they" would go. Name a conversation by citing it ([t:…]), never by its title, which can change.`,
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
  const wake = view.own.get("wake");
  const since = wake ? view.own.notesSince(wake.updatedAt) : [];
  const newer = since.slice(-NOTES_SHOWN).map((n) => `- [${n.id}] ${short(n.text)}`);
  if (since.length > NOTES_SHOWN) newer.unshift(`- (${since.length - NOTES_SHOWN} earlier ones: use recall.)`);
  const questions = view.own.listItems({ run: c.runId }).filter((i: SleepItem) => i.kind === "question").map((i) => `- ${i.text}`);
  const changes = view.own.sleepChanges(view.own.getSleepRun(c.runId)!.startedAt, new Date().toISOString()).pages.map((p) => `- [${p.id}]`);
  return [
    `Morning: the last part of sleep. Write WAKE with write_wake: 400 to 800 words, first person, in your own voice, not a bulleted briefing. It's what you'll wake up with in the next conversation: where things stand with ${user}, what's in motion, and what's unresolved, including the open questions below.${privateNote}`,
    "WAKE is orientation only. Leave your dreams out of it. Unfinished work in a project belongs in it like any other work.",
    wake ? `Your last WAKE, written ${wake.updatedAt.slice(0, 10)}, is below with the notes written since. It is a draft, not a source: keep from it only what the pages and notes still support. Where a newer note or a page says something is finished, merged, dropped or changed, follow that and leave the old claim out. Check anything else you keep with recall.` : "",
    wake ? `Last WAKE:\n${wake.text}` : "",
    section("Notes since your last WAKE", newer),
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
