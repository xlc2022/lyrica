# The model host's Qwen3-TTS speech server: Qwen3-TTS voice models through
# faster-qwen3-tts on one NVIDIA GPU each. CI publishes both flavours
# (prebuilt.sh, cmp-images.yml); install.sh builds one here only when it
# can't pull it:
#   docker build --build-arg FLAVOUR=cu126|cu130 host/speech-qwen
# cu126 covers a CMP 100-210 (Volta) through Hopper; cu130, Turing and newer
# (Blackwell). Every package is pinned with its hash (lock.sh); nothing is
# fetched at run time.
ARG BASE=python:3.12.16-slim-bookworm@sha256:e697c81897302a4c4333bade000d98038fbb21eb064f8ee1fd42d02ebcd9d337
FROM ${BASE}
ARG FLAVOUR=cu126

COPY requirements.${FLAVOUR}.txt /tmp/requirements.txt
RUN set -eux; \
    pip install --no-cache-dir --require-hashes --no-deps -r /tmp/requirements.txt; \
    rm /tmp/requirements.txt; \
    python -c "import faster_qwen3_tts, qwen_tts, torch; assert torch.__version__.startswith('2.14.1')"

COPY server.py /opt/speech/server.py
COPY voices /opt/speech/voices
# It runs as the user that downloads the models (10001), so it reads them
# whatever the mode of the models folder's lyrica/.
RUN python -m compileall -q /opt/speech && useradd --uid 10001 --no-create-home --home-dir /tmp speech
USER 10001
# /tmp is a tmpfs (see compose.nvidia.yaml): the only place it can write.
# Nothing is fetched from a hub, and Triton and Inductor caches stay in /tmp.
ENV HOME=/tmp PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
    HF_HUB_DISABLE_TELEMETRY=1 TRITON_CACHE_DIR=/tmp/triton TORCHINDUCTOR_CACHE_DIR=/tmp/inductor
ENTRYPOINT ["python", "/opt/speech/server.py"]
