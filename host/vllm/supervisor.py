#!/usr/bin/env python3
"""Runs one vLLM server per model, as host-api asks in /serving/vllm.json.

The vLLM image has only Python, so this small part of the host is Python.
host-api writes the file; this script starts, stops and restarts servers to
match it. It has no listener of its own and never sees the Docker socket.
"""
import json
import os
import signal
import subprocess
import sys
import time

STATE = os.environ.get("VLLM_STATE", "/serving/vllm.json")
# What failed to start, for host-api: it stops waiting on a load that crashed.
STATUS = os.environ.get("VLLM_STATUS", "/status/vllm.json")
COMMAND = os.environ.get("VLLM_COMMAND", "vllm").split()


def rope_override(spec):
    """--hf-overrides for YaRN: the model's own RoPE settings with the YaRN
    fields merged in, under the key its config uses (rope_parameters, or the
    older rope_scaling), and in text_config when that holds them. Nothing
    else changes, so rope_theta and mrope_section stay the publisher's."""
    o = spec.get("ropeOverride")
    if not o:
        return None
    try:
        with open(os.path.join(spec["model"], "config.json")) as f:
            config = json.load(f)
    except (OSError, ValueError):
        config = {}
    nested = isinstance(config.get("text_config"), dict) and any(
        k in config["text_config"] for k in ("rope_parameters", "rope_scaling", "rope_theta"))
    text = config["text_config"] if nested else config
    key = "rope_scaling" if "rope_scaling" in text and "rope_parameters" not in text else "rope_parameters"
    rope = dict(text.get(key) or {})
    rope.update({
        "rope_type": "yarn",
        "factor": float(o["factor"]),
        "original_max_position_embeddings": int(o["originalContext"]),
    })
    return {"text_config": {key: rope}} if nested else {key: rope}


def argv(spec):
    args = COMMAND + [
        "serve", spec["model"],
        "--served-model-name", spec["name"],
        "--host", "0.0.0.0",
        "--port", str(spec["port"]),
        "--gpu-memory-utilization", str(spec.get("memoryShare") or 0.9),
        "--tensor-parallel-size", str(spec.get("tensorParallel") or 1),
        "--pipeline-parallel-size", str(spec.get("pipelineParallel") or 1),
        "--disable-uvicorn-access-log",
        "--load-format", "safetensors",
    ]
    if spec.get("embedding"):
        args += ["--runner", "pooling"]
    if not spec.get("embedding") and spec.get("toolCallParser"):
        args += ["--enable-auto-tool-choice", "--tool-call-parser", spec["toolCallParser"]]
    if not spec.get("embedding") and spec.get("reasoningParser"):
        args += ["--reasoning-parser", spec["reasoningParser"]]
    if spec.get("maxModelLen"):
        args += ["--max-model-len", str(int(spec["maxModelLen"]))]
    if spec.get("maxNumSeqs"):
        args += ["--max-num-seqs", str(int(spec["maxNumSeqs"]))]
    if spec.get("maxNumBatchedTokens"):
        args += ["--max-num-batched-tokens", str(int(spec["maxNumBatchedTokens"]))]
    if spec.get("dtype"):
        args += ["--dtype", spec["dtype"]]
    if spec.get("chatTemplate"):
        args += ["--chat-template", spec["chatTemplate"]]
    override = rope_override(spec)
    if override:
        args += ["--hf-overrides", json.dumps(override, separators=(",", ":"))]
    return args


def start(spec):
    env = dict(os.environ)
    gpus = ",".join(str(g) for g in spec["gpus"])
    for var in ("CUDA_VISIBLE_DEVICES", "HIP_VISIBLE_DEVICES", "ROCR_VISIBLE_DEVICES"):
        env[var] = gpus
    # A stretched model is served past its config's max_position_embeddings.
    if spec.get("ropeOverride"):
        env["VLLM_ALLOW_LONG_MAX_MODEL_LEN"] = "1"
    # Its own process group, so stopping it also stops vLLM's engine processes.
    return subprocess.Popen(argv(spec), env=env, start_new_session=True)


def stop(proc):
    if proc.poll() is None:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(30)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()
        except ProcessLookupError:
            pass
    # Whatever the group left behind.
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def report(failed):
    """Writes {name: {"attempt", "exitCode", "crashes"}} for servers that exited."""
    try:
        tmp = STATUS + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"failed": failed}, f)
        os.replace(tmp, STATUS)
    except OSError:
        pass


def wanted():
    try:
        with open(STATE) as f:
            state = json.load(f)
        return state.get("generation", 0), state.get("servers", {})
    except (OSError, ValueError):
        return None


def main():
    running = {}  # model name -> (spec, process, started)
    failures = {}  # model name -> crashes in a row, for the backoff
    failed = {}  # model name -> what host-api is told about its last exit
    generation = None
    report(failed)
    stopping = []
    signal.signal(signal.SIGTERM, lambda *_: stopping.append(True))
    while not stopping:
        want = wanted()
        if want is not None:
            gen, servers = want
            for name in list(running):
                spec, proc, _ = running[name]
                if gen != generation or servers.get(name) != spec:
                    stop(proc)
                    del running[name]
            generation = gen
            before = dict(failed)
            for name in list(failed):
                if name not in running and name not in servers:
                    del failed[name]
            for name, spec in servers.items():
                current = running.get(name)
                if current is None:
                    failures.pop(name, None)
                    failed.pop(name, None)
                    running[name] = (spec, start(spec), time.time())
                elif current[1].poll() is not None:
                    failed[name] = {"attempt": spec.get("attempt"), "exitCode": current[1].returncode, "crashes": failures.get(name, 0) + 1}
                    # Restart a crashed server, waiting longer each time: 10 s, 20 s, ... up to 5 minutes.
                    wait = min(10 * 2 ** failures.get(name, 0), 300)
                    if time.time() - current[2] > wait:
                        failures[name] = failures.get(name, 0) + 1
                        running[name] = (spec, start(spec), time.time())
            if failed != before:
                report(failed)
        time.sleep(1)
    for _, proc, _ in running.values():
        stop(proc)
    sys.exit(0)


if __name__ == "__main__":
    main()
