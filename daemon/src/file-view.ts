// A file as a page for the web's viewer (docs/ux.md §6, A file opened from a library): an HTML file runs in a
// sandbox with an opaque origin, so it never reaches Lyrica's cookies, storage or API; an SVG shows as an image with
// nothing run; a PDF opens in the browser's own viewer. GET …/files/content stays plain text for all of them.
import { posix } from "node:path";

/** The largest file served as a page; a bigger one is offered as a download. */
export const VIEW_LIMIT = 16 * 1024 * 1024;

export type ViewKind = "html" | "svg" | "pdf";

/** What a file opens as in the viewer's frame, by its name; anything else isn't served as a page. */
export function viewKind(path: string): ViewKind | undefined {
  const ext = posix.extname(path).slice(1).toLowerCase();
  return ext === "html" || ext === "htm" ? "html" : ext === "svg" ? "svg" : ext === "pdf" ? "pdf" : undefined;
}

/**
 * The page's headers. HTML: the CSP `sandbox` (scripts and popups only, never `allow-same-origin`) gives the
 * document an opaque origin even when it is opened on its own, so the session cookie (SameSite=Strict) never goes
 * with its requests and Lyrica's responses (CORP same-origin, no CORS) can't be read. It may load https resources, as
 * a file opened in the browser could, unless the thread's internet is off (`internet` false): then nothing runs and
 * it loads only what it carries inline, so it can't send anything out by itself; a link the user clicks still goes.
 * SVG: nothing runs. PDF: no sandbox and no source list, since browsers refuse to show a PDF in a sandbox and some
 * versions of Chrome's viewer under `default-src 'none'`; its bytes are checked to be a PDF's first, and nosniff keeps
 * it a PDF. Each may be framed only by Lyrica's own pages.
 */
export function viewHeaders(kind: ViewKind, size: number, internet = true): Record<string, string> {
  const csp = kind === "html"
    ? internet
      ? "sandbox allow-scripts allow-popups; default-src https: data: blob: 'unsafe-inline' 'unsafe-eval'; form-action 'none'; frame-ancestors 'self'"
      : "sandbox; default-src data: blob: 'unsafe-inline'; form-action 'none'; frame-ancestors 'self'"
    : kind === "svg" ? "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox; frame-ancestors 'self'"
    : "frame-ancestors 'self'";
  return {
    "content-type": kind === "html" ? "text/html; charset=utf-8" : kind === "svg" ? "image/svg+xml" : "application/pdf",
    "content-length": String(size), "cache-control": "no-store", "content-security-policy": csp,
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cross-origin-resource-policy": "same-origin",
  };
}

/**
 * Runs first in an HTML page: its console messages and uncaught errors go to the viewer as text, so the viewer can
 * show them under the page. The page could send look-alikes; the viewer only ever shows them as text.
 */
export const CONSOLE_BRIDGE = `<script>(()=>{const send=(level,args)=>{try{parent.postMessage({lyricaConsole:1,level,text:args.map(a=>{try{return typeof a==="string"?a:a instanceof Error?(a.stack||String(a)):JSON.stringify(a)}catch{return String(a)}}).join(" ").slice(0,4000)},"*")}catch{}};for(const level of["log","info","warn","error","debug"]){const own=console[level];console[level]=(...a)=>{send(level,a);return own.apply(console,a)}}addEventListener("error",e=>send("error",[e.message+(e.filename?" ("+e.filename+":"+e.lineno+")":"")]));addEventListener("unhandledrejection",e=>send("error",["Uncaught (in promise) "+((e.reason&&e.reason.stack)||e.reason)]))})()</script>`;

/** The page with the console bridge first: after a doctype, so the page keeps its standards mode, else at the start. */
export function withConsole(html: Buffer): Buffer {
  const text = html.toString("utf8");
  const doctype = /^﻿?\s*<!doctype[^>]*>/i.exec(text);
  const at = doctype ? doctype[0].length : 0;
  return Buffer.from(text.slice(0, at) + CONSOLE_BRIDGE + text.slice(at), "utf8");
}

/** A PDF starts with its signature; anything else named .pdf isn't shown as one. */
export const isPdf = (bytes: Buffer) => bytes.subarray(0, 5).toString("latin1") === "%PDF-";
