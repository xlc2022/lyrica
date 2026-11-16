import { describe, expect, it } from "vitest";
import { render } from "../src/mentions.ts";
import { firstLine } from "../src/store/refs.ts";
import { normalizeThreadArguments } from "../src/threads.ts";
import { knownValues } from "../src/workspace/machines.ts";
import { checkPage } from "../src/workspace/page.ts";

// Text an outsider can shape (a fetched page, command output, a model's reply)
// passes through these on lyricad's one thread. Each crafted 64 KB input here
// took a second or more before its patterns were made linear.

const fill = (unit: string, end = "") => unit.repeat(Math.ceil(65536 / unit.length)) + end;
const quick = (run: () => unknown) => {
  const started = performance.now();
  run();
  expect(performance.now() - started).toBeLessThan(300);
};

describe("patterns over crafted text", () => {
  it.each([
    ["an @import with long spacing", "@import" + fill("\t", "x")],
    ["an import with long spacing", "from" + fill("\t", "x")],
    ["a tag with a long dashed name", "<b" + fill("-o", ">")],
    ["tags left open", fill("<b ")],
    ["scripts left open", fill("<script>").repeat(4)],
    ["a script tag left open", fill("<script ")],
  ])("checks a page with %s quickly", (_name, html) => quick(() => checkPage(html)));

  it("still finds what a page loads and refers to", () => {
    const c = checkPage('<img title="x" src="//cdn.example/a.png"><a href="//x.example">x</a><video poster=https://v.example/p.jpg src="clip.mp4">'
      + '<style>@import url( "//f.example/f.css");</style><script>import("https://m.example/m.js"); fetch (u)</script><script src="app.js"></script>');
    expect(c.loads).toEqual(["//cdn.example/a.png", "https://v.example/p.jpg", "//f.example/f.css", "https://m.example/m.js"]);
    expect(c.calls).toEqual(["fetch"]);
    expect(c.local).toEqual(["clip.mp4", "app.js"]);
  });

  it("capitalises a pronoun after long spacing quickly", () => {
    const profiles = () => ({ displayName: "Ada", pronouns: { subj: "she", obj: "her", poss: "her", possPronoun: "hers", reflexive: "herself" } }) as never;
    quick(() => render(fill("\n") + "x" + fill(" ") + "[[u:a:obj]]", profiles));
    expect(render("[[u:a:obj]] came. [[u:a:obj]] and\n  [[u:a:obj]], or [[u:a:obj]]", profiles)).toBe("Her came. Her and\n  Her, or her");
  });

  it("previews a memory with long spacing quickly", () => {
    quick(() => firstLine(fill("\t", "\0\t!")));
    quick(() => firstLine(fill(" ", "x")));
    expect(firstLine("Ada likes tea  [n:abc, t:def] .  Then more")).toBe("Ada likes tea. Then more");
  });

  it("reads a command's redirections quickly", () => {
    quick(() => knownValues(fill("0", "&>")));
    expect(knownValues("A=1 && echo $A 2>&1").size).toBe(0);
  });

  it("cuts a long option label quickly", () => {
    const label = "a" + fill(".\t", "x");
    quick(() => normalizeThreadArguments({ action: "ask", question: "q", options: [{ label, consequence: "c" }, { label: "b", consequence: "c" }], recommended: 0 }));
  });
});
