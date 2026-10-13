// A fenced code block in a message: the fence's language and Copy in a strip along its top edge (docs/ux.md §6, Code in a message).
import type { ComponentProps } from "react";
import type { ExtraProps } from "react-markdown";
import { CopyButton } from "./CopyButton.tsx";

type Node = NonNullable<ExtraProps["node"]>;
type Child = Node["children"][number];

/** What a node reads as: the text under it. */
const textOf = (n: Child): string => (n.type === "text" ? n.value : n.type === "element" ? n.children.map(textOf).join("") : "");

/**
 * The block's language (the fence's first word) and its text. The text loses the one newline the parser ends a fence
 * with: pasted into a terminal, a trailing newline would run the command.
 */
export function codeOf(node: Node | undefined): { lang: string; text: string } {
  const code = node?.children.find((c) => c.type === "element" && c.tagName === "code");
  if (code?.type !== "element") return { lang: "", text: "" };
  const classes = Array.isArray(code.properties.className) ? code.properties.className.map(String) : [];
  const lang = classes.find((c) => c.startsWith("language-"))?.slice("language-".length) ?? "";
  return { lang, text: textOf(code).replace(/\n$/, "") };
}

/** A `pre` for react-markdown. The strip is outside the scrolling `pre`, so it stays put while a long line scrolls. */
export function CodeBlock({ node, children }: ComponentProps<"pre"> & ExtraProps) {
  const { lang, text } = codeOf(node);
  return (
    <div className="code-block">
      <div className="code-head">
        {lang && <span className="code-lang">{lang}</span>}
        <CopyButton text={text} label="Copy" ariaLabel="Copy code" className="code-copy" />
      </div>
      <pre>{children}</pre>
    </div>
  );
}
