import { describe, expect, it } from "vitest";
import type { MemoryLink, UserMap } from "../src/api.ts";
import { linkCitations } from "../src/memory.ts";
import { linkMentions, plainMentions, readableLinks } from "../src/mentions.ts";

describe("thread mentions in her text", () => {
  it("shows each as its current title, linked; a gone thread as plain text", () => {
    const titles: Record<string, string | null> = { "general/web/aa": "Move [DNS]", "general/web/bb": null };
    const text = "See [t:web/aa], and [e:web/aa#4]; [t:web/bb] ended. Also [t:web/cc].";
    expect(linkMentions(text, "ada", "general", (p, id) => titles[`${p}/${id}`])).toBe(
      "See [Move \\[DNS\\]](#/u/ada/t/general/web%2Faa), and [Move \\[DNS\\]](#/u/ada/t/general/web%2Faa); a forgotten thread ended. "
      + "Also [a thread](#/u/ada/t/general/web%2Fcc).",
    );
  });

  it("follows the pool a mention names", () => {
    expect(linkMentions("[general/t:web/aa]", "ada", "private", () => "DNS")).toBe("[DNS](#/u/ada/t/general/web%2Faa)");
    expect(linkMentions("[private/t:web/aa]", "ada", "general", () => "Secret")).toBe("a forgotten thread");
  });

  it("shows plain titles where a link can't go", () => {
    const titles: Record<string, string | null> = { "general/web/aa": "DNS", "general/web/bb": null };
    expect(plainMentions("[t:web/aa], [t:web/bb], [t:web/cc], [private/t:web/dd]", "general", (p, id) => titles[`${p}/${id}`]))
      .toBe("DNS, a forgotten thread, a thread, a forgotten thread");
  });
});

describe("user mentions in a cited page's title", () => {
  it("read as the user's name inside the citation's link", () => {
    const users: UserMap = { "ada-1": { displayName: "Ada", pronouns: { subj: "she", obj: "her", poss: "her", possPro: "hers", refl: "herself" } } };
    const links: Record<string, MemoryLink> = { "p:about": { kind: "page", pool: "general", title: "[[u:ada-1]] and [[u:ada-1:poss]] tea", snippet: "", updatedAt: "2026-10-09T10:00:00Z" } };
    const show = { showGeneral: true, showPrivate: true } as Parameters<typeof linkCitations>[4];
    expect(linkCitations("See [p:about].", "general", "u1", readableLinks(links, users), show).markdown)
      .toBe("See [Ada and her tea](#/u/u1/memory/general/p%3Aabout).");
  });
});
