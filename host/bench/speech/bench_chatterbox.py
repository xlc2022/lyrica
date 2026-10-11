"""Chatterbox multilingual (Resemble AI), with its stock voice, through the chatterbox-tts package.

Its weights are safetensors, but the stock voice it loads (conds.pt) is a
pickle, which the host refuses: running it there would need that voice
converted, or a reference clip.
"""
import os

from common import SAMPLES, SENTENCES, GpuMemory, environment, failed, median_time, record, write_wav

PART = "tts"
MODEL = "chatterbox-multilingual"
environment(PART)

try:
    import time

    import perth
    import torch

    watermark = "Perth"
    if perth.PerthImplicitWatermarker is None:
        # Its import failed (it needs pkg_resources): measure without the watermark rather than not at all.
        class NoWatermark:
            def apply_watermark(self, wav, sample_rate=None, **kw):
                return wav

        perth.PerthImplicitWatermarker = NoWatermark
        watermark = "off (Perth didn't load)"
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS

    mem = GpuMemory()
    t = time.perf_counter()
    tts = ChatterboxMultilingualTTS.from_pretrained(device="cuda")
    load = time.perf_counter() - t
except Exception as e:  # noqa: BLE001
    failed(PART, MODEL, f"load: {e}")
    raise SystemExit(0)

for key, text in SENTENCES.items():
    lang = "en" if key == "en" else "zh"
    try:
        torch.cuda.reset_peak_memory_stats()
        seconds, wav = median_time(lambda: tts.generate(text, language_id=lang))
        audio = wav.squeeze().float().cpu().numpy()
        write_wav(os.path.join(SAMPLES, f"{MODEL}_default_{key}.wav"), audio, tts.sr)
        record(
            PART, model=MODEL, device="cuda", voice="default", sentence=key, languageId=lang,
            firstAudioSeconds=round(seconds, 3), streaming=False, audioSeconds=round(audio.size / tts.sr, 2),
            realTimeFactor=round(seconds / (audio.size / tts.sr), 3), loadSeconds=round(load, 2),
            peakVramGb=mem.peak_gb(), torchPeakGb=round(torch.cuda.max_memory_allocated() / 1024**3, 2),
            licence="MIT (code and weights)", watermark=watermark,
        )
    except Exception as e:  # noqa: BLE001
        failed(PART, MODEL, f"{key}: {e}")
mem.stop()
