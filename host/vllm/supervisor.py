#!/usr/bin/env python3
"""Runs one vLLM server per GPU, as host-api asks in /serving/vllm.json.

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
COMMAND = os.environ.get("VLLM_COMMAND", "vllm").split()
MAX_LEN = 32768


def argv(spec):
    args = COMMAND + [
        "serve", spec["model"],
        "--served-model-name", spec["name"],
        "--host", "0.0.0.0",
        "--port", str(spec["port"]),
        "--enable-sleep-mode",
        "--gpu-memory-utilization", "0.9",
        "--disable-uvicorn-access-log",
        "--load-format", "safetensors",
    ]
    if spec.get("embedding"):
        args += ["--runner", "pooling"]
    if spec.get("maxModelLen"):
        args += ["--max-model-len", str(min(int(spec["maxModelLen"]), MAX_LEN))]
    return args


def start(gpu, spec):
    env = dict(os.environ, VLLM_SERVER_DEV_MODE="1")
    for var in ("CUDA_VISIBLE_DEVICES", "HIP_VISIBLE_DEVICES", "ROCR_VISIBLE_DEVICES"):
        env[var] = str(gpu)
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


def wanted():
    try:
        with open(STATE) as f:
            state = json.load(f)
        return state.get("generation", 0), {int(k): v for k, v in state.get("gpus", {}).items()}
    except (OSError, ValueError):
        return None


def main():
    running = {}  # gpu -> (spec, process, started)
    failures = {}  # gpu -> crashes in a row, for the backoff
    generation = None
    stopping = []
    signal.signal(signal.SIGTERM, lambda *_: stopping.append(True))
    while not stopping:
        want = wanted()
        if want is not None:
            gen, gpus = want
            for gpu in list(running):
                spec, proc, _ = running[gpu]
                if gen != generation or gpus.get(gpu) != spec:
                    stop(proc)
                    del running[gpu]
            generation = gen
            for gpu, spec in gpus.items():
                current = running.get(gpu)
                if current is None:
                    failures.pop(gpu, None)
                    running[gpu] = (spec, start(gpu, spec), time.time())
                elif current[1].poll() is not None:
                    # Restart a crashed server, waiting longer each time: 10 s, 20 s, ... up to 5 minutes.
                    wait = min(10 * 2 ** failures.get(gpu, 0), 300)
                    if time.time() - current[2] > wait:
                        failures[gpu] = failures.get(gpu, 0) + 1
                        running[gpu] = (spec, start(gpu, spec), time.time())
        time.sleep(1)
    for _, proc, _ in running.values():
        stop(proc)
    sys.exit(0)


if __name__ == "__main__":
    main()
