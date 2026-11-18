#!/usr/bin/env python3
"""Runs one vLLM server per model, as host-api asks in /serving/vllm.json;
with ENGINE=sglang, SGLang servers from /serving/sglang.json instead.

The vLLM and SGLang images have only Python, so this small part of the host
is Python. host-api writes the file; this script starts, stops and restarts
servers to match it. It has no listener of its own and never sees the Docker
socket.
"""
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time

ENGINE = os.environ.get("ENGINE", "vllm")
STATE = os.environ.get("VLLM_STATE", f"/serving/{ENGINE}.json")
# What failed to start, for host-api: it stops waiting on a load that crashed.
STATUS = os.environ.get("VLLM_STATUS", f"/status/{ENGINE}.json")
COMMAND = os.environ.get("VLLM_COMMAND", ENGINE).split()
# The server's line once it answers: after it, nothing a server prints is kept.
# SGLang prints uvicorn's line before its warm-up, and this one after.
READY = "The server is fired up and ready to roll" if ENGINE == "sglang" else "Application startup complete"
# An exception's last line, such as "ImportError: soundfile is not installed".
EXCEPTION = re.compile(r"\b([A-Za-z_][\w.]*(?:Error|Exception)): (\S.*)")


def watch(proc):
    """Reads a server's output. Until it answers, the last exception line it
    printed is kept in memory, so a start that fails can say why; no request
    has reached it then. vLLM ends a failed start with one that points back at
    the cause, after a long traceback: skipped. Once it answers, its output is
    read and dropped, never kept."""
    for raw in proc.stdout:
        if proc.lyrica_ready:
            continue
        line = raw.decode("utf-8", "replace").rstrip()
        if READY in line:
            proc.lyrica_ready = True
            proc.lyrica_cause = None
            continue
        m = EXCEPTION.search(line)
        if m and "root cause above" not in line:
            proc.lyrica_cause = f"{m.group(1)}: {m.group(2)}"[:300]


def why(proc):
    """The last exception a server printed before it answered, or None."""
    return None if proc.lyrica_ready else proc.lyrica_cause


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


# SGLang: the TP2 profile of ormandj/sglang-glm53-flash-sm120's examples/serve-glm53-flash.sh at v0.6.1,
# the only one its image (built for GLM 5.3 Flash on sm_120) was measured with. Its environment, then its flags.
SGLANG_ENV = {
    "SGLANG_ENABLE_HEALTH_ENDPOINT_GENERATION": "0",
    "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True",
    "SGLANG_DRAFT_LM_HEAD_FP8": "1",
    "SGLANG_PREFILL_MBO": "0",
    "TORCHINDUCTOR_CACHE_DIR": "/root/.cache/torchinductor",
    "TILELANG_CACHE_DIR": "/root/.cache/tilelang",
    "TRITON_CACHE_DIR": "/root/.cache/triton",
    "SGLANG_KDA_EXTEND_BLOCK_TOKENS": "2048",
    "SGLANG_BCG_RAGGED_SHAPES": "1",
    "SGLANG_BCG_RAGGED_MAX_BS": "1",
    "SGLANG_BCG_SEPARATE_CAPTURE_SESSIONS": "1",
    # No direct transfers between the cards: on a desktop board with the IOMMU on, NCCL's setup hung at
    # "Init parallel begin" with P2P on (mystria, 2026-11-18), and the image's PCIe all-reduce uses P2P too.
    # The cards talk through host memory instead.
    "NCCL_P2P_DISABLE": "1",
    "SGLANG_ENABLE_PCIE_IPC_ALLREDUCE": "0",
}


def sglang_argv(spec):
    # Requests at once; GLM's recurrent state takes up to five slots each (28 for the profile's four).
    seqs = int(spec.get("maxNumSeqs") or 4)
    context = int(spec.get("maxModelLen") or 32768)
    return COMMAND + [
        "serve",
        "--model-path", spec["model"],
        "--served-model-name", spec["name"],
        "--tp", str(len(spec["gpus"])),
        "--enable-multimodal",
        "--warmups", "serving_coverage",
        "--image-processor-backend", "torchvision",
        "--mm-preprocessing-device", "cpu",
        "--quantization", "modelopt_mixed",
        "--moe-runner-backend", "flashinfer_cutlass",
        "--disable-shared-experts-fusion",
        "--disable-custom-all-reduce",
        "--attention-backend", "dsa",
        "--linear-attn-backend", "triton",
        "--context-length", str(context),
        "--max-total-tokens", str(context),
        "--kv-cache-dtype", "fp8_e4m3",
        "--mem-fraction-static", str(spec.get("memoryShare") or 0.99),
        "--chunked-prefill-size", "4096", "--max-prefill-tokens", "4096",
        "--max-running-requests", str(seqs),
        "--max-mamba-cache-size", str(7 * seqs),
        "--mamba-ssm-dtype", "bfloat16",
        "--cuda-graph-backend-prefill", "breakable",
        "--cuda-graph-bs-prefill", "64", "128",
        "--cuda-graph-backend-decode", "full",
        "--cuda-graph-bs-decode", *[str(n) for n in range(1, seqs + 1)],
        "--dsa-prefill-backend", "flashinfer_sparse_mla",
        "--dsa-decode-backend", "flashinfer_sparse_mla",
        "--speculative-algorithm", "EAGLE",
        "--speculative-num-steps", "3",
        "--speculative-eagle-topk", "1",
        "--speculative-num-draft-tokens", "4",
        "--reasoning-parser", "glm45",
        "--tool-call-parser", "glm47",
        *(["--chat-template", spec["chatTemplate"]] if spec.get("chatTemplate") else []),
        "--host", "0.0.0.0",
        "--port", str(spec["port"]),
    ]


def start(spec):
    env = dict(os.environ)
    if ENGINE == "sglang":
        env.update(SGLANG_ENV)
    # Its lines as it prints them, not when a buffer fills or it exits.
    env["PYTHONUNBUFFERED"] = "1"
    gpus = ",".join(str(g) for g in spec["gpus"])
    for var in ("CUDA_VISIBLE_DEVICES", "HIP_VISIBLE_DEVICES", "ROCR_VISIBLE_DEVICES"):
        env[var] = gpus
    # A stretched model is served past its config's max_position_embeddings.
    if spec.get("ropeOverride"):
        env["VLLM_ALLOW_LONG_MAX_MODEL_LEN"] = "1"
    # Its own process group, so stopping it also stops vLLM's engine processes.
    command = sglang_argv(spec) if ENGINE == "sglang" else argv(spec)
    proc = subprocess.Popen(command, env=env, start_new_session=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    proc.lyrica_ready = False
    proc.lyrica_cause = None
    proc.lyrica_reader = threading.Thread(target=watch, args=(proc,), daemon=True)
    proc.lyrica_reader.start()
    return proc


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
    """Writes {name: {"attempt", "exitCode", "crashes", "error"?}} for servers that exited."""
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
                    # Its last lines may still be on their way to the output thread.
                    current[1].lyrica_reader.join(0.5)
                    error = why(current[1])
                    if error:
                        failed[name]["error"] = error
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
