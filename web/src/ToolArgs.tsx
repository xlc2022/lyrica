// A tool call's arguments laid out for reading (docs/ux.md §6, "Lyrica's inner workings"): a file she writes as its
// code or rendered Markdown, an edit as a diff, a command as Bash, anything else as a list of names and values. While
// she is still writing the call, the field she is writing shows as plain text that follows its end; it is coloured
// once it is whole.
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { CopyButton } from "./CopyButton.tsx";
import { lineDiff } from "./diff.ts";
import { Highlighted, kindOf, type Kind } from "./highlight.tsx";
import { basename } from "./paths.tsx";
import { Prose } from "./ui.tsx";

type Args = Record<string, unknown>;
/** A link into Files for a path the thread can reach, else nothing. */
export type FileHref = (path: string) => string | undefined;

/** Languages by the name a strip shows. */
const LANG_NAMES: Record<string, string> = { json: "JSON", javascript: "JavaScript", typescript: "TypeScript", python: "Python", yaml: "YAML", xml: "HTML", css: "CSS", ini: "TOML", sql: "SQL" };
const langName = (k: Kind): string => (k.kind === "markdown" ? "Markdown" : k.kind === "code" ? LANG_NAMES[k.lang] ?? k.lang : "");

/** Keeps a box scrolled to its end as text arrives, unless the person scrolled up to read. */
function useFollow<T extends HTMLElement>(dep: unknown) {
  const ref = useRef<T>(null);
  const atEnd = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [dep]);
  const onScroll = () => {
    const el = ref.current;
    if (el) atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
  };
  return { ref, onScroll };
}

/** A block of text with a strip: a file's name (a link into Files) or the language, and Copy. */
function Block({ text, kind, title, href, copyLabel, plain }: { text: string; kind: Kind; title?: string; href?: string; copyLabel: string; plain?: boolean }) {
  const pre = useFollow<HTMLPreElement>(text);
  const prose = useFollow<HTMLDivElement>(text);
  const head = title ?? langName(kind);
  return (
    <div className="read-text tool-block" data-kind={kind.kind === "code" ? "code" : kind.kind === "markdown" ? "markdown" : "wrapped"}>
      <div className="code-head">
        {href ? <a className="code-lang" href={href}>{head}</a> : <span className="code-lang">{head}</span>}
        <CopyButton text={text} label="Copy" ariaLabel={copyLabel} className="code-copy" />
      </div>
      {kind.kind === "markdown"
        ? <div ref={prose.ref} onScroll={prose.onScroll} className="read-body prose small"><Prose text={text} /></div>
        : <pre ref={pre.ref} onScroll={pre.onScroll} className="read-body" tabIndex={0} aria-label={head || copyLabel.replace(/^Copy /, "")}>
            <Highlighted text={text} lang={kind.kind === "code" ? kind.lang : undefined} plain={plain} />
          </pre>}
    </div>
  );
}

/** One edit's two sides as the changes view draws them: removed lines red, added green, changed words marked. */
function EditDiff({ oldText, newText }: { oldText: string; newText: string }) {
  return (
    <div className="tool-diff">
      {lineDiff(oldText, newText).map((l, i) => (
        <div key={i} className={`cline ${l.kind}`}>
          <span className="sign">{l.kind === "del" ? "−" : l.kind === "ins" ? "+" : " "}</span>
          <span className="code">{l.kind !== "same" && l.ops
            ? l.ops.map((o, j) => (o.kind === "same" ? o.text : <mark key={j} className={o.kind}>{o.text}</mark>))
            : l.text || " "}</span>
        </div>
      ))}
    </div>
  );
}

type Edit = { oldText?: unknown; newText?: unknown };
const editsOf = (a: Args): Edit[] => (Array.isArray(a.edits) ? a.edits.filter((e): e is Edit => Boolean(e) && typeof e === "object")
  : typeof a.oldText === "string" ? [{ oldText: a.oldText, newText: a.newText }] : []);

function Edits({ path, edits, href, drafting }: { path: string; edits: Edit[]; href?: string; drafting: boolean }) {
  const news = edits.map((e) => (typeof e.newText === "string" ? e.newText : "")).join("\n\n");
  return (
    <div className="read-text tool-block" data-kind="code">
      <div className="code-head">
        {href ? <a className="code-lang" href={href}>{basename(path)}</a> : <span className="code-lang">{basename(path)}</span>}
        <CopyButton text={news} label="Copy" ariaLabel="Copy new text" className="code-copy" />
      </div>
      <div className="read-body tool-edits">
        {edits.map((e, i) => {
          const whole = typeof e.oldText === "string" && typeof e.newText === "string" && !(drafting && i === edits.length - 1);
          return (
            <div key={i}>
              {edits.length > 1 && <p className="cap edit-n">Edit <span className="num">{i + 1}</span> of <span className="num">{edits.length}</span></p>}
              {whole ? <EditDiff oldText={e.oldText as string} newText={e.newText as string} />
                : <pre className="tool-draft">{[e.oldText, e.newText].filter((t) => typeof t === "string").join("\n")}</pre>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A value on one line: text, a number or true or false in colour, a list of words joined, or a dash for nothing. */
function inline(v: unknown): ReactNode | undefined {
  if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) return "—";
  if (typeof v === "number") return <span className="hljs-number">{v}</span>;
  if (typeof v === "boolean") return <span className="hljs-literal">{String(v)}</span>;
  if (typeof v === "string") return v.includes("\n") ? undefined : v;
  if (Array.isArray(v) && v.every((x) => (typeof x === "string" && !x.includes("\n") && x.length <= 80) || typeof x === "number")) return v.join(", ");
  return undefined;
}

/** Every argument as a name and its value; one of several lines, or a nested one, takes the full width as a block. */
export function ArgList({ args, writing }: { args: Args; /** The field she is still writing. */ writing?: string }) {
  const entries = Object.entries(args);
  if (!entries.length) return null;
  return (
    <dl className="tool-args">
      {entries.map(([k, v]) => {
        const one = inline(v);
        const text = typeof v === "string" ? v : JSON.stringify(v, null, 2);
        return [
          <dt key={`${k}:k`}>{k}</dt>,
          one !== undefined ? <dd key={`${k}:v`}>{one}</dd>
            : <dd key={`${k}:v`} className="wide"><Block text={text} kind={typeof v === "string" ? kindOf(v) : { kind: "code", lang: "json" }} copyLabel={`Copy ${k}`} plain={k === writing} /></dd>,
        ];
      })}
    </dl>
  );
}

const drop = (a: Args, ...keys: string[]): Args => Object.fromEntries(Object.entries(a).filter(([k]) => !keys.includes(k)));

/** A tool call's arguments, laid out by tool. `drafting`: she is still writing the call, its last field unfinished. */
export function ToolArgs({ name, args, drafting, fileHref }: { name: string; args: unknown; drafting: boolean; fileHref: FileHref }) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args === undefined ? null : <pre>{JSON.stringify(args, null, 2)}</pre>;
  const a = drop(args as Args, "machine");
  const writing = drafting ? Object.keys(a).at(-1) : undefined;
  const path = typeof a.path === "string" ? a.path : undefined;
  if (name === "write" && path && typeof a.content === "string") {
    return (
      <>
        <Block text={a.content} kind={kindOf(a.content, path)} title={basename(path)} href={fileHref(path)} copyLabel="Copy file text" plain={writing === "content"} />
        <ArgList args={drop(a, "path", "content")} />
      </>
    );
  }
  if (name === "edit" && path && editsOf(a).length) {
    return (
      <>
        <Edits path={path} edits={editsOf(a)} href={fileHref(path)} drafting={drafting} />
        <ArgList args={drop(a, "path", "edits", "oldText", "newText")} />
      </>
    );
  }
  if (name === "bash" && typeof a.command === "string") {
    const { timeout, background, ...rest } = drop(a, "command");
    const facts = [typeof timeout === "number" && <>Timeout <span className="num">{timeout}</span> s</>, background === true && "In the background"].filter(Boolean);
    return (
      <>
        <Block text={a.command} kind={{ kind: "code", lang: "bash" }} copyLabel="Copy command" plain={writing === "command"} />
        {facts.length > 0 && <p className="cap muted tool-facts">{facts.map((f, i) => <span key={i}>{i > 0 && " · "}{f}</span>)}</p>}
        <ArgList args={{ ...rest, ...(timeout !== undefined && typeof timeout !== "number" ? { timeout } : {}), ...(background !== undefined && typeof background !== "boolean" ? { background } : {}) }} />
      </>
    );
  }
  return <ArgList args={a} writing={writing} />;
}

/** A successful write's or edit's result as a short facts line in place of Pi's sentence; nothing for any other. */
export function resultFacts(name: string, args: unknown, result: string | undefined, isError: boolean | undefined): ReactNode | undefined {
  if (isError || result === undefined || !args || typeof args !== "object") return undefined;
  const a = args as Args;
  if (name === "write" && typeof a.content === "string" && result.startsWith("Successfully wrote")) {
    const bytes = new TextEncoder().encode(a.content).length;
    return <p className="cap muted tool-facts">Wrote <span className="num">{bytes.toLocaleString("en-US")}</span> {bytes === 1 ? "byte" : "bytes"}</p>;
  }
  if (name === "edit" && result.startsWith("Successfully replaced")) {
    const n = editsOf(a).length;
    return <p className="cap muted tool-facts">Edited <span className="num">{n}</span> {n === 1 ? "place" : "places"}</p>;
  }
  return undefined;
}
