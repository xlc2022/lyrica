# whisper.cpp's whisper-server, for dictation on a CMP 100-210
# (compose.whisper.yaml), whose sm_70 vLLM's PyTorch has no kernels for.
# Built with GGML_CUDA_FORCE_MMQ so quantized matrix multiplies use int8
# (dp4a) instead of the card's throttled FP16 tensor cores, with ggml linked
# in. gate.sh runs it for the model host-api asks for.
ARG DEVEL=nvidia/cuda:12.8.1-devel-ubuntu24.04@sha256:520292dbb4f755fd360766059e62956e9379485d9e073bbd2f6e3c20c270ed66
ARG RUNTIME=nvidia/cuda:12.8.1-runtime-ubuntu24.04@sha256:ebef3c171eeef0298e4eb2e4be843105edf3b8b0ac45e0b43acee358e8046867

FROM ${DEVEL} AS build
# v1.9.5
ARG COMMIT=d1be6fde11ac6e0407606b4e42fe72d34add8037
# The host's GPUs' compute capabilities, as install.sh found them (e.g. 70-real).
ARG CUDA_ARCHS
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git init -q && git remote add origin https://github.com/ggml-org/whisper.cpp && \
    git fetch -q --depth 1 origin "$COMMIT" && git checkout -q FETCH_HEAD
RUN test -n "$CUDA_ARCHS" && \
    cmake -B build -DGGML_CUDA=ON -DGGML_CUDA_FORCE_MMQ=ON -DCMAKE_CUDA_ARCHITECTURES="$CUDA_ARCHS" -DGGML_NATIVE=OFF \
      -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF && \
    cmake --build build --config Release --target whisper-server -j"$(nproc)"

FROM ${RUNTIME}
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 jq && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/build/bin/whisper-server /whisper/whisper-server
COPY gate.sh /whisper/gate.sh
WORKDIR /whisper
# It runs as the user that downloads the models (fetch, 10001), so it can read
# them however the models folder's lyrica/ is set; /status becomes the volume's.
RUN install -d -o 10001 -g 10001 /status
USER 10001:10001
ENTRYPOINT ["/whisper/gate.sh"]
