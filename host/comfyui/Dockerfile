# ComfyUI for the model host: pinned ComfyUI and custom nodes, no plugin
# manager, and only these nodes load. Build from the repository root:
#   docker build -f host/comfyui/Dockerfile --build-arg BASE=<cuda or rocm base> .
# The bases are pinned by digest in host/compose.nvidia.yaml and compose.amd.yaml.
ARG BASE=pytorch/pytorch:2.14.0-cuda13.0-cudnn9-runtime@sha256:9c99fafa01edfaa3d16da8c209b38b5970bb6fd6e72725ef60efc901489f70c6
FROM ${BASE}

ARG COMFYUI_COMMIT=086099f5d8886163ef77dc354f8382cb7431582a
ARG GGUF_COMMIT=6ea2651e7df66d7585f6ffee804b20e92fb38b8a
ARG SEEDVR2_COMMIT=4490bd1f482e026674543386bb2a4d176da245b9
# LanPaint 2.2.0: masked edits on models without an inpainting checkpoint (Qwen-Image 2.1).
ARG LANPAINT_COMMIT=2d7912f9a5efe5ece8de334c7ca18317b8288c39
# RES4LYF (AGPL-3.0 plus a no-commercial-service clause): its ClownsharKSampler
# and res_2s / bong_tangent, for Krea 2. Krea2T-Enhancer (MIT): Krea 2's prompt
# adherence patch. Its author's repository is gone; the commit is the author's
# own, fetched from a copy. RES4LYF's config, written here, names its samplers
# without folders (res_2s, not exponential/res_2s), so it never writes one.
ARG RES4LYF_COMMIT=119679d8d8d26e6db52757e705488abb6399d7d4
ARG KREA2T_COMMIT=75a14cb93487d0fea7985f199717da46ab5cb53d

RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

# One fetch per repository at an exact commit; nothing else from the network at run time.
RUN set -eux; \
    fetch() { mkdir -p "$2"; cd "$2"; git init -q; git remote add origin "https://github.com/$1"; git fetch -q --depth 1 origin "$3"; git checkout -q FETCH_HEAD; rm -rf .git; }; \
    fetch comfyanonymous/ComfyUI /opt/comfyui "$COMFYUI_COMMIT"; \
    fetch city96/ComfyUI-GGUF /opt/comfyui/custom_nodes/ComfyUI-GGUF "$GGUF_COMMIT"; \
    fetch numz/ComfyUI-SeedVR2_VideoUpscaler /opt/comfyui/custom_nodes/ComfyUI-SeedVR2_VideoUpscaler "$SEEDVR2_COMMIT"; \
    fetch scraed/LanPaint /opt/comfyui/custom_nodes/LanPaint "$LANPAINT_COMMIT"; \
    fetch ClownsharkBatwing/RES4LYF /opt/comfyui/custom_nodes/RES4LYF "$RES4LYF_COMMIT"; \
    fetch Titof974/ComfyUI-Krea2T-Enhancer /opt/comfyui/custom_nodes/ComfyUI-Krea2T-Enhancer "$KREA2T_COMMIT"; \
    printf '{"name": "RES4LYF", "topClownDog": true, "enableDebugLogs": false, "displayCategory": false}\n' > /opt/comfyui/custom_nodes/RES4LYF/res4lyf.config.json; \
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
# Our own nodes: a clip and its poster go back over the websocket, never to disk; a
# driving clip's frames are picked at the model's frame rate.
COPY host/comfyui/websocket_video_save.py /opt/comfyui/custom_nodes/websocket_video_save.py
COPY host/comfyui/video_frames.py /opt/comfyui/custom_nodes/video_frames.py
COPY host/comfyui/clip_chain.py /opt/comfyui/custom_nodes/clip_chain.py
COPY host/comfyui/gate.py /opt/gate.py
# /status is a volume gate.py writes to; a new volume takes this folder's owner.
RUN useradd --uid 10002 --no-create-home --home-dir /tmp comfy && mkdir /status && chown 10002 /status
USER 10002
WORKDIR /opt/comfyui
ENV HOME=/tmp HF_HUB_OFFLINE=1 DO_NOT_TRACK=1

# Folders in /tmp are tmpfs (see the compose files): prompts and images live in memory only.
# Only these custom nodes load; metadata saving and previews are off;
# API nodes (paid cloud services) are disabled. gate.py runs one ComfyUI per
# image GPU, each only while host-api asks, with its own port and folders
# under /tmp/comfy, so a paused or idle host holds no GPU memory here.
ENTRYPOINT ["python3", "/opt/gate.py", "/opt/venv/bin/python", "main.py", \
  "--listen", "0.0.0.0", "--disable-auto-launch", "--disable-metadata", "--disable-api-nodes", "--preview-method", "none", \
  "--disable-all-custom-nodes", "--whitelist-custom-nodes", "websocket_image_save.py", "websocket_video_save.py", "video_frames.py", "clip_chain.py", "ComfyUI-GGUF", "ComfyUI-SeedVR2_VideoUpscaler", "LanPaint", "RES4LYF", "ComfyUI-Krea2T-Enhancer", \
  "--extra-model-paths-config", "/opt/comfyui/extra_model_paths.yaml"]
