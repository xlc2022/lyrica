import { describe, expect, it } from "vitest";
import { linkMentions } from "../src/mentions.ts";

describe("thread mentions in her text", () => {
  it("shows each as its current title, linked; a gone thread as plain text", () => {
    const titles: Record<string, string | null> = { "general/web/aa": "Move [DNS]", "general/web/bb": null };
    const text = "See [t:web/aa], and [e:web/aa#4]; [t:web/bb] ended. Also [t:web/cc].";
    expect(linkMentions(text, "li", "general", (p, id) => titles[`${p}/${id}`])).toBe(
      "See [Move \\[DNS\\]](#/u/li/t/general/web%2Faa), and [Move \\[DNS\\]](#/u/li/t/general/web%2Faa); a forgotten thread ended. "
      + "Also [a thread](#/u/li/t/general/web%2Fcc).",
    );
  });

  it("follows the pool a mention names", () => {
    expect(linkMentions("[general/t:web/aa]", "li", "private", () => "DNS")).toBe("[DNS](#/u/li/t/general/web%2Faa)");
    expect(linkMentions("[private/t:web/aa]", "li", "general", () => "Secret")).toBe("a forgotten thread");
  });
});
