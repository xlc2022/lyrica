#!/bin/sh
# Writes requirements.cpu.txt and requirements.cuda.txt: every package the
# speech image installs, pinned with its hashes, for Python 3.12 on x86-64
# Linux. The CUDA one adds the ONNX runtime's GPU build and NVIDIA's CUDA and
# cuDNN libraries as wheels, so the image needs no CUDA base.
# requirements.cuda-volta.txt is the CUDA one with a cuDNN that still has
# kernels for Volta (sm_70), for a host with a CMP 100-210: newer cuDNN
# releases dropped it, and newer cards need them.
set -eu
VOLTA_CUDNN=9.5.1.17 # the one tested on a CMP; which 9.x last had sm_70 isn't pinned down
cd "$(dirname "$0")"
for flavour in cpu cuda; do
  if [ "$flavour" = cpu ]; then ort="onnxruntime==1.23.2"; else ort="onnxruntime-gpu[cuda,cudnn]==1.23.2"; fi
  { cat requirements.in; echo "$ort"; } > /tmp/lyrica-speech.in
  uv pip compile /tmp/lyrica-speech.in --python-version 3.12 --python-platform x86_64-manylinux_2_28 \
    --generate-hashes --no-header --no-annotate -o "requirements.$flavour.txt"
done
{ cat requirements.in; echo "onnxruntime-gpu[cuda,cudnn]==1.23.2"; echo "nvidia-cudnn-cu12==$VOLTA_CUDNN"; } > /tmp/lyrica-speech.in
uv pip compile /tmp/lyrica-speech.in --python-version 3.12 --python-platform x86_64-manylinux_2_28 \
  --generate-hashes --no-header --no-annotate -o /tmp/lyrica-speech-volta.txt
# Only cuDNN differs: its pin and hashes replace the CUDA lock's.
awk 'NR == FNR { if (/^nvidia-cudnn-cu12==/) p = 1; else if (/^[a-z]/) p = 0; if (p) block = block $0 "\n"; next }
  /^nvidia-cudnn-cu12==/ { printf "%s", block; skip = 1; next }
  skip && /^[a-z]/ { skip = 0 }
  !skip' /tmp/lyrica-speech-volta.txt requirements.cuda.txt > requirements.cuda-volta.txt
rm -f /tmp/lyrica-speech.in /tmp/lyrica-speech-volta.txt
