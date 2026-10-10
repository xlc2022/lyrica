"""CosyVoice 2 (0.5B), zero-shot from the repo's own prompt clip, streamed.

Its main weights (llm.pt, flow.pt, hift.pt) are pickles, which the host
refuses. This runs it from the repo at a fixed commit, in its own venv.
"""
import io
import os
import sys
import time
import urllib.request
import zipfile

from common import OUT, SAMPLES, SENTENCES, GpuMemory, environment, failed, record, write_wav

PART = "tts"
MODEL = "cosyvoice2-0.5b"
COSYVOICE = "074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc"
MATCHA = "dd9105b34bf2be2230f4aa1e4769fb586a3c824e"  # the repo's submodule
PROMPT_TEXT = "希望你以后能够做的比我还好呦。"
environment(PART)

work = os.environ.get("BENCH_WORK", os.path.join(OUT, "..", "work"))


def fetch(repo, sha, dest):
    if os.path.isdir(dest):
        return
    data = urllib.request.urlopen(f"https://codeload.github.com/{repo}/zip/{sha}").read()
    zipfile.ZipFile(io.BytesIO(data)).extractall(os.path.dirname(dest))
    os.rename(os.path.join(os.path.dirname(dest), f"{repo.split('/')[1]}-{sha}"), dest)


try:
    code = os.path.join(work, "CosyVoice")
    fetch("FunAudioLLM/CosyVoice", COSYVOICE, code)
    fetch("shivammehta25/Matcha-TTS", MATCHA, os.path.join(work, "Matcha-TTS"))
    sys.path[:0] = [code, os.path.join(work, "Matcha-TTS")]
    from huggingface_hub import snapshot_download

    model_dir = snapshot_download("FunAudioLLM/CosyVoice2-0.5B")
    import torch
    from cosyvoice.cli.cosyvoice import CosyVoice2

    mem = GpuMemory()
    t = time.perf_counter()
    tts = CosyVoice2(model_dir, load_jit=False, load_trt=False, fp16=True)
    load = time.perf_counter() - t
    prompt = os.path.join(code, "asset", "zero_shot_prompt.wav")
except Exception as e:  # noqa: BLE001
    failed(PART, MODEL, f"load: {e}")
    raise SystemExit(0)


def once(text):
    """Streams one sentence: seconds to the first chunk, total seconds, the audio."""
    t = time.perf_counter()
    first, chunks = None, []
    for out in tts.inference_zero_shot(text, PROMPT_TEXT, prompt, stream=True):
        if first is None:
            first = time.perf_counter() - t
        chunks.append(out["tts_speech"])
    return first, time.perf_counter() - t, torch.cat(chunks, dim=1)


for key, text in SENTENCES.items():
    try:
        once(text)  # warm up
        runs = [once(text) for _ in range(3)]
        runs.sort(key=lambda r: r[0])
        first, total, wav = runs[1]
        audio = wav.squeeze().float().cpu().numpy()
        write_wav(os.path.join(SAMPLES, f"{MODEL}_prompt_{key}.wav"), audio, tts.sample_rate)
        record(
            PART, model=MODEL, device="cuda", voice="repo zero-shot prompt", sentence=key,
            firstAudioSeconds=round(first, 3), streaming=True, totalSeconds=round(total, 3),
            audioSeconds=round(audio.size / tts.sample_rate, 2), realTimeFactor=round(total / (audio.size / tts.sample_rate), 3),
            loadSeconds=round(load, 2), peakVramGb=mem.peak_gb(), licence="Apache-2.0 (code and weights)",
        )
    except Exception as e:  # noqa: BLE001
        failed(PART, MODEL, f"{key}: {e}")
mem.stop()
