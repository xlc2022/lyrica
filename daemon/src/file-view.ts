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
 * `sealed` (a built React artifact in Lyrica's own frame, internet off; the owner, 2026-11-12): its scripts run, but
 * it may load and connect to nothing, open no window and send no form, and the app's own `default-src 'self'` stops
 * the frame navigating away, and `fromLyrica` stops it navigating to another of Lyrica's own pages that has the
 * internet. One way out is left that no header closes: WebRTC, which Chromium lets a page open whatever its CSP
 * says. `SEAL_PRELUDE` removes it from the page's window, which stops a library reaching for it but not a page
 * written to get it back; the owner accepted that for these pages. A second may exist: a browser may look up a
 * host named in a `dns-prefetch` or `preconnect` link whatever the CSP says, which could carry a few bytes in the
 * names. The headless Chromium tested here looked none up, with or without a CSP, so that is unproven either way;
 * `X-DNS-Prefetch-Control: off` is sent on a sealed page, and a page with no scripts could always carry such a link.
 * SVG: nothing runs. PDF: no sandbox and no source list, since browsers refuse to show a PDF in a sandbox and some
 * versions of Chrome's viewer under `default-src 'none'`; its bytes are checked to be a PDF's first, and nosniff keeps
 * it a PDF. Each may be framed only by Lyrica's own pages.
 */
export function viewHeaders(kind: ViewKind, size: number, internet = true, sealed = false): Record<string, string> {
  const csp = kind === "html"
    ? internet
      ? "sandbox allow-scripts allow-popups; default-src https: data: blob: 'unsafe-inline' 'unsafe-eval'; form-action 'none'; frame-ancestors 'self'"
      : sealed
        ? "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; frame-ancestors 'self'"
        : "sandbox; default-src data: blob: 'unsafe-inline'; form-action 'none'; frame-ancestors 'self'"
    : kind === "svg" ? "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox; frame-ancestors 'self'"
    : "frame-ancestors 'self'";
  return {
    "content-type": kind === "html" ? "text/html; charset=utf-8" : kind === "svg" ? "image/svg+xml" : "application/pdf",
    "content-length": String(size), "cache-control": "no-store", "content-security-policy": csp,
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cross-origin-resource-policy": "same-origin",
    ...(sealed ? { "x-dns-prefetch-control": "off" } : {}),
  };
}

/**
 * Whether a request for a page came from Lyrica's own interface or the user (the address bar, a bookmark), by the
 * browser's `Sec-Fetch-Site`; a client that sends no fetch metadata is let through. A page in the viewer has an
 * opaque origin, so a navigation it starts is `cross-site` and is refused: otherwise a page with the internet off
 * could send its frame to a page of a thread with it on, carrying what it holds in the address.
 */
export const fromLyrica = (site: string | string[] | undefined): boolean => site === undefined || site === "same-origin" || site === "none";

/**
 * Runs first in an HTML page: its console messages and uncaught errors go to the viewer as text, so the viewer can
 * show them under the page. The page could send look-alikes; the viewer only ever shows them as text.
 */
export const CONSOLE_BRIDGE = `<script>(()=>{const send=(level,args)=>{try{parent.postMessage({lyricaConsole:1,level,text:args.map(a=>{try{return typeof a==="string"?a:a instanceof Error?(a.stack||String(a)):JSON.stringify(a)}catch{return String(a)}}).join(" ").slice(0,4000)},"*")}catch{}};for(const level of["log","info","warn","error","debug"]){const own=console[level];console[level]=(...a)=>{send(level,a);return own.apply(console,a)}}addEventListener("error",e=>send("error",[e.message+(e.filename?" ("+e.filename+":"+e.lineno+")":"")]));addEventListener("unhandledrejection",e=>send("error",["Uncaught (in promise) "+((e.reason&&e.reason.stack)||e.reason)]))})()</script>`;

/** Runs before anything else in a sealed page: WebRTC is gone from its window (see `viewHeaders`; not a boundary). */
export const SEAL_PRELUDE = `<script>for(const k of["RTCPeerConnection","webkitRTCPeerConnection","RTCDataChannel","RTCSessionDescription","RTCIceCandidate","RTCRtpSender","RTCRtpReceiver"])try{Object.defineProperty(window,k,{value:undefined,writable:false,configurable:false})}catch{}</script>`;

/** The page with the console bridge first: after a doctype, so the page keeps its standards mode, else at the start. `first` goes before the bridge. */
export function withConsole(html: Buffer, first = ""): Buffer {
  const text = html.toString("utf8");
  const doctype = /^﻿?\s*<!doctype[^>]*>/i.exec(text);
  const at = doctype ? doctype[0].length : 0;
  return Buffer.from(text.slice(0, at) + first + CONSOLE_BRIDGE + text.slice(at), "utf8");
}

/** A PDF starts with its signature; anything else named .pdf isn't shown as one. */
export const isPdf = (bytes: Buffer) => bytes.subarray(0, 5).toString("latin1") === "%PDF-";
