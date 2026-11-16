#!/bin/sh
# Writes requirements.cu126.txt and requirements.cu130.txt: every package the
# Qwen3-TTS speech image installs, pinned with its hashes, for Python 3.12 on
# x86-64 Linux. PyTorch and torchaudio come from PyTorch's own index for each
# CUDA build (named in each file, for pip), with NVIDIA's CUDA libraries as wheels, so the image needs no
# CUDA base:
# - cu126: PyTorch's last CUDA 12.6 wheels, which still carry Volta (sm_70)
#   kernels: a CMP 100-210 through Hopper.
# - cu130: Turing and newer, Blackwell included.
set -eu
cd "$(dirname "$0")"
for flavour in cu126 cu130; do
  uv pip compile requirements.in --overrides overrides.txt \
    --python-version 3.12 --python-platform x86_64-manylinux_2_28 \
    --index-url https://pypi.org/simple --extra-index-url "https://download.pytorch.org/whl/$flavour" \
    --index-strategy unsafe-best-match \
    --emit-index-url --generate-hashes --no-header --no-annotate -o "requirements.$flavour.txt"
done
