# The model host's speech server: Kokoro voice models through ONNX Runtime,
# on the CPU or an NVIDIA GPU. Build from the repository root:
#   docker build -f host/speech/Dockerfile --build-arg FLAVOUR=cpu|cuda|cuda-volta .
# Every package is pinned with its hash (lock.sh); nothing is fetched at run time.
ARG BASE=python:3.12.16-slim-bookworm@sha256:e697c81897302a4c4333bade000d98038fbb21eb064f8ee1fd42d02ebcd9d337
FROM ${BASE}
ARG FLAVOUR=cpu

COPY host/speech/requirements.${FLAVOUR}.txt /tmp/requirements.txt
RUN set -eux; \
    pip install --no-cache-dir --require-hashes --no-deps -r /tmp/requirements.txt; \
    rm /tmp/requirements.txt; \
    python -c "import onnxruntime, espeakng_loader, en_core_web_sm; from misaki import en, zh"

COPY host/speech/server.py /opt/speech/server.py
# It runs as the user that downloads the models (10001), so it reads them
# whatever the mode of the models folder's lyrica/.
RUN python -m compileall -q /opt/speech && useradd --uid 10001 --no-create-home --home-dir /tmp speech
USER 10001
# /tmp is a tmpfs (see compose.yaml): the only place it can write.
ENV HOME=/tmp PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
ENTRYPOINT ["python", "/opt/speech/server.py"]
