# ComfyUI for the model host: pinned ComfyUI and custom nodes, no plugin
# manager, and only these nodes load. Build from the repository root:
#   docker build -f host/comfyui/Dockerfile --build-arg BASE=<cuda or rocm base> .
# The bases are pinned by digest in host/compose.nvidia.yaml and compose.amd.yaml.
ARG BASE=pytorch/pytorch:2.14.0-cuda13.0-cudnn9-runtime@sha256:9c99fafa01edfaa3d16da8c209b38b5970bb6fd6e72725ef60efc901489f70c6
FROM ${BASE}

ARG COMFYUI_COMMIT=daeb5e53681e2b10a3f0727d9ec5bc90784bee10
ARG GGUF_COMMIT=6ea2651e7df66d7585f6ffee804b20e92fb38b8a
ARG SEEDVR2_COMMIT=4490bd1f482e026674543386bb2a4d176da245b9

RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

# One fetch per repository at an exact commit; nothing else from the network at run time.
RUN set -eux; \
    fetch() { mkdir -p "$2"; cd "$2"; git init -q; git remote add origin "https://github.com/$1"; git fetch -q --depth 1 origin "$3"; git checkout -q FETCH_HEAD; rm -rf .git; }; \
    fetch comfyanonymous/ComfyUI /opt/comfyui "$COMFYUI_COMMIT"; \
    fetch city96/ComfyUI-GGUF /opt/comfyui/custom_nodes/ComfyUI-GGUF "$GGUF_COMMIT"; \
    fetch numz/ComfyUI-SeedVR2_VideoUpscaler /opt/comfyui/custom_nodes/ComfyUI-SeedVR2_VideoUpscaler "$SEEDVR2_COMMIT"; \
    rm -f /opt/comfyui/custom_nodes/example_node.py.example

# The packages go into a venv that also sees the base image's torch. Every
# package is pinned with its hash in requirements.txt (made by lock.sh), and
# none is resolved here. The system pip installs into the venv (--python), so
# the venv needs no pip of its own.
COPY host/comfyui/requirements.txt /tmp/requirements.txt
RUN set -eux; \
    python3 -m venv --system-site-packages --without-pip /opt/venv; \
    python3 -m pip --python /opt/venv/bin/python install --no-cache-dir --require-hashes --no-deps -r /tmp/requirements.txt; \
    rm /tmp/requirements.txt; \
    /opt/venv/bin/python -c "import torch, torchsde, spandrel, kornia, gguf, diffusers, cv2, av"; \
    /opt/venv/bin/python -m compileall -q /opt/comfyui
ENV PATH=/opt/venv/bin:$PATH

COPY host/comfyui/extra_model_paths.yaml /opt/comfyui/extra_model_paths.yaml
RUN useradd --uid 10002 --no-create-home --home-dir /tmp comfy
USER 10002
WORKDIR /opt/comfyui
ENV HOME=/tmp HF_HUB_OFFLINE=1 DO_NOT_TRACK=1

# Folders in /tmp are tmpfs (see the compose files): prompts and images live in memory only.
# Only the three custom nodes load; metadata saving and previews are off;
# API nodes (paid cloud services) are disabled.
ENTRYPOINT ["sh", "-c", "mkdir -p /tmp/comfy/input /tmp/comfy/output /tmp/comfy/temp /tmp/comfy/user && exec /opt/venv/bin/python main.py \
  --listen 0.0.0.0 --port 8188 --disable-auto-launch --disable-metadata --disable-api-nodes --preview-method none \
  --disable-all-custom-nodes --whitelist-custom-nodes websocket_image_save.py ComfyUI-GGUF ComfyUI-SeedVR2_VideoUpscaler \
  --input-directory /tmp/comfy/input --output-directory /tmp/comfy/output --temp-directory /tmp/comfy/temp \
  --user-directory /tmp/comfy/user --extra-model-paths-config /opt/comfyui/extra_model_paths.yaml"]
