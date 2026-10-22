# llama.cpp for a host with a CMP 100-210 (compose.cmp.yaml): the stock
# server image's tag, built with GGML_CUDA_FORCE_MMQ so quantized matrix
# multiplies use int8 (dp4a) instead of the card's throttled FP16 tensor
# cores. On Turing and newer cards ggml uses those kernels anyway. Built like
# the official .devops/cuda.Dockerfile, without the web UI.
ARG DEVEL=nvidia/cuda:12.8.1-devel-ubuntu24.04@sha256:520292dbb4f755fd360766059e62956e9379485d9e073bbd2f6e3c20c270ed66
ARG RUNTIME=nvidia/cuda:12.8.1-runtime-ubuntu24.04@sha256:ebef3c171eeef0298e4eb2e4be843105edf3b8b0ac45e0b43acee358e8046867

FROM ${DEVEL} AS build
# The tag compose.nvidia.yaml's image is built from, and its commit.
ARG TAG=b11459
ARG COMMIT=f498f864fbc0472004ee1c3616c1188c68eb157f
# The host's GPUs' compute capabilities, as install.sh found them (e.g. 70-real).
ARG CUDA_ARCHS
RUN apt-get update && apt-get install -y --no-install-recommends gcc-14 g++-14 cmake git ca-certificates libssl-dev && rm -rf /var/lib/apt/lists/*
ENV CC=gcc-14 CXX=g++-14 CUDAHOSTCXX=g++-14
WORKDIR /src
RUN git clone --depth 1 --branch "$TAG" https://github.com/ggml-org/llama.cpp . && test "$(git rev-parse HEAD)" = "$COMMIT"
RUN test -n "$CUDA_ARCHS" && \
    cmake -B build -DGGML_NATIVE=OFF -DGGML_CUDA=ON -DGGML_CUDA_FORCE_MMQ=ON -DCMAKE_CUDA_ARCHITECTURES="$CUDA_ARCHS" \
      -DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON -DLLAMA_BUILD_TESTS=OFF -DLLAMA_USE_PREBUILT_UI=OFF \
      -DCMAKE_EXE_LINKER_FLAGS=-Wl,--allow-shlib-undefined && \
    cmake --build build --config Release --target llama-server -j"$(nproc)"
RUN mkdir -p /app && find build -name "*.so*" -exec cp -P {} /app \; && cp build/bin/llama-server /app

FROM ${RUNTIME}
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app /app
WORKDIR /app
ENTRYPOINT ["/app/llama-server"]
