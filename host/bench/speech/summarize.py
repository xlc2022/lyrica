"""Turns results.jsonl into results.md: one table for voices, one for dictation, and what broke."""
import json
import os
import sys

out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "results")
rows = [json.loads(line) for line in open(os.path.join(out, "results.jsonl"), encoding="utf-8-sig") if line.strip()]
md = ["# Speech benchmark", ""]
env = [r["environment"] for r in rows if "environment" in r]
if env:
    md += [f"- GPU: {env[0].get('gpu')}, {env[0].get('gpuUsedBeforeGb')} GB in use before", f"- {env[0].get('platform')}", ""]

md += ["## Voices", "", "| Model | Device | Voice | Sentence | First audio (s) | Audio (s) | RTF | Peak VRAM (GB) |", "|---|---|---|---|---|---|---|---|"]
for r in rows:
    if r["part"] == "tts" and "firstAudioSeconds" in r:
        md.append(f"| {r['model']} | {r['device']} | {r['voice']} | {r['sentence']} | {r['firstAudioSeconds']} | {r['audioSeconds']} | {r['realTimeFactor']} | {r.get('peakVramGb')} |")
licences = {r["model"]: r["licence"] for r in rows if r.get("licence")}
md += [""] + [f"- {m}: {l}" for m, l in licences.items()] + [""]

md += ["## Dictation", "", "| Model | Clip | Language | WER/CER | Seconds | Text |", "|---|---|---|---|---|---|"]
for r in rows:
    if r["part"] == "stt" and "text" in r:
        score = f"wer {r['wer']}" if "wer" in r else f"cer {r['cer']}"
        md.append(f"| {r['model']} | {r['clip']} | {r['language']} | {score} | {r['seconds']} | {r['text'].replace('|', '/')} |")
md += ["", "| Model | Load (s) | Peak VRAM (GB) | Seconds per minute of audio |", "|---|---|---|---|"]
for r in rows:
    if r.get("summary"):
        md.append(f"| {r['model']} | {r['loadSeconds']} | {r['peakVramGb']} | {r['secondsPerMinuteOfAudio']} |")

broke = [r for r in rows if "error" in r]
md += ["", "## What broke", ""] + ([f"- {r['part']} {r.get('model')}: {r['error']}" for r in broke] or ["Nothing."])
open(os.path.join(out, "results.md"), "w", encoding="utf-8").write("\n".join(md) + "\n")
print("\n".join(md))
