# llama.cpp for a host with a CMP 100-210 (compose.cmp.yaml): the stock
# server image's tag, built like the official .devops/cuda.Dockerfile without
# the web UI. The card's FP16 tensor cores are throttled until it is unlocked
# (cmp-unlock.sh), and the unlock lasts until power-off, so entrypoint.sh asks
# tensor-probe at each start. Throttled, it turns on throttled-tensor.patch's
# two switches: quantized matrix multiplies use int8 (dp4a), as
# GGML_CUDA_FORCE_MMQ would, and flash attention on sm_70 the tile kernel.
# On Turing and newer cards ggml uses those kernels anyway.
ARG DEVEL=nvidia/cuda:12.8.1-devel-ubuntu24.04@sha256:520292dbb4f755fd360766059e62956e9379485d9e073bbd2f6e3c20c270ed66
ARG RUNTIME=nvidia/cuda:12.8.1-runtime-ubuntu24.04@sha256:ebef3c171eeef0298e4eb2e4be843105edf3b8b0ac45e0b43acee358e8046867

FROM ${DEVEL} AS build
# The tag compose.nvidia.yaml's image is built from, and its commit.
ARG TAG=b11960
ARG COMMIT=8642541b255bfb5dc39cd351a178be09013a55d6
# The host's GPUs' compute capabilities, as install.sh found them (e.g. 70-real).
ARG CUDA_ARCHS
RUN apt-get update && apt-get install -y --no-install-recommends gcc-14 g++-14 cmake git ca-certificates libssl-dev && rm -rf /var/lib/apt/lists/*
ENV CC=gcc-14 CXX=g++-14 CUDAHOSTCXX=g++-14
WORKDIR /src
RUN git clone --depth 1 --branch "$TAG" https://github.com/ggml-org/llama.cpp . && test "$(git rev-parse HEAD)" = "$COMMIT"
COPY throttled-tensor.patch tensor-probe.c /tmp/
RUN git apply /tmp/throttled-tensor.patch
RUN test -n "$CUDA_ARCHS" && \
    cmake -B build -DGGML_NATIVE=OFF -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES="$CUDA_ARCHS" \
      -DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON -DLLAMA_BUILD_TESTS=OFF -DLLAMA_USE_PREBUILT_UI=OFF \
      -DCMAKE_EXE_LINKER_FLAGS=-Wl,--allow-shlib-undefined && \
    cmake --build build --config Release --target llama-server -j"$(nproc)"
RUN mkdir -p /app && find build -name "*.so*" -exec cp -P {} /app \; && cp build/bin/llama-server /app && \
    "$CC" -O2 -Wall -o /app/tensor-probe /tmp/tensor-probe.c -ldl

FROM ${RUNTIME}
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app /app
COPY entrypoint.sh /app/entrypoint.sh
WORKDIR /app
ENTRYPOINT ["/app/entrypoint.sh"]
