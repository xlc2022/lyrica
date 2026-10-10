"""Kokoro-82M through its ONNX export, on the GPU (onnxruntime-gpu) and on the CPU.

Both exports from onnx-community: v1.0 (54 voices, most of them English) and
v1.1-zh (100 Mandarin voices and three English ones). The host would run
exactly this: model.onnx and voices/*.bin, raw float32 arrays.
"""
import json
import os
import re
import time

from common import SAMPLES, SENTENCES, GpuMemory, environment, failed, median_time, record, write_wav

PART = "tts"
RATE = 24000
EXPORTS = {
    "kokoro-v1.0": ("onnx-community/Kokoro-82M-v1.0-ONNX", ["af_heart", "bf_emma", "zf_xiaoxiao", "zm_yunxi"]),
    "kokoro-v1.1-zh": ("onnx-community/Kokoro-82M-v1.1-zh-ONNX", ["af_maple", "zf_001", "zm_010"]),
}

environment(PART)

import espeakng_loader  # noqa: E402
import numpy as np  # noqa: E402
import onnxruntime as ort  # noqa: E402
from huggingface_hub import snapshot_download  # noqa: E402
from phonemizer.backend.espeak.wrapper import EspeakWrapper  # noqa: E402

EspeakWrapper.set_library(espeakng_loader.get_library_path())
EspeakWrapper.set_data_path(espeakng_loader.get_data_path())
from misaki import en, espeak, zh  # noqa: E402

if hasattr(ort, "preload_dlls"):
    ort.preload_dlls()  # the CUDA and cuDNN DLLs from the nvidia-* wheels

english = en.G2P(trf=False, british=False, fallback=espeak.EspeakFallback(british=False))
CJK = re.compile(r"([　-〿一-鿿＀-￯]+)")


def phonemes(export, lang, text):
    if lang == "en":
        return english(text)[0]
    if export == "kokoro-v1.1-zh":
        return zh.ZHG2P(version="1.1", en_callable=lambda s: english(s)[0])(text)[0]
    # v1.0's Mandarin G2P leaves English as letters: phonemize those runs as English.
    g = zh.ZHG2P()
    parts = []
    for run in CJK.split(text):
        if not run.strip():
            parts.append(run)
        elif CJK.fullmatch(run):
            p = g(run)
            parts.append(p[0] if isinstance(p, tuple) else p)
        else:
            parts.append(english(run)[0])
    return "".join(parts)


def vocab_of(folder):
    for name, path in (("config.json", ("vocab",)), ("tokenizer.json", ("model", "vocab"))):
        try:
            with open(os.path.join(folder, name), encoding="utf-8") as f:
                v = json.load(f)
            for k in path:
                v = v[k]
            return v
        except (OSError, KeyError, TypeError):
            continue
    raise RuntimeError("no vocab in config.json or tokenizer.json")


for export, (repo, voices) in EXPORTS.items():
    try:
        folder = snapshot_download(repo, allow_patterns=["onnx/model.onnx", "config.json", "tokenizer.json", "voices/*"])
        vocab = vocab_of(folder)
        available = sorted(f[:-4] for f in os.listdir(os.path.join(folder, "voices")) if f.endswith(".bin"))
        record(PART, model=export, voices=available)
    except Exception as e:  # noqa: BLE001
        failed(PART, export, f"download: {e}")
        continue
    for device in ("cuda", "cpu"):
        try:
            mem = GpuMemory() if device == "cuda" else None
            providers = ["CUDAExecutionProvider", "CPUExecutionProvider"] if device == "cuda" else ["CPUExecutionProvider"]
            t = time.perf_counter()
            session = ort.InferenceSession(os.path.join(folder, "onnx", "model.onnx"), providers=providers)
            load = time.perf_counter() - t
            used = session.get_providers()[0]
            names = [i.name for i in session.get_inputs()]
            ids = "input_ids" if "input_ids" in names else "tokens"
        except Exception as e:  # noqa: BLE001
            failed(PART, export, f"load on {device}: {e}")
            continue
        for wanted in voices:
            # The same kind of voice (zf_, zm_, af_ ...) if that one isn't in this export.
            voice = wanted if wanted in available else next((v for v in available if v[:3] == wanted[:3]), None)
            if voice is None:
                record(PART, model=export, voice=wanted, error="no such voice in this export")
                continue
            style_table = np.fromfile(os.path.join(folder, "voices", f"{voice}.bin"), dtype=np.float32).reshape(-1, 1, 256)
            lang = "zh" if voice.startswith("z") else "en"
            for key, text in SENTENCES.items():
                if (lang == "en") != (key == "en"):
                    continue  # English voices say the English sentence; Mandarin voices the other two
                try:
                    ph = phonemes(export, lang, text)
                    tokens = [vocab[c] for c in ph if c in vocab][:510]
                    feed = {
                        ids: np.array([[0, *tokens, 0]], dtype=np.int64),
                        "style": style_table[len(tokens)].astype(np.float32),
                        "speed": np.array([1.0], dtype=np.float32),
                    }
                    seconds, out = median_time(lambda: session.run(None, feed)[0])
                    audio = np.asarray(out).reshape(-1)
                    if device == "cuda":
                        write_wav(os.path.join(SAMPLES, f"{export}_{voice}_{key}.wav"), audio, RATE)
                    record(
                        PART, model=export, device=device, provider=used, voice=voice, sentence=key,
                        firstAudioSeconds=round(seconds, 3), audioSeconds=round(audio.size / RATE, 2),
                        realTimeFactor=round(seconds / (audio.size / RATE), 3), loadSeconds=round(load, 2),
                        peakVramGb=mem.peak_gb() if mem else None, phonemes=ph,
                        licence="Apache-2.0 (code and weights)",
                    )
                except Exception as e:  # noqa: BLE001
                    failed(PART, export, f"{voice} {key} on {device}: {e}")
        if mem:
            mem.stop()
        del session
