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
  it("starts a server per model on its GPUs, side by side, from the state file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lyrica-vllm-"));
    const fake = join(dir, "fake-vllm");
    // Records its arguments and GPU, then waits to be stopped.
    writeFileSync(fake, `#!/bin/sh\necho "$CUDA_VISIBLE_DEVICES $*" >> ${dir}/runs\nexec sleep 1000\n`);
    chmodSync(fake, 0o755);
    const state = join(dir, "vllm.json");
    const write = (servers: object, generation = 0) => writeFileSync(state, JSON.stringify({ generation, servers }));
    const a = { model: "/models/a", name: "a", port: 8000, gpus: [0, 1], embedding: false, tensorParallel: 2, pipelineParallel: 1, memoryShare: 0.4, maxModelLen: 32768, maxNumSeqs: 16, maxNumBatchedTokens: null, dtype: "bfloat16", chatTemplate: null };
    write({ a });
    const proc = spawn("python3", [SUPERVISOR], { env: { ...process.env, VLLM_STATE: state, VLLM_COMMAND: fake }, stdio: "ignore" });
    try {
      const runs = () => (existsSync(join(dir, "runs")) ? readFileSync(join(dir, "runs"), "utf8").trim().split("\n") : []);
      await until(() => runs().length === 1);
      expect(runs()[0]).toBe("0,1 serve /models/a --served-model-name a --host 0.0.0.0 --port 8000 --gpu-memory-utilization 0.4 --tensor-parallel-size 2 --pipeline-parallel-size 1 --disable-uvicorn-access-log --load-format safetensors --max-model-len 32768 --max-num-seqs 16 --dtype bfloat16");
      // A second model beside it on GPU 1: its own server; the first keeps running.
      write({ a, b: { model: "/models/b", name: "b", port: 8001, gpus: [1], embedding: true, tensorParallel: 1, pipelineParallel: 1, memoryShare: 0.3, maxModelLen: null } });
      await until(() => runs().length === 2);
      expect(runs()[1]).toBe("1 serve /models/b --served-model-name b --host 0.0.0.0 --port 8001 --gpu-memory-utilization 0.3 --tensor-parallel-size 1 --pipeline-parallel-size 1 --disable-uvicorn-access-log --load-format safetensors --runner pooling");
      await new Promise((r) => setTimeout(r, 1500));
      expect(runs()).toHaveLength(2);
      expect(runs().join("\n")).not.toMatch(/trust-remote-code/);
    } finally {
      proc.kill("SIGTERM");
      await new Promise((r) => proc.once("exit", r));
    }
  });
});
