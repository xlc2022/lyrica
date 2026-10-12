// Message search in the sidebar (docs/briefs/web-2.md, "Message-text search"):
// only the user's own pools, only what the thread list shows, never an
// unlogged thread; one sentence of at most 160 characters with the query's
// words marked; and no message text in the logs (AGENTS.md, "No plaintext memory").
import { describe, expect, it } from "vitest";
import type { Lyricad } from "../src/lyricad.ts";
import type { SearchHit, SearchResults, ThreadSummary } from "../src/api.ts";
import { browser, daemon, enc, login, runtime } from "./helpers.ts";

type Pool = "general" | "private";

/** Stores a message as the extension would, at a given time. */
const say = (d: Lyricad, userId: string, pool: Pool, thread: string, role: "user" | "assistant", text: string, at: string) => {
  const o = d.services!.memory.openOwnerView(userId);
  try {
    o[pool].appendEntry(thread, { piId: `${role}-${Math.random()}`, role, data: { type: "message", message: { role, content: [{ type: "text", text }] } }, text }, at);
  } finally {
    o.close();
  }
};

/** The marked parts of a hit's snippet. */
const marked = (h: SearchHit) => h.marks.map(([a, b]) => h.snippet.slice(a, b));

describe("message search", () => {
  it("finds the user's messages and her replies in the pools and threads the list shows, as marked sentences, and logs no text", async () => {
    const rt = await runtime();
    const { d, base, logs } = await daemon(rt);
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    const user = rt.li;
    const me = await login(base, user.login, "pw");
    const other = await login(base, rt.sam.login, "pw2");
    const mu = `/api/u/${user.id}`;
    const thread = async (pool: Pool, title: string) => (await me.post<ThreadSummary>(`${mu}/threads`, { pool, title })).body;
    const find = async (q: string, extra = "") => {
      const r = await me.get<SearchResults>(`${mu}/search?q=${enc(q)}${extra}`);
      expect(r.status).toBe(200);
      return r.body.hits;
    };
    const where = (hits: SearchHit[]) => hits.map((h) => `${h.pool}/${h.title ?? ""}#${h.n}`);

    const garden = await thread("general", "Garden");
    say(d, user.id, "general", garden.id, "user", "Where should the quokka hutch go?", "2026-10-01T10:00:00.000Z");
    say(d, user.id, "general", garden.id, "assistant", "By the fence, away from the wind. Put the **quokka** hutch there [n:abc], where it gets the morning sun.", "2026-10-01T10:00:05.000Z");
    const diary = await thread("private", "Diary");
    say(d, user.id, "private", diary.id, "user", "I dreamt about a quokka last night.", "2026-10-02T08:00:00.000Z");
    const old = await thread("general", "Old plans");
    say(d, user.id, "general", old.id, "user", "A quokka pen, maybe.", "2026-09-01T08:00:00.000Z");
    expect((await me.patch(`${mu}/threads/general/${enc(old.id)}`, { hidden: true })).status).toBe(200);
    const secret = await thread("general", "Secret");
    expect((await me.patch(`${mu}/threads/general/${enc(secret.id)}/settings`, { unlogged: true })).status).toBe(200);
    say(d, user.id, "general", secret.id, "user", "The quokka lives behind the shed.", "2026-10-03T08:00:00.000Z");
    const theirs = (await other.post<ThreadSummary>(`/api/u/${rt.sam.id}/threads`, { pool: "general", title: "Zoo" })).body;
    say(d, rt.sam.id, "general", theirs.id, "user", "The quokka smiles.", "2026-10-04T08:00:00.000Z");

    // Newest first; the hidden thread, the unlogged one and the other user's are left out.
    const hits = await find("quokka");
    expect(where(hits)).toEqual(["private/Diary#1", "general/Garden#2", "general/Garden#1"]);
    expect(hits.map((h) => h.who)).toEqual(["you", "agent", "you"]);
    expect(hits[1]).toMatchObject({ threadId: garden.id, pool: "general", at: "2026-10-01T10:00:05.000Z" });
    // Her reply: the sentence that holds the word, without the citation or the Markdown, marked where the word is.
    expect(hits[1]!.snippet).toBe("Put the quokka hutch there, where it gets the morning sun.");
    for (const h of hits) expect(marked(h)).toEqual(["quokka"]);

    // Every word counts, each as a word or a word's start; accents and case don't matter.
    expect(where(await find("QUOK hut"))).toEqual(["general/Garden#2", "general/Garden#1"]);
    expect(await find("quokka zebra")).toEqual([]);
    expect(marked((await find("quok hut"))[1]!)).toEqual(["quok", "hut"]);
    expect(where(await find("quökka"))).toHaveLength(3);
    expect(await find("q")).toEqual([]);

    // A pool parameter narrows; a pool switched off stays out even when asked for.
    expect(where(await find("quokka", "&pool=private"))).toEqual(["private/Diary#1"]);
    expect((await me.get(`${mu}/search?q=quokka&pool=elsewhere`)).status).toBe(400);
    await me.patch(`${mu}/me/display`, { showPrivate: false });
    expect(where(await find("quokka"))).toEqual(["general/Garden#2", "general/Garden#1"]);
    expect(await find("quokka", "&pool=private")).toEqual([]);
    // Hidden threads come back with Hidden on in the Sort menu.
    await me.patch(`${mu}/me/display`, { showPrivate: true, showHidden: true });
    expect(where(await find("quokka"))).toEqual(["private/Diary#1", "general/Garden#2", "general/Garden#1", "general/Old plans#1"]);
    await me.patch(`${mu}/me/display`, { showHidden: false });
    // Only projects and No projects as the list has them: a project's own threads go with its chat.
    const project = (await me.post<ThreadSummary>(`${mu}/threads`, { pool: "general", title: "Burrow", project: true })).body;
    say(d, user.id, "general", project.id, "user", "A wombat burrow plan.", "2026-09-20T08:00:00.000Z");
    const ov = d.services!.memory.openOwnerView(user.id);
    let dig: string;
    try { dig = ov.general.createThread({ interface: "web", parent: project.id, child: true, title: "Dig" }).id; } finally { ov.close(); }
    say(d, user.id, "general", dig, "user", "Dig the wombat burrow deeper.", "2026-09-21T08:00:00.000Z");
    expect(where(await find("wombat"))).toEqual(["general/Dig#1", "general/Burrow#1"]);
    await me.patch(`${mu}/me/display`, { projects: "none" });
    expect(await find("wombat")).toEqual([]);
    expect(where(await find("quokka"))).toEqual(["private/Diary#1", "general/Garden#2", "general/Garden#1"]);
    await me.patch(`${mu}/me/display`, { projects: "only" });
    expect(where(await find("wombat"))).toEqual(["general/Dig#1", "general/Burrow#1"]);
    expect(await find("quokka")).toEqual([]);
    await me.patch(`${mu}/me/display`, { projects: "all" });

    // A long sentence is cut around the word, to 160 characters at most, and the marks still point at it.
    const long = await thread("general", "Long");
    const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
    say(d, user.id, "general", long.id, "user", `${words(40)} wallaby ${words(40)}.`, "2026-10-05T08:00:00.000Z");
    const [cut] = await find("wallaby");
    expect(cut!.snippet.length).toBeLessThanOrEqual(160);
    expect(cut!.snippet.startsWith("…") && cut!.snippet.endsWith("…")).toBe(true);
    expect(marked(cut!)).toEqual(["wallaby"]);

    // Pages: limit, then before the last hit's time.
    const first = await find("quokka", "&limit=2");
    expect(where(first)).toEqual(["private/Diary#1", "general/Garden#2"]);
    expect(where(await find("quokka", `&limit=2&before=${enc(first[1]!.at)}`))).toEqual(["general/Garden#1"]);

    // Rewound away while a branch keeps the message: found in the branch.
    const branch = (await me.post<ThreadSummary>(`${mu}/threads/general/${enc(garden.id)}/messages/2/branch`, { title: "Garden again" })).body;
    const o = d.services!.memory.openOwnerView(user.id);
    try { o.general.truncateThread(garden.id, 2, `user:${user.id}`); } finally { o.close(); }
    expect(where(await find("hutch"))).toEqual(["general/Garden again#2", "general/Garden#1"]);
    expect((await find("hutch"))[0]!.threadId).toBe(branch.id);

    // Another user can't search here, and their own search doesn't reach this user's pools.
    expect((await other.get(`${mu}/search?q=quokka`)).status).toBe(401);
    expect((await other.get<SearchResults>(`/api/u/${rt.sam.id}/search?q=quokka`)).body.hits.map((h) => h.threadId)).toEqual([theirs.id]);

    // No message text reached the logs.
    expect(logs.filter((l) => /quokka|wallaby|hutch/i.test(l))).toEqual([]);
  });
});
