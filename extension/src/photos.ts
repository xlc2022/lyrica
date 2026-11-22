// Principle 2: a photo of the user reaches a cloud model only under the user's photo setting (Never, Ask once a
// day, Always). The image and look tools ask before they send one; this keeps one that came back in a tool result
// (an edit of their photo, a read of a file marked as one, a clip's first frame) out of a cloud chat model's request.
// A tool result that holds one says so in its details, which the thread's stored entry keeps; every request a
// thread's model runtime sends to a cloud endpoint leaves those images out unless the setting allows them now.
import type { WorkspaceSettings } from "@lyrica/core";

/** The details key a tool result holding a photo of the user sets. */
export const PHOTO_OF_USER = "photoOfUser";

/** In place of a photo of the user left out of a cloud model's request. */
export const PHOTO_LEFT_OUT = "[A photo of the user, left out: their photo setting keeps photos of them from cloud models. Don't describe it or say you saw it.]";

/** The local day an approval under Ask lasts for. */
export const dayOf = (date: Date) => `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;

/** Whether a photo of the user may go to a cloud model now without asking: Always, or Ask approved today. */
export function photosToCloud(s: Pick<WorkspaceSettings, "photoCloudPolicy" | "photoCloudApproved">, now = new Date()): boolean {
  const policy = s.photoCloudPolicy();
  return policy === "always" || (policy === "ask" && s.photoCloudApproved(dayOf(now)));
}

/** A tool result's details, marked as holding a photo of the user. */
export function markPhoto<T>(details: T): T & { [PHOTO_OF_USER]: true } {
  return { ...(details && typeof details === "object" ? details : {}), [PHOTO_OF_USER]: true } as T & { [PHOTO_OF_USER]: true };
}

type Message = { role?: string; content?: unknown; details?: unknown };

const marked = (m: Message) => m.role === "toolResult" && !!m.details && typeof m.details === "object" && (m.details as Record<string, unknown>)[PHOTO_OF_USER] === true;

/** The messages with the images of every tool result marked as a photo of the user in words instead. */
export function withoutPhotos<T extends Message>(messages: T[]): T[] {
  let changed = false;
  const out = messages.map((m) => {
    if (!marked(m) || !Array.isArray(m.content) || !(m.content as { type: string }[]).some((b) => b.type === "image")) return m;
    changed = true;
    return { ...m, content: (m.content as { type: string }[]).map((b) => (b.type === "image" ? { type: "text", text: PHOTO_LEFT_OUT } : b)) };
  });
  return changed ? out : messages;
}
