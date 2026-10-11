"""Dictation: Whisper large-v3-turbo and Voxtral Mini, on the GPU through transformers.

The host would serve them with vLLM (Linux only), which is faster; this
checks accuracy on English, Mandarin and the two mixed, and gives a rough
speed. Inputs: the voice samples made before this, and your own recordings
in recordings/ (en, zh and mixed, as .wav or .flac, saying the three sentences), if
there. Your recordings aren't copied into the results, only their
transcripts.
"""
import glob
import os
import re
import time

from common import OUT, SAMPLES, SENTENCES, GpuMemory, environment, failed, record

PART = "stt"
environment(PART)

recordings = os.environ.get("BENCH_RECORDINGS", os.path.join(OUT, "..", "recordings"))
clips = []
for path in sorted(glob.glob(os.path.join(SAMPLES, "*.wav"))):
    key = os.path.basename(path)[:-4].rsplit("_", 1)[-1]
    if key in SENTENCES:
        clips.append((f"sample {os.path.basename(path)}", path, key))
for key in SENTENCES:
    for ext in ("wav", "flac"):
        path = os.path.join(recordings, f"{key}.{ext}")
        if os.path.exists(path):
            clips.append((f"your recording {key}.{ext}", path, key))
record(PART, clips=len(clips), recordings=sum(c[0].startswith("your") for c in clips))

import librosa  # noqa: E402
import torch  # noqa: E402
from jiwer import cer, wer  # noqa: E402
from opencc import OpenCC  # noqa: E402

simplified = OpenCC("t2s")
PUNCT = re.compile(r"[\s\.,!?;:'\"，。！？；：、“”‘’（）()\-]+")


def score(key, text):
    """WER for English; CER for Mandarin and mixed, in simplified characters, ignoring case, spaces and punctuation."""
    ref, hyp = SENTENCES[key], text or ""
    if key == "en":
        norm = lambda s: PUNCT.sub(" ", s.lower().replace("you're", "you are")).split()  # noqa: E731
        return "wer", round(wer(" ".join(norm(ref)), " ".join(norm(hyp)) or "-"), 3)
    norm = lambda s: PUNCT.sub("", simplified.convert(s).lower())  # noqa: E731
    return "cer", round(cer(norm(ref), norm(hyp) or "-"), 3)


audio = {path: librosa.load(path, sr=16000)[0] for _, path, _ in clips}


def run(model, transcribe, load):
    mem = GpuMemory()
    try:
        t = time.perf_counter()
        handle = load()
        loaded = time.perf_counter() - t
    except Exception as e:  # noqa: BLE001
        failed(PART, model, f"load: {e}")
        mem.stop()
        return
    spent = heard = 0.0
    for label, path, key in clips:
        for language in (None, "en" if key == "en" else "zh"):
            try:
                wav = audio[path]
                transcribe(handle, wav, language)  # warm up
                t = time.perf_counter()
                text = transcribe(handle, wav, language)
                seconds = time.perf_counter() - t
                if language is None:
                    spent += seconds
                    heard += wav.size / 16000
                metric, value = score(key, text)
                record(PART, model=model, clip=label, sentence=key, language=language or "detect", text=text, **{metric: value}, seconds=round(seconds, 3))
            except Exception as e:  # noqa: BLE001
                failed(PART, model, f"{label} ({language or 'detect'}): {e}")
    record(PART, model=model, summary=True, loadSeconds=round(loaded, 2), peakVramGb=mem.peak_gb(),
           secondsPerMinuteOfAudio=round(spent / heard * 60, 2) if heard else None)
    mem.stop()
    del handle
    torch.cuda.empty_cache()


def whisper_load():
    from transformers import pipeline

    return pipeline("automatic-speech-recognition", model="openai/whisper-large-v3-turbo", dtype=torch.float16, device="cuda:0")


def whisper(pipe, wav, language):
    kwargs = {"task": "transcribe", **({"language": language} if language else {})}
    return pipe({"raw": wav, "sampling_rate": 16000}, generate_kwargs=kwargs)["text"].strip()


VOXTRAL = "mistralai/Voxtral-Mini-3B-2507"


def voxtral_load():
    from transformers import AutoProcessor, VoxtralForConditionalGeneration

    return AutoProcessor.from_pretrained(VOXTRAL), VoxtralForConditionalGeneration.from_pretrained(VOXTRAL, dtype=torch.bfloat16, device_map="cuda:0")


def voxtral(handle, wav, language):
    processor, model = handle
    inputs = processor.apply_transcription_request(language=language, audio=wav, sampling_rate=16000, format="wav", model_id=VOXTRAL)
    inputs = inputs.to("cuda:0", dtype=torch.bfloat16)
    out = model.generate(**inputs, max_new_tokens=300)
    return processor.batch_decode(out[:, inputs.input_ids.shape[1]:], skip_special_tokens=True)[0].strip()


run("whisper-large-v3-turbo", whisper, whisper_load)
run("voxtral-mini-3b", voxtral, voxtral_load)
