#!/bin/sh
# Writes requirements.cpu.txt and requirements.cuda.txt: every package the
# speech image installs, pinned with its hashes, for Python 3.12 on x86-64
# Linux. The CUDA one adds the ONNX runtime's GPU build and NVIDIA's CUDA and
# cuDNN libraries as wheels, so the image needs no CUDA base.
set -eu
cd "$(dirname "$0")"
for flavour in cpu cuda; do
  if [ "$flavour" = cpu ]; then ort="onnxruntime==1.23.2"; else ort="onnxruntime-gpu[cuda,cudnn]==1.23.2"; fi
  { cat requirements.in; echo "$ort"; } > /tmp/lyrica-speech.in
  uv pip compile /tmp/lyrica-speech.in --python-version 3.12 --python-platform x86_64-manylinux_2_28 \
    --generate-hashes --no-header --no-annotate -o "requirements.$flavour.txt"
done
rm -f /tmp/lyrica-speech.in
