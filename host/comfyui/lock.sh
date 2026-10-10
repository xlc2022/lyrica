#!/bin/sh
# Writes requirements.txt: every package the ComfyUI image installs, pinned
# with its hashes. torch, torchvision and torchaudio come from the base image,
# so they are taken as given (no dependencies of their own) and left out.
set -eu
cd "$(dirname "$0")"
cat > /tmp/lyrica-uv.toml <<'TOML'
dependency-metadata = [
  { name = "torch", version = "2.14.0", requires-dist = [] },
  { name = "torchvision", version = "0.29.0", requires-dist = [] },
  { name = "torchaudio", version = "2.14.0", requires-dist = [] },
]
TOML
echo 'torch==2.14.0' > /tmp/lyrica-torch.txt
uv pip compile requirements.in --config-file /tmp/lyrica-uv.toml --constraint /tmp/lyrica-torch.txt \
  --universal --python-version 3.12 --generate-hashes --no-header --no-annotate \
  --no-emit-package torch --no-emit-package torchvision --no-emit-package torchaudio \
  -o requirements.txt
rm -f /tmp/lyrica-uv.toml /tmp/lyrica-torch.txt
