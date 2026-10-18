import { EventEmitter } from "node:events";
import type { UserEvent } from "./api.ts";

/** Principles 2 and 8: per-user invalidation only, with no text or durable state. */
export class UserEvents {
  private readonly events = new EventEmitter();
  private readonly pending = new Map<string, NodeJS.Timeout>();

  constructor() { this.events.setMaxListeners(0); }

  subscribe(userId: string, listener: (event: UserEvent) => void): () => void {
    this.events.on(userId, listener);
    return () => {
      this.events.off(userId, listener);
      if (!this.events.listenerCount(userId)) {
        clearTimeout(this.pending.get(userId));
        this.pending.delete(userId);
      }
    };
  }

  changed(userId: string): void {
    if (!this.events.listenerCount(userId) || this.pending.has(userId)) return;
    this.pending.set(userId, setTimeout(() => {
      this.pending.delete(userId);
      this.events.emit(userId, { type: "changed" } satisfies UserEvent);
    }, 250));
  }

  close(): void {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.events.removeAllListeners();
  }
}
