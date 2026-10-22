#!/usr/bin/env python3
"""Runs ComfyUI only while host-api asks for it in /serving/comfyui.json.

Freeing ComfyUI's models leaves its CUDA context (a few hundred MiB) on the
GPU for as long as the process lives. So host-api stops the process when no
recipe is loaded and on Pause, and starts it for the next image job. Like
the vLLM supervisor, this has no listener and never sees the Docker socket.
host-api asks with an attempt id; /status/comfyui.json names the attempt
once a ComfyUI started since any stop is running, so host-api never takes a
stopping one for the new one.

At start it checks that this PyTorch has kernels for the GPU. If it has
none, ComfyUI is never started and the status says why, so host-api fails
image jobs and shows the problem rather than a card that looks healthy.

`gate.py --health` is the container's health check: healthy while ComfyUI is
off as asked, or on and answering; unhealthy on a GPU it can't run.
"""
import json
import os
import signal
import subprocess
import sys
import time
import urllib.request

STATE = os.environ.get("COMFY_STATE", "/serving/comfyui.json")
STATUS = os.environ.get("COMFY_STATUS", "/status/comfyui.json")
PORT = 8188


def wanted():
    """The attempt host-api asks to run, or None to stop."""
    try:
        with open(STATE) as f:
            state = json.load(f)
        return str(state.get("attempt") or "") if state.get("run") is True else None
    except (OSError, ValueError, AttributeError):
        return None


# Prints why this PyTorch can't run on the GPU, or nothing. A kernel built
# for sm_XY runs on X.Y up to X.9; PTX for compute_XY compiles on X.Y and up.
CHECK = """
import re, torch
if torch.version.cuda and torch.cuda.is_available():
    cap = torch.cuda.get_device_capability(0)
    # Names like sm_90a carry a letter after the number.
    archs = [(m[1], divmod(int(m[2]), 10)) for m in (re.match(r"(sm|compute)_(\d+)", a) for a in torch.cuda.get_arch_list()) if m]
    if not any((k == "sm" and a[0] == cap[0] and a[1] <= cap[1]) or (k == "compute" and a <= cap) for k, a in archs):
        print(f"{torch.cuda.get_device_name(0)} is sm_{cap[0]}{cap[1]}, and this ComfyUI's PyTorch {torch.__version__} has kernels only for {', '.join(torch.cuda.get_arch_list())}, so it can't make images on it.")
"""


def unsupported():
    """Why ComfyUI can't run on this GPU, or None (also when the check itself fails)."""
    try:
        out = subprocess.run([sys.executable, "-c", CHECK], capture_output=True, text=True, timeout=120)
        return out.stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


def report(attempt, problem=None):
    try:
        with open(STATUS + ".tmp", "w") as f:
            json.dump({"attempt": attempt, "unsupported": problem} if problem else {"attempt": attempt}, f)
        os.replace(STATUS + ".tmp", STATUS)
    except OSError:
        pass


def stop(child):
    if child.poll() is not None:
        return
    child.terminate()
    try:
        child.wait(20)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()


def main(command):
    child = None
    started = 0.0
    reported = None
    problem = unsupported()
    report(None, problem)
    done = []
    signal.signal(signal.SIGTERM, lambda *_: done.append(True))
    signal.signal(signal.SIGINT, lambda *_: done.append(True))
    while problem and not done:
        time.sleep(0.5)
    while not done:
        attempt = wanted()
        if attempt is not None:
            # One that exited is started again, at most every five seconds.
            if (child is None or child.poll() is not None) and time.monotonic() - started > 5:
                child = subprocess.Popen(command)
                started = time.monotonic()
            if child is not None and child.poll() is None and reported != attempt:
                report(attempt)
                reported = attempt
        elif child is not None or reported is not None:
            if child is not None:
                stop(child)
            child = None
            report(None)
            reported = None
        time.sleep(0.5)
    if child is not None:
        stop(child)


def health():
    try:
        with open(STATUS) as f:
            if json.load(f).get("unsupported"):
                return 1
    except (OSError, ValueError, AttributeError):
        pass
    if wanted() is None:
        return 0
    urllib.request.urlopen(f"http://127.0.0.1:{PORT}/system_stats", timeout=5)
    return 0


if __name__ == "__main__":
    if sys.argv[1:] == ["--health"]:
        sys.exit(health())
    main(sys.argv[1:])
