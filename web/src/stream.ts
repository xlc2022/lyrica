// A thread's stored messages plus its live event stream.
import { useCallback, useEffect, useReducer, useState } from "react";
import { get, threadPath, type Message, type MessagePage, type Pool, type ThreadEvent } from "./api.ts";
import { initialLive, liveReducer } from "./live.ts";

const EVENT_TYPES: ThreadEvent["type"][] = [
  "hello", "reset", "turn_start", "message_start", "text", "thinking", "tool_start", "tool_end", "recall", "remember",
  "permission", "permission_end", "usage", "queue", "error", "title", "turn_end", "delegation", "notice",
];

export function useThread(userId: string, pool: Pool, threadId: string) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [connected, setConnected] = useState(true);
  const [live, dispatch] = useReducer(liveReducer, initialLive);
  const base = threadPath(userId, pool, threadId);

  // Stored messages: the newest page, merged with any older pages already shown.
  useEffect(() => {
    let current = true;
    get<MessagePage>(`${base}/messages`).then((page) => {
      if (!current) return;
      setMessages((old) => mergeByN(old, page.messages));
      if (!loaded) setHasMore(page.hasMore);
      setLoaded(true);
      setLoadError("");
      dispatch({ type: "stored" });
    }, (e: Error) => current && setLoadError(e.message));
    return () => { current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, live.reload]);

  const loadOlder = useCallback(async () => {
    const first = messages[0];
    if (!first) return;
    const page = await get<MessagePage>(`${base}/messages?before=${first.n}`);
    setMessages((old) => mergeByN(page.messages, old));
    setHasMore(page.hasMore);
  }, [base, messages]);

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
          try { dispatch(JSON.parse(m.data) as ThreadEvent); } catch { /* not ours */ }
        });
      }
      es.onerror = () => {
        setConnected(false);
        if (es?.readyState !== EventSource.CLOSED || stopped) return;
        get(base).catch(() => {});
        retry = setTimeout(() => { dispatch({ type: "reset" }); open(); }, delay);
        delay = Math.min(delay * 2, 30_000);
      };
    };
    open();
    return () => { stopped = true; es?.close(); clearTimeout(retry); };
  }, [base]);

  return { messages, hasMore, loaded, loadError, loadOlder, live, dispatch, connected };
}

function mergeByN(a: Message[], b: Message[]): Message[] {
  const byN = new Map<number, Message>();
  for (const m of [...a, ...b]) byN.set(m.n, m);
  return [...byN.values()].sort((x, y) => x.n - y.n);
}
