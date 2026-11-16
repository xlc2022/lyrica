// A background command's notice, read back into its parts for its card (web/src/JobNotice.tsx): the text is core's jobNotice.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { jobNotice, type JobInfo } from "../../core/src/workspace/jobs.ts";
import { JobNotice, parseJobNotice } from "../src/JobNotice.tsx";

const job = (over: Partial<JobInfo>): JobInfo => ({
  id: "j5", place: "box", command: "uptime; cd /srv && make", cwd: "/", startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:00:23Z", state: "exited", exitCode: 0, ...over,
});

describe("parseJobNotice", () => {
  it("reads back the job, how it ended, the command and its output with their lines", () => {
    const command = "for i in 1 2; do\n  echo \"$i: done\"\ndone";
    const parsed = parseJobNotice(jobNotice(job({ command }), "one\n\ntwo\n"));
    expect(parsed).toEqual({ id: "j5", place: "box", state: "exited", exitCode: 0, took: "23 s", command, output: "one\n\ntwo" });
  });

  it("reads a failure's reason, the sandbox, and a command with no output", () => {
    const parsed = parseJobNotice(jobNotice(job({ place: "sandbox", state: "timed out", exitCode: null, reason: "over its 3600 s limit", endedAt: "2026-01-01T02:05:00Z" }), ""));
    expect(parsed).toEqual({ id: "j5", place: "sandbox", state: "timed out", took: "2 h 5 min", reason: "over its 3600 s limit", command: "uptime; cd /srv && make", output: "" });
  });

  it("reads the name she gave it, which heads the card", () => {
    const parsed = parseJobNotice(jobNotice(job({ name: "Pull the host images", command: "docker compose pull" }), "pulled"));
    expect(parsed).toMatchObject({ id: "j5", name: "Pull the host images", place: "box", command: "docker compose pull", output: "pulled" });
    expect(renderToStaticMarkup(createElement(JobNotice, { job: parsed! }))).toContain('<b class="as-is">Pull the host images</b>');
  });

  it("leaves an MCP server's end to the plain notice", () => {
    expect(parseJobNotice(jobNotice(job({ kind: "mcp", command: "fs" }), ""))).toBeUndefined();
  });

  it("shows the command and output in blocks of their own", () => {
    const html = renderToStaticMarkup(createElement(JobNotice, { job: parseJobNotice(jobNotice(job({ exitCode: 1 }), "a\nb"))! }));
    expect(html).toContain('<pre class="job-command" aria-label="Command">uptime; cd /srv &amp;&amp; make</pre>');
    expect(html).toContain('<pre class="job-output" aria-label="Last output">a\nb</pre>');
    expect(html).toContain('<span class="dot down" aria-hidden="true"></span>exit <span class="mono">1</span>');
  });
});
