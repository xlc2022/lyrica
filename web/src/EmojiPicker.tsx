// The full emoji picker (emoji-picker-element, Apache-2.0), loaded only when More emoji is pressed. Its data is
// served with the UI, never fetched from a CDN; the browser keeps it in IndexedDB after the first open.
import "emoji-picker-element";
import type { EmojiClickEvent } from "emoji-picker-element/shared";
import dataUrl from "emoji-picker-element-data/en/emojibase/data.json?url";
import { useEffect, useRef } from "react";
import { usePickerTheme } from "./Reactions.tsx";

export default function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const ref = useRef<HTMLElement>(null);
  const theme = usePickerTheme();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const on = (e: Event) => { const u = (e as EmojiClickEvent).detail.unicode; if (u) onPick(u); };
    el.addEventListener("emoji-click", on);
    // The search box takes focus, as the picker opened from a button that the row no longer holds.
    el.shadowRoot?.querySelector<HTMLInputElement>("input")?.focus();
    return () => el.removeEventListener("emoji-click", on);
  }, [onPick]);
  // A custom element: React passes attributes, so the data source goes as one.
  return <emoji-picker ref={ref} class={theme} data-source={dataUrl} />;
}

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "emoji-picker": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & { class?: string; "data-source"?: string };
    }
  }
}
