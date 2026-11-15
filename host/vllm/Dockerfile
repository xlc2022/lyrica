# vLLM's own image (CUDA or ROCm, from compose.nvidia.yaml or compose.amd.yaml)
# with the audio libraries mistral-common reads clips with, which it ships
# without: Voxtral's dictation fails to start with "soundfile is not
# installed" otherwise. Both wheels carry their own native library, and are
# pinned by hash (requirements.txt), so nothing is fetched at run time.
ARG IMAGE
FROM ${IMAGE}
COPY requirements.txt /tmp/lyrica-requirements.txt
# The CUDA image installs with uv, the ROCm one with pip. --no-deps: numpy and cffi are already there.
RUN if command -v uv >/dev/null; then uv pip install --system --no-deps --require-hashes -r /tmp/lyrica-requirements.txt; \
    else python3 -m pip install --no-cache-dir --no-deps --require-hashes -r /tmp/lyrica-requirements.txt; fi && \
    rm /tmp/lyrica-requirements.txt && python3 -c "import soundfile, soxr"
