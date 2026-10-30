#!/usr/bin/env python3
"""Runs a ComfyUI per image GPU, each only while host-api asks for it.

The image GPUs are the ones this container is given (CUDA_VISIBLE_DEVICES
or HIP_VISIBLE_DEVICES, from COMFY_GPU): GPU g's ComfyUI is asked for in
/serving/comfyui-<g>.json, says it runs in /status/comfyui-<g>.json,
listens on 8188 plus its place in the list, sees only its own GPU, and has
its own folders under /tmp/comfy/<g>.

Freeing ComfyUI's models leaves its CUDA context (a few hundred MiB) on the
GPU for as long as the process lives. So host-api stops the process when no
recipe is loaded there and on Pause, and starts it for the next image job.
Like the vLLM supervisor, this has no listener and never sees the Docker
socket. host-api asks with an attempt id; the status names the attempt
once a ComfyUI started since any stop is running, so host-api never takes a
stopping one for the new one.

At start it checks that this PyTorch has kernels for each GPU. For one it
has none for, that ComfyUI is never started and its status says why, so
host-api fails image jobs there and shows the problem rather than a card
that looks healthy.

Each start and stop empties that ComfyUI's input, output and temp folders
(a tmpfs). host-api blanks a job's uploads after it, but that needs
ComfyUI: a ComfyUI that crashed mid-job would leave the photo it was given
there.

`gate.py --health` is the container's health check: healthy while each
ComfyUI is off as asked, or on and answering; unhealthy on a GPU it can't
run.
"""
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.request

SERVING = os.environ.get("COMFY_SERVING", "/serving")
STATUS = os.environ.get("COMFY_STATUS", "/status")
FOLDERS = os.environ.get("COMFY_FOLDERS", "/tmp/comfy")
PORT = 8188
# Which variable hands this container its GPUs: CUDA's, else ROCm's.
DEVICES = next((v for v in ("CUDA_VISIBLE_DEVICES", "HIP_VISIBLE_DEVICES") if os.environ.get(v)), None)


class Instance:
    """One ComfyUI: its GPU, port and files."""

    def __init__(self, gpu, place):
        self.gpu = gpu
        self.port = PORT + place
        self.state = os.path.join(SERVING, f"comfyui-{gpu}.json")
        self.status = os.path.join(STATUS, f"comfyui-{gpu}.json")
        self.folders = [os.path.join(FOLDERS, gpu, f) for f in ("input", "output", "temp", "user")]
        self.env = {**os.environ, DEVICES: gpu} if DEVICES else dict(os.environ)
        self.child = None
        self.started = 0.0
        self.reported = None
        self.problem = None

    def wanted(self):
        """The attempt host-api asks to run, or None to stop."""
        try:
            with open(self.state) as f:
                state = json.load(f)
            return str(state.get("attempt") or "") if state.get("run") is True else None
        except (OSError, ValueError, AttributeError):
            return None

    def report(self, attempt):
        try:
            with open(self.status + ".tmp", "w") as f:
                json.dump({"attempt": attempt, "unsupported": self.problem} if self.problem else {"attempt": attempt}, f)
            os.replace(self.status + ".tmp", self.status)
        except OSError:
            pass

    def empty(self):
        """Deletes what is in its input, output and temp folders, keeping the folders."""
        for folder in self.folders[:3]:
            try:
                names = os.listdir(folder)
            except OSError:
                continue
            for name in names:
                path = os.path.join(folder, name)
                try:
                    if os.path.isdir(path) and not os.path.islink(path):
                        shutil.rmtree(path)
                    else:
                        os.unlink(path)
                except OSError:
                    pass

    def start(self, command):
        for folder in self.folders:
            os.makedirs(folder, exist_ok=True)
        self.empty()
        # Its own port and folders, after the shared flags (the last of a flag counts).
        self.child = subprocess.Popen(command + [
            "--port", str(self.port), "--input-directory", self.folders[0], "--output-directory", self.folders[1],
            "--temp-directory", self.folders[2], "--user-directory", self.folders[3],
        ], env=self.env)
        self.started = time.monotonic()

    def stop(self):
        child, self.child = self.child, None
        if child is None:
            return
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(20)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        self.empty()

    def tick(self, command):
        attempt = self.wanted()
        if attempt is not None:
            # One that exited is started again, at most every five seconds.
            if (self.child is None or self.child.poll() is not None) and time.monotonic() - self.started > 5:
                self.start(command)
            if self.child is not None and self.child.poll() is None and self.reported != attempt:
                self.report(attempt)
                self.reported = attempt
        elif self.child is not None or self.reported is not None:
            self.stop()
            self.report(None)
            self.reported = None


def instances():
    # Each GPU once, in the order given, as host-api reads the list.
    gpus = list(dict.fromkeys(g.strip() for g in os.environ.get(DEVICES, "").split(",") if g.strip())) if DEVICES else []
    return [Instance(g, place) for place, g in enumerate(gpus or ["0"])]


# Prints why this PyTorch can't run on the GPU, or nothing. A kernel built
# for sm_XY runs on X.Y up to X.9; PTX for compute_XY compiles on X.Y and up.
CHECK = r"""
import re, torch
if torch.version.cuda and torch.cuda.is_available():
    cap = torch.cuda.get_device_capability(0)
    # Names like sm_90a carry a letter after the number.
    archs = [(m[1], divmod(int(m[2]), 10)) for m in (re.match(r"(sm|compute)_(\d+)", a) for a in torch.cuda.get_arch_list()) if m]
    if not any((k == "sm" and a[0] == cap[0] and a[1] <= cap[1]) or (k == "compute" and a <= cap) for k, a in archs):
        print(f"{torch.cuda.get_device_name(0)} is sm_{cap[0]}{cap[1]}, and this ComfyUI's PyTorch {torch.__version__} has kernels only for {', '.join(torch.cuda.get_arch_list())}, so it can't make images on it.")
"""


def unsupported(env):
    """Why ComfyUI can't run on this GPU, or None (also when the check itself fails)."""
    try:
        out = subprocess.run([sys.executable, "-c", CHECK], capture_output=True, text=True, timeout=120, env=env)
        return out.stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


def main(command):
    done = []
    signal.signal(signal.SIGTERM, lambda *_: done.append(True))
    signal.signal(signal.SIGINT, lambda *_: done.append(True))
    ones = instances()
    for one in ones:
        one.problem = unsupported(one.env)
        one.report(None)
    ones = [one for one in ones if not one.problem]
    while not done:
        for one in ones:
            one.tick(command)
        time.sleep(0.5)
    for one in ones:
        one.stop()


def health():
    for one in instances():
        try:
            with open(one.status) as f:
                if json.load(f).get("unsupported"):
                    return 1
        except (OSError, ValueError, AttributeError):
            pass
        if one.wanted() is not None:
            urllib.request.urlopen(f"http://127.0.0.1:{one.port}/system_stats", timeout=5)
    return 0


if __name__ == "__main__":
    if sys.argv[1:] == ["--health"]:
        sys.exit(health())
    main(sys.argv[1:])
