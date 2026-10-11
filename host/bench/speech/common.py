"""Shared by the speech benchmark's scripts: the sentences, timing, GPU memory and results."""
import json
import os
import platform
import statistics
import sys
import threading
import time
import traceback

SENTENCES = {
    "en": "I put the recipe in the chat, so you can look at it when you're back in the kitchen.",
    "zh": "我把菜谱放在聊天里了，你回到厨房的时候可以看一下。",
    "mixed": "明天下午三点的 meeting 改到 Zoom 上了，记得带上 laptop。",
}

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "results")
SAMPLES = os.path.join(OUT, "samples")
os.makedirs(SAMPLES, exist_ok=True)


def record(part, **fields):
    """Appends one result line to results.jsonl."""
    fields = {"part": part, "at": time.strftime("%Y-%m-%dT%H:%M:%S"), **fields}
    with open(os.path.join(OUT, "results.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps(fields, ensure_ascii=False) + "\n")
    print(json.dumps(fields, ensure_ascii=False), flush=True)


def failed(part, model, what):
    """Records a step that broke, with its traceback, and carries on."""
    record(part, model=model, error=what, trace=traceback.format_exc()[-4000:])


def median_time(fn, runs=3):
    """Runs fn once to warm up, then `runs` times; returns (median seconds, last result)."""
    fn()
    times, result = [], None
    for _ in range(runs):
        t = time.perf_counter()
        result = fn()
        times.append(time.perf_counter() - t)
    return statistics.median(times), result


class GpuMemory:
    """Peak memory used on the benchmark's GPU, sampled every 20 ms with NVML, above a baseline."""

    def __init__(self):
        import pynvml

        pynvml.nvmlInit()
        self.nvml = pynvml
        self.handle = pynvml.nvmlDeviceGetHandleByIndex(int(os.environ.get("BENCH_NVML_INDEX", "0")))
        self.name = pynvml.nvmlDeviceGetName(self.handle)
        self.name = self.name.decode() if isinstance(self.name, bytes) else self.name
        self.baseline = self.used()
        self.peak = self.baseline
        self._stop = False
        threading.Thread(target=self._watch, daemon=True).start()

    def used(self):
        return self.nvml.nvmlDeviceGetMemoryInfo(self.handle).used

    def _watch(self):
        while not self._stop:
            self.peak = max(self.peak, self.used())
            time.sleep(0.02)

    def peak_gb(self):
        return round((self.peak - self.baseline) / 1024**3, 2)

    def stop(self):
        self._stop = True


def environment(part):
    info = {"python": sys.version.split()[0], "platform": platform.platform()}
    try:
        g = GpuMemory()
        info["gpu"] = g.name
        info["gpuUsedBeforeGb"] = round(g.baseline / 1024**3, 2)
        g.stop()
    except Exception as e:  # noqa: BLE001
        info["gpu"] = f"unknown ({e})"
    record(part, environment=info)


def write_wav(path, audio, rate):
    import numpy as np
    import soundfile as sf

    sf.write(path, np.asarray(audio, dtype="float32").reshape(-1), rate)
