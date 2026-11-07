import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MemoryDetail, MemoryHistory, ThreadSummary } from "@lyrica/daemon/api";
import { browser, daemon, login, runtime } from "../../daemon/test/helpers.ts";
import { chat } from "../chat.ts";
import { Interrupted, type Io } from "../client.ts";
import { mem } from "../mem.ts";

// `lyrica chat` and `lyrica mem` against a real lyricad over its socket,
// with a scripted terminal (docs/briefs/terminal-clients.md, D).

type Answer = string | ((question: string, initial?: string) => string);

/** A terminal that answers from a script; past its end, Ctrl-D. */
function fakeIo(answers: Answer[]) {
  const out: string[] = [], err: string[] = [], asked: string[] = [];
  const io: Io = {
    async ask(question, opts = {}) {
      asked.push(question);
      const a = answers.shift();
      if (a === undefined) throw new Interrupted();
      return typeof a === "function" ? a(question, opts.initial) : a;
    },
    out: (t) => void out.push(t),
    err: (t) => void err.push(t),
    onInterrupt: () => () => {},
  };
  return { io, out, err, asked };
}

async function setup(opts: { clientSocket?: string } = {}) {
  const rt = await runtime();
  const dm = await daemon(rt, opts);
  await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
  const ada = await login(dm.base, "ada", "pw");
  return { rt, dm, ada, u: `/api/u/${rt.ada.id}`, socket: dm.d.socketPath! };
}

const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? [p, ...files(p)] : [p]; });

describe("lyrica chat and lyrica mem", () => {
  it("sign in over the group socket with a password, and refuse a wrong one or a missing socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lyrica-clients-"));
    const clientSocket = join(dir, "lyricad.sock");
    try {
      const s = await setup({ clientSocket });
      expect(statSync(clientSocket).mode & 0o777).toBe(0o660);
      await s.ada.post(`${s.u}/memory/general/notes`, { text: "{user} keeps marigold seeds in a tin" });
      const ok = fakeIo(["pw"]);
      await mem(["search", "marigold", "--login", "ada"], { socket: clientSocket }, ok.io);
      expect(ok.asked).toEqual(["Password: "]);
      expect(ok.out.join("")).toMatch(/general\/n:\S+ {2}note .*Ada keeps marigold seeds in a tin/);

      await expect(mem(["search", "marigold", "--login", "ada"], { socket: clientSocket }, fakeIo(["wrong"]).io)).rejects.toThrow("wrong login or password");
      await expect(mem(["search", "x"], { socket: join(dir, "missing.sock") }, fakeIo([]).io)).rejects.toThrow("lyricad isn't running");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Root reads any socket, so this needs an ordinary account.
  it.skipIf(process.getuid?.() === 0)("tells an account outside the group how to get in", async () => {
    const s = await setup();
    chmodSync(s.socket, 0o000);
    await expect(mem(["search", "x"], { socket: s.socket }, fakeIo([]).io)).rejects.toThrow("lyrica-clients group");
  });

  it("start lyricad without the group socket when its folder is missing", async () => {
    const s = await setup({ clientSocket: join(tmpdir(), "no-such-lyrica-clients", "lyricad.sock") });
    expect(s.dm.logs.join("\n")).toContain("the lyrica-clients socket");
    expect((await s.ada.get(`${s.u}/threads`)).status).toBe(200);
  });

  it("keeps terminal threads out of the web's list, and web threads out of the terminal's", async () => {
    const s = await setup();
    const web = (await s.ada.post<ThreadSummary>(`${s.u}/threads`, { pool: "general", title: "Garden" })).body;
    const t = fakeIo(["pw"]);
    await chat(["--login", "ada"], { socket: s.socket }, t.io);
    // No terminal threads yet, so it made one and went to the prompt.
    expect(t.asked).toEqual(["Password: ", "> "]);
    const cli = (await s.ada.get<ThreadSummary[]>(`${s.u}/threads?interface=cli`)).body;
    expect(cli.map((x) => x.id)).toHaveLength(1);
    expect(cli[0]!.id).toMatch(/^cli\//);
    expect((await s.ada.get<ThreadSummary[]>(`${s.u}/threads`)).body.map((x) => x.id)).toEqual([web.id]);

    // Next time it offers that one, not the web's.
    const again = fakeIo(["pw", ""]);
    await chat(["--login", "ada"], { socket: s.socket }, again.io);
    expect(again.err.join("\n")).toContain("1. Untitled");
    expect(again.err.join("\n")).not.toContain("Garden");
  });

  it("edits a memory as a new revision, keeping its mention tokens, and leaves no file behind", async () => {
    const s = await setup();
    const note = (await s.ada.post<MemoryDetail>(`${s.u}/memory/general/notes`, { text: "{user} keeps marigold seeds in a tin" })).body;
    const id = note.item.id;
    const home = mkdtempSync(join(tmpdir(), "lyrica-home-")), tmp = mkdtempSync(join(tmpdir(), "lyrica-tmp-"));
    const saved = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
    let seen: string | undefined;
    try {
      process.env.HOME = home; process.env.TMPDIR = tmp;
      const t = fakeIo(["pw", "1", (_q, initial) => { seen = initial; return initial!.replace("a tin", "a jar"); }, "s"]);
      await mem(["edit", id, "--login", "ada"], { socket: s.socket }, t.io);
      expect(seen).toBe("{Ada} keeps marigold seeds in a tin");
      const out = fakeIo(["pw"]);
      await mem(["export", id, "--login", "ada"], { socket: s.socket }, out.io);
      expect(out.out.join("")).toContain("keeps marigold seeds in a jar");
      expect(files(home)).toEqual([]);
      expect(files(tmp)).toEqual([]);
    } finally {
      process.env.HOME = saved.HOME;
      if (saved.TMPDIR === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved.TMPDIR;
      rmSync(home, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true });
    }
    const path = `${s.u}/memory/general/${encodeURIComponent(id)}`;
    expect((await s.ada.get<MemoryDetail>(path)).body.item.text).toBe(`[[u:${s.rt.ada.id}]] keeps marigold seeds in a jar`);
    const history = (await s.ada.get<MemoryHistory>(`${path}/history`)).body;
    expect(history.entries.map((e) => e.body.text)).toEqual([
      `[[u:${s.rt.ada.id}]] keeps marigold seeds in a jar`,
      `[[u:${s.rt.ada.id}]] keeps marigold seeds in a tin`,
    ]);
  });

  it("forgets only the memories picked, leaving tombstones", async () => {
    const s = await setup();
    const add = async (text: string) => (await s.ada.post<MemoryDetail>(`${s.u}/memory/general/notes`, { text })).body.item.id;
    const ids = [await add("A quokka lives on the island"), await add("The quokka smiles"), await add("A quokka hops at dusk")];
    const t = fakeIo(["pw", "1 3", "y"]);
    await mem(["forget", "quokka", "--login", "ada"], { socket: s.socket }, t.io);
    // The numbers as the list showed them.
    const listed = t.err.filter((l) => /^ +\d+\. /.test(l)).map((l) => ids.find((id) => l.includes(id))!);
    expect(listed.sort()).toEqual([...ids].sort());
    const gone = [listed[0]!, listed[2]!], kept = listed[1]!;
    expect(t.err.join("\n")).toContain("Forgot 2.");
    for (const id of gone) expect((await s.ada.get(`${s.u}/memory/general/${encodeURIComponent(id)}`)).status).toBe(404);
    expect((await s.ada.get(`${s.u}/memory/general/${encodeURIComponent(kept)}`)).status).toBe(200);
    const o = s.dm.d.services!.memory.openOwnerView(s.rt.ada.id);
    try {
      for (const id of gone) expect(o.general.isFree(id)).toBe(false);
    } finally {
      o.close();
    }

    // "none" forgets nothing.
    await mem(["forget", "quokka", "--login", "ada"], { socket: s.socket }, fakeIo(["pw", "none"]).io);
    expect((await s.ada.get(`${s.u}/memory/general/${encodeURIComponent(kept)}`)).status).toBe(200);
  });
});
