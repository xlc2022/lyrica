# The model host's speech server: Kokoro voice models through ONNX Runtime,
# on the CPU or an NVIDIA GPU. Build from the repository root:
#   docker build -f host/speech/Dockerfile --build-arg FLAVOUR=cpu|cuda .
# Every package is pinned with its hash (lock.sh); nothing is fetched at run time.
ARG BASE=python:3.12.15-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258
FROM ${BASE}
ARG FLAVOUR=cpu

COPY host/speech/requirements.${FLAVOUR}.txt /tmp/requirements.txt
RUN set -eux; \
    pip install --no-cache-dir --require-hashes --no-deps -r /tmp/requirements.txt; \
    rm /tmp/requirements.txt; \
    python -c "import onnxruntime, espeakng_loader, en_core_web_sm; from misaki import en, zh"

COPY host/speech/server.py /opt/speech/server.py
RUN python -m compileall -q /opt/speech && useradd --uid 10003 --no-create-home --home-dir /tmp speech
USER 10003
# /tmp is a tmpfs (see compose.yaml): the only place it can write.
ENV HOME=/tmp PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
ENTRYPOINT ["python", "/opt/speech/server.py"]
