import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const python = spawnSync("python3", ["--version"]).status === 0;
const SUPERVISOR = new URL("../vllm/supervisor.py", import.meta.url).pathname;

async function until(check: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!python)("the vLLM supervisor", () => {
  it("starts a server per GPU from the state file, and restarts it when the model changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lyrica-vllm-"));
    const fake = join(dir, "fake-vllm");
    // Records its arguments and GPU, then waits to be stopped.
    writeFileSync(fake, `#!/bin/sh\necho "$CUDA_VISIBLE_DEVICES $VLLM_SERVER_DEV_MODE $*" >> ${dir}/runs\nexec sleep 1000\n`);
    chmodSync(fake, 0o755);
    const state = join(dir, "vllm.json");
    const write = (gpus: object, generation = 0) => writeFileSync(state, JSON.stringify({ generation, gpus }));
    write({ 1: { model: "/models/a", name: "a", port: 8001, embedding: false, maxModelLen: 131072 } });
    const proc = spawn("python3", [SUPERVISOR], { env: { ...process.env, VLLM_STATE: state, VLLM_COMMAND: fake }, stdio: "ignore" });
    try {
      const runs = () => (existsSync(join(dir, "runs")) ? readFileSync(join(dir, "runs"), "utf8").trim().split("\n") : []);
      await until(() => runs().length === 1);
      expect(runs()[0]).toBe("1 1 serve /models/a --served-model-name a --host 0.0.0.0 --port 8001 --enable-sleep-mode --gpu-memory-utilization 0.9 --disable-uvicorn-access-log --max-model-len 32768");
      write({ 1: { model: "/models/b", name: "b", port: 8001, embedding: true, maxModelLen: null } });
      await until(() => runs().length === 2);
      expect(runs()[1]).toBe("1 1 serve /models/b --served-model-name b --host 0.0.0.0 --port 8001 --enable-sleep-mode --gpu-memory-utilization 0.9 --disable-uvicorn-access-log --runner pooling");
      expect(runs().join("\n")).not.toMatch(/trust-remote-code/);
    } finally {
      proc.kill("SIGTERM");
      await new Promise((r) => proc.once("exit", r));
    }
  });
});
