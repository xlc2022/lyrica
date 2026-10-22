# stable-diffusion.cpp's sd-server, for images on a CMP 100-210
# (compose.sdcpp.yaml). Built with GGML_CUDA_FORCE_MMQ so quantized matrix
# multiplies use int8 (dp4a) instead of the card's throttled FP16 tensor
# cores, without its web UI, WebP or WebM. gate.sh runs it for the recipe
# host-api asks for.
ARG DEVEL=nvidia/cuda:12.8.1-devel-ubuntu24.04@sha256:520292dbb4f755fd360766059e62956e9379485d9e073bbd2f6e3c20c270ed66
ARG RUNTIME=nvidia/cuda:12.8.1-runtime-ubuntu24.04@sha256:ebef3c171eeef0298e4eb2e4be843105edf3b8b0ac45e0b43acee358e8046867

FROM ${DEVEL} AS build
ARG COMMIT=a77d3623180b2bc1886f3dd04c0aa04156a987ef
# The host's GPUs' compute capabilities, as install.sh found them (e.g. 70-real).
ARG CUDA_ARCHS
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git init -q && git remote add origin https://github.com/leejet/stable-diffusion.cpp && \
    git fetch -q --depth 1 origin "$COMMIT" && git checkout -q FETCH_HEAD && \
    git submodule update -q --init --depth 1 ggml
RUN test -n "$CUDA_ARCHS" && \
    cmake -B build -DSD_CUDA=ON -DGGML_CUDA_FORCE_MMQ=ON -DCMAKE_CUDA_ARCHITECTURES="$CUDA_ARCHS" -DGGML_NATIVE=OFF \
      -DSD_SERVER_BUILD_FRONTEND=OFF -DSD_WEBP=OFF -DSD_WEBM=OFF && \
    cmake --build build --config Release --target sd-server -j"$(nproc)"

FROM ${RUNTIME}
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 jq && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/build/bin/sd-server /app/sd-server
COPY gate.sh /app/gate.sh
ENTRYPOINT ["/app/gate.sh"]
