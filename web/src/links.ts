// What the Files panel asks of the conversation beside it: attach a path to the
// message box, or show the message a file came from; and what a search hit in
// the sidebar asks: open the thread at a message. Each is a window event
// answered by this thread's component when it is on the page, else kept in
// session storage for it (the Files page on a phone has no conversation).
// Only paths and message numbers are kept, never message text.
export interface AttachRequest { base: string; paths: string[]; handled?: boolean }
export const ATTACH_EVENT = "lyrica:attach";
export const ATTACH_KEY = "lyrica.attach";

/** An inline image asks the composer to start an edit; only a path is passed. */
export interface EditImageRequest { base: string; path: string; handled?: boolean }
export const EDIT_IMAGE_EVENT = "lyrica:edit-image";

export interface ShowRequest { base: string; path: string; handled?: boolean; found?: boolean }
export const SHOW_EVENT = "lyrica:show";
export const SHOW_KEY = "lyrica.show";

export interface JumpRequest { base: string; n: number; handled?: boolean }
export const JUMP_EVENT = "lyrica:jump";
export const JUMP_KEY = "lyrica.jump";

/** Sends a request to the thread on this page; false when no thread took it. */
export function ask<T extends { handled?: boolean }>(event: string, detail: T): boolean {
  dispatchEvent(new CustomEvent(event, { detail }));
  return !!detail.handled;
}
/** Keeps a request for the thread's page, and takes it back there. */
export function keep(key: string, req: unknown) { try { sessionStorage.setItem(key, JSON.stringify(req)); } catch { /* lost */ } }
export function take<T>(key: string, base: string): T | undefined {
  try {
    const kept = sessionStorage.getItem(key);
    if (!kept) return undefined;
    const req = JSON.parse(kept) as T & { base: string };
    if (req.base !== base) return undefined;
    sessionStorage.removeItem(key);
    return req;
  } catch { return undefined; }
}

/** Refusal actions pass text in memory only, never session storage. */
export interface EditMessageRequest { base: string; text: string; handled?: boolean }
export const EDIT_MESSAGE_EVENT = "lyrica:edit-message";
