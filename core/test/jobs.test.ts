import { describe, expect, it } from "vitest";
import { JOB_LIMITS, jobNotice, Jobs, machineReady, NOTICE_LIMITS, sleepWait, type ExecutionTarget, type JobInfo } from "../src/index.ts";
import { capOutput } from "../src/workspace/ops.ts";

const thread = { userId: "u1", pool: "general", threadId: "t1" };

/**
 * A target whose commands run until their signal aborts or `done` is called. Like the sandbox's and a machine's,
 * what a command prints (`onData` here) reaches `onRaw` whole and the caller's `onData` cut (capOutput).
 */
function fakeTarget() {
  const running = new Map<string, { onData: (d: Buffer) => void; done: (code: number) => void }>();
  const target: ExecutionTarget = {
    name: "sandbox",
    cwd: async () => "/workspace",
    folders: () => [],
    ops: () => ({
      bash: {
        exec: (command: string, _cwd: string, o: { onData: (d: Buffer) => void; onRaw?: (d: Buffer) => void; signal?: AbortSignal }) => new Promise<{ exitCode: number }>((resolve, reject) => {
          const out = capOutput(o.onData);
          running.set(command, { onData: (d) => { out.push(d); o.onRaw?.(d); }, done: (code) => { out.end(); resolve({ exitCode: code }); } });
          o.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      },
    }) as unknown as ReturnType<ExecutionTarget["ops"]>,
  };
  return { target, running };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("Jobs", () => {
  it("runs a command in the background and reports its end once, with its output", async () => {
    const ended: { job: JobInfo; output: string }[] = [];
    const jobs = new Jobs((_t, job, output) => ended.push({ job, output }));
    const { target, running } = fakeTarget();
    const job = jobs.start(thread, "sandbox", target, "make", "/workspace");
    expect(job).toMatchObject({ id: "j1", state: "running", command: "make" });
    running.get("make")!.onData(Buffer.from("building\ndone\n"));
    expect(jobs.output(thread, "j1")!.output).toContain("building");
    running.get("make")!.done(0);
    await tick();
    expect(ended).toHaveLength(1);
    expect(ended[0]!.job).toMatchObject({ state: "exited", exitCode: 0 });
    expect(jobNotice(ended[0]!.job, ended[0]!.output)).toMatch(/^Background command j1 in the sandbox, exited with code 0 after \d+ s: make\nLast output:\nbuilding\ndone$/);
  });

  it("keeps a long job's whole output, in the sandbox and on a machine, not the cut a call's result gets", async () => {
    const saved: Buffer[] = [];
    const jobs = new Jobs(() => {}, 10_000, { save: (_t, _job, output) => saved.push(output) });
    const { target, running } = fakeTarget();
    // Like `seq 1 200000`: about 1.2 MB in many pieces, far past the 20 KB and 800 lines a call's result keeps.
    const lines = Array.from({ length: 200_000 }, (_, i) => `${i + 1}\n`).join("");
    for (const [place, cwd] of [["sandbox", "/workspace"], ["nautica", async () => "/home/lyrica"]] as const) {
      jobs.start(thread, place, target, `seq ${place}`, cwd);
      await tick();
      for (let i = 0; i < lines.length; i += 65_536) running.get(`seq ${place}`)!.onData(Buffer.from(lines.slice(i, i + 65_536)));
      running.get(`seq ${place}`)!.done(0);
      await tick();
    }
    expect(saved).toHaveLength(2);
    for (const output of saved) {
      expect(output.toString("utf8")).toBe(lines);
      expect(output.toString("utf8")).not.toContain("left out");
    }
  });

  it("ends a job's notice with a bounded tail: a 1 MB line or thousands of lines stay within a few KB, and say where the rest is", () => {
    const job: JobInfo = { id: "j4", place: "sandbox", command: "docker pull x", cwd: "/workspace", startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:01:00Z", state: "exited", exitCode: 0 };
    const bar = `${"=".repeat(1024 * 1024)}> 100%`;
    const huge = jobNotice(job, `${bar}\ndone\n`);
    expect(huge.length).toBeLessThan(NOTICE_LIMITS.chars + 500);
    expect(huge).toContain("jobs output with id j4 reads the whole output");
    expect(huge).toMatch(/\[… [\d,]+ characters\] =+> 100%\ndone$/);
    const many = jobNotice(job, Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n"));
    expect(many.length).toBeLessThan(NOTICE_LIMITS.chars + 500);
    expect(many).toMatch(/\[… [\d,]+ characters before these lines left out; jobs output with id j4 reads the whole output\]\nline 4961\n/);
    expect(many.endsWith("line 5000")).toBe(true);
    // A short output is as it was, with no marker.
    expect(jobNotice(job, "a\nb\n")).toMatch(/Last output:\na\nb$/);
  });

  it("waits for a machine that doesn't answer yet (rebooting), then runs there; a changed host key ends it at once", async () => {
    const ended: JobInfo[] = [];
    const jobs = new Jobs((_t, job) => ended.push(job), 5);
    const { target, running } = fakeTarget();
    let down = 2;
    const connect = async () => { if (down-- > 0) throw new Error("ssh nautica: connect ECONNREFUSED"); return "/home/lyrica"; };
    expect(jobs.start(thread, "nautica", target, "nvidia-smi", connect)).toMatchObject({ id: "j1", state: "running" });
    await tick();
    expect(jobs.list(thread)[0]).toMatchObject({ waiting: true });
    expect(jobNotice(jobs.list(thread)[0]!, "")).toMatch(/j1 in nautica, waiting for nautica to answer for \d+ s: nvidia-smi/);
    await new Promise((r) => setTimeout(r, 30));
    expect(jobs.list(thread)[0]).toMatchObject({ cwd: "/home/lyrica" });
    expect(jobs.list(thread)[0]!.waiting).toBeUndefined();
    running.get("nvidia-smi")!.done(0);
    await tick();
    expect(ended.map((j) => j.state)).toEqual(["exited"]);
    // Another machine's key changed: not a reboot, so it ends with that reason and never runs.
    jobs.start(thread, "lunasa", target, "uptime", async () => { throw new Error("ssh lunasa: its host key changed (now SHA256:x); confirm the new key to use it again"); });
    await tick(); await tick();
    expect(ended[1]).toMatchObject({ state: "failed", reason: expect.stringMatching(/host key changed/) });
    expect(running.has("uptime")).toBe(false);
  });

  it("takes a machine as answering only after a round trip, dropping a connection that failed but not a busy one", async () => {
    // A set folder needs no connection to name. The kept session first doesn't answer (busy, or the machine is still
    // down), then is refused (the machine is back and doesn't know it), then a fresh one answers.
    let state: "silent" | "refused" | "fresh" = "silent";
    const reconnects: number[] = [];
    const target = {
      name: "ssh:nautica", cwd: async () => "/srv/work", folders: () => [],
      reconnect: () => { reconnects.push(1); state = "fresh"; },
      ops: () => ({ bash: { exec: (_c: string, _d: string, o: { signal?: AbortSignal }) => state === "silent"
        ? new Promise((_r, reject) => o.signal?.addEventListener("abort", () => reject(new Error("timed out"))))
        : state === "refused" ? Promise.reject(new Error("ssh nautica: read ECONNRESET")) : Promise.resolve({ exitCode: 0 }) } }),
    } as unknown as ExecutionTarget;
    const ready = machineReady(target, 10);
    await expect(ready()).rejects.toThrow(/timed out/);
    expect(reconnects).toHaveLength(0);
    state = "refused";
    await expect(ready()).rejects.toThrow(/ECONNRESET/);
    expect(reconnects).toHaveLength(1);
    await expect(ready()).resolves.toBe("/srv/work");
    // In a job: it waits through both, then runs.
    state = "silent";
    const ended: JobInfo[] = [];
    const jobs = new Jobs((_t, job) => ended.push(job), 5);
    const { target: runner, running } = fakeTarget();
    jobs.start(thread, "nautica", runner, "nvidia-smi", machineReady(target, 10));
    await new Promise((r) => setTimeout(r, 30));
    state = "refused";
    await new Promise((r) => setTimeout(r, 60));
    expect(jobs.list(thread)[0]).toMatchObject({ cwd: "/srv/work", state: "running" });
    running.get("nvidia-smi")!.done(0);
    await tick();
    expect(ended.map((j) => j.state)).toEqual(["exited"]);
  });

  it("refuses more running jobs than the limit, and stops one on request", async () => {
    const ended: JobInfo[] = [];
    const jobs = new Jobs((_t, job) => ended.push(job));
    const { target } = fakeTarget();
    for (let i = 0; i < JOB_LIMITS.running; i++) jobs.start(thread, "sandbox", target, `sleep ${i}`, "/workspace");
    expect(() => jobs.start(thread, "sandbox", target, "one more", "/workspace")).toThrow(/already has 4 background commands running/);
    // Another thread has its own count.
    expect(jobs.start({ ...thread, threadId: "t2" }, "sandbox", target, "elsewhere", "/workspace").id).toBe("j1");
    expect(jobs.stop(thread, "j2")).toBe(true);
    await tick();
    expect(ended.map((j) => [j.id, j.state])).toEqual([["j2", "stopped"]]);
    expect(jobs.stop(thread, "j2")).toBe(false);
    expect(jobs.output(thread, "j9")).toBeUndefined();
  });

  it("stops a user's jobs at Lock, or only the forgotten threads'", async () => {
    const ended: string[] = [];
    const jobs = new Jobs((t, job) => ended.push(`${t.threadId}:${job.state}:${job.reason}`));
    const { target } = fakeTarget();
    jobs.start(thread, "sandbox", target, "a", "/workspace");
    jobs.start({ ...thread, threadId: "t2" }, "sandbox", target, "b", "/workspace");
    jobs.start({ ...thread, userId: "u2" }, "sandbox", target, "c", "/workspace");
    jobs.stopUser("u1", "the thread was forgotten", { pool: "general", ids: ["t2"] });
    expect(ended).toEqual(["t2:stopped:the thread was forgotten"]);
    jobs.stopUser("u1", "Lyrica locked");
    expect(ended).toEqual(["t2:stopped:the thread was forgotten", "t1:stopped:Lyrica locked"]);
    expect(jobs.list(thread)).toEqual([]);
    expect(jobs.running()).toEqual([{ userId: "u2", pool: "general", threadId: "t1", id: "j1" }]);
  });

  it("times a job out", async () => {
    const ended: JobInfo[] = [];
    const jobs = new Jobs((_t, job) => ended.push(job));
    const { target } = fakeTarget();
    jobs.start(thread, "sandbox", target, "forever", "/workspace", 0.01);
    await new Promise((r) => setTimeout(r, 40));
    expect(ended[0]).toMatchObject({ state: "timed out" });
    expect(ended[0]!.exitCode).toBeUndefined();
  });
});

describe("sleepWait", () => {
  it("refuses a fixed sleep of a minute or more in her turn, and names the ways to wait", () => {
    const why = sleepWait('sleep 200; cat /workspace/scratch/ab4.log 2>/dev/null; echo "---"', false);
    expect(why).toMatch(/^Not run: this sleeps 3 min/);
    expect(why).toContain("background: true");
    expect(why).toContain("threads watch");
    expect(sleepWait("sleep 30 && sleep 30; gh run list", false)).toMatch(/sleeps 60 s/);
    expect(sleepWait("sleep 2m", false)).toBeDefined();
  });
  it("refuses a polling loop in her turn, but not in the background", () => {
    const loop = "until gh run view 12 --json status | grep -q completed; do sleep 30; done";
    expect(sleepWait(loop, false)).toMatch(/polls in a loop that sleeps 30 s/);
    expect(sleepWait(loop, true)).toBeUndefined();
    expect(sleepWait(`timeout 900 bash -c '${loop}'`, false)).toMatch(/polls in a loop/);
  });
  it("refuses a background command that is only a timer", () => {
    expect(sleepWait("sleep 300; cat run.log", true)).toMatch(/^Not run: this background command is a timer: it sleeps 5 min/);
  });
  it("lets short waits and unknown lengths run", () => {
    expect(sleepWait("sleep 5; curl -s localhost:8080", false)).toBeUndefined();
    expect(sleepWait("for i in $(seq 30); do curl -sf localhost:8080 && break; sleep 1; done", false)).toBeUndefined();
    expect(sleepWait("sleep $DELAY", false)).toBeUndefined();
    expect(sleepWait("npm test", false)).toBeUndefined();
    expect(sleepWait("echo 'sleep 300'", false)).toBeUndefined();
  });
});
