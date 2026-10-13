// What stays where a thread was deleted with its memories kept: its ID, when it went, and the memories that came from it.
import { type Pool, type ThreadTombstone } from "./api.ts";
import { Main } from "./Shell.tsx";
import { firstWords, longDate, plainCitations } from "./memory.ts";
import { readable } from "./mentions.ts";
import { href, idHref } from "./route.ts";

export function Tombstone({ userId, pool, data }: { userId: string; pool: Pool; data: ThreadTombstone }) {
  const name = (id: string) => {
    const l = data.links[id];
    if (!l) return "a memory";
    return (l.title && readable(l.title, data.users)) || firstWords(plainCitations(readable(l.snippet, data.users))) || "a memory";
  };
  return (
    <Main className="main">
      <header className="head thread-head">
        <div className="head-title">
          <h1>Deleted thread</h1>
          <p className="mono">{data.id}</p>
        </div>
      </header>
      <div className="scroll">
        <p>Deleted <span className="num">{longDate(data.deletedAt)}</span>.</p>
        <h2>Memories from it</h2>
        {data.memories.length === 0 ? <p>No memories from it.</p> : (
          <ul>
            {data.memories.map((m) => (
              <li key={m.id}><a href={idHref(userId, pool, m.id)}>{name(m.id)}</a>{data.links[m.id] && <span className="cap"> {data.links[m.id]!.kind}</span>}</li>
            ))}
          </ul>
        )}
        <p><a href={href({ page: "home", userId })}>Home</a></p>
      </div>
    </Main>
  );
}
