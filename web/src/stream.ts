// A thread's stored messages plus its live event stream.
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { get, threadPath, type Message, type MessagePage, type Pool, type QuestionState, type ThreadEvent } from "./api.ts";
import { initialLive, liveReducer } from "./live.ts";

// Every event the stream sends, each listened for by name: a new ThreadEvent type fails the typecheck until it's here.
const LISTENED: Record<ThreadEvent["type"], true> = {
  hello: true, reset: true, turn_start: true, message_start: true, text: true, thinking: true, tool_call: true, tool_start: true, tool_end: true,
  recall: true, remember: true, permission: true, permission_end: true, usage: true, queue: true, received: true, error: true,
  offline: true, title: true, settings: true, turn_end: true, delegation: true, notice: true, rewound: true, child: true,
  reactions: true, steps: true, wakeups: true, context: true, compacted: true,
};
const EVENT_TYPES = Object.keys(LISTENED) as ThreadEvent["type"][];

export function useThread(userId: string, pool: Pool, threadId: string) {
  const [questions, setQuestions] = useState<QuestionState[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [connected, setConnected] = useState(true);
  const [live, dispatch] = useReducer(liveReducer, initialLive);
  // A rewind this view asked for sends a message again: shown as sent until the turn is stored.
  const resending = useRef<string | undefined>(undefined);
  const willResend = useCallback((text: string | undefined) => { resending.current = text; }, []);
  const base = threadPath(userId, pool, threadId);

  // Stored messages: the newest page, merged with any older pages already shown.
  useEffect(() => {
    let current = true;
    get<MessagePage>(`${base}/messages`).then((page) => {
      if (!current) return;
      setMessages((old) => mergeByN(old, page.messages));
      setQuestions(page.questions ?? []);
      if (!loaded) setHasMore(page.hasMore);
      setLoaded(true);
      setLoadError("");
      dispatch({ type: "stored" });
    }, (e: Error) => current && setLoadError(e.message));
    return () => { current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, live.reload, live.settings]);

  const loadOlder = useCallback(async () => {
    const first = messages[0];
    if (!first) return;
    const page = await get<MessagePage>(`${base}/messages?before=${first.n}`);
    setMessages((old) => mergeByN(page.messages, old));
    setHasMore(page.hasMore);
  }, [base, messages]);

  /** Loads older pages until message `n` is among the messages (or there are no more), to open the thread there. */
  const loadUntil = useCallback(async (n: number) => {
    let first = messages[0]?.n;
    let more = hasMore;
    const older: Message[] = [];
    while (more && first !== undefined && first > n) {
      const page = await get<MessagePage>(`${base}/messages?before=${first}&limit=200`);
      older.unshift(...page.messages);
      more = page.hasMore && page.messages.length > 0;
      first = page.messages[0]?.n;
    }
    setMessages((old) => mergeByN(older, old));
    setHasMore(more);
  }, [base, messages, hasMore]);

  // The event stream. EventSource reconnects by itself with Last-Event-ID. If
  // it gives up (an HTTP error, say while lyricad restarts), a new one can't
  // send that header, so we reload from stored messages instead. One GET also
  // checks the login, so a logout in another tab shows at once.
  useEffect(() => {
    let es: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 1000;
    let stopped = false;
    const open = () => {
      es = new EventSource(`${base}/events`);
      for (const type of EVENT_TYPES) {
        es.addEventListener(type, (m: MessageEvent<string>) => {
          if (type === "hello") { setConnected(true); delay = 1000; }
          try {
            const e = JSON.parse(m.data) as ThreadEvent;
            // Removed messages go at once; the reload brings what's left.
            if (e.type === "rewound") setMessages((old) => old.filter((x) => x.n < e.from));
            // A reaction, hers or from another tab, lands on the stored message at once.
            if (e.type === "reactions") setMessages((old) => old.map((x) => (x.n === e.n ? { ...x, reactions: e.reactions.length ? e.reactions : undefined } : x)));
            dispatch(e);
            // The re-sent message is stored at or after the rewind point, so its stored copy replaces this one as a send's does.
            if (e.type === "rewound" && e.resend && resending.current !== undefined) dispatch({ type: "sent", text: resending.current, afterN: e.from - 1 });
            if (e.type === "rewound") resending.current = undefined;
            // In a subagent's own thread, its work is stored as it goes: show it.
            if (e.type === "delegation" && e.event.threadId === threadId && e.event.type !== "output" && e.event.type !== "tool_call") dispatch({ type: "refresh" });
          } catch { /* not ours */ }
        });
      }
      es.onopen = () => setConnected(true);
      // A thread's own `error` event (a failed or stopped turn) arrives here too, as a MessageEvent: the stream is fine.
      es.onerror = (ev) => {
        if (ev instanceof MessageEvent) return;
        setConnected(false);
        if (es?.readyState !== EventSource.CLOSED || stopped) return;
        get(base).catch(() => {});
        retry = setTimeout(() => { dispatch({ type: "reset" }); open(); }, delay);
        delay = Math.min(delay * 2, 30_000);
      };
    };
    open();
    return () => { stopped = true; es?.close(); clearTimeout(retry); };
  }, [base, threadId]);

  return { messages, questions, hasMore, loaded, loadError, loadOlder, loadUntil, live, dispatch, connected, willResend };
}

function mergeByN(a: Message[], b: Message[]): Message[] {
  const byN = new Map<number, Message>();
  for (const m of [...a, ...b]) byN.set(m.n, m);
  return [...byN.values()].sort((x, y) => x.n - y.n);
}
