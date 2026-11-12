import { describe, expect, it } from "vitest";
import { JOB_LIMITS, jobNotice, Jobs, sleepWait, type ExecutionTarget, type JobInfo } from "../src/index.ts";

const thread = { userId: "u1", pool: "general", threadId: "t1" };

/** A target whose commands run until their signal aborts or `finish` is called. */
function fakeTarget() {
  const running = new Map<string, { onData: (d: Buffer) => void; done: (code: number) => void }>();
  const target: ExecutionTarget = {
    name: "sandbox",
    cwd: async () => "/workspace",
    folders: () => [],
    ops: () => ({
      bash: {
        exec: (command: string, _cwd: string, o: { onData: (d: Buffer) => void; signal?: AbortSignal }) => new Promise<{ exitCode: number }>((resolve, reject) => {
          running.set(command, { onData: o.onData, done: (code) => resolve({ exitCode: code }) });
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
    expect(jobs.output(thread, "j1").output).toContain("building");
    running.get("make")!.done(0);
    await tick();
    expect(ended).toHaveLength(1);
    expect(ended[0]!.job).toMatchObject({ state: "exited", exitCode: 0 });
    expect(jobNotice(ended[0]!.job, ended[0]!.output)).toMatch(/^Background command j1 in the sandbox, exited with code 0 after \d+ s: make\nLast output:\nbuilding\ndone$/);
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
    expect(() => jobs.output(thread, "j9")).toThrow(/no background command j9/);
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
