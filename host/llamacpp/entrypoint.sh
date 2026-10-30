#!/bin/sh
# Starts llama-server on a host with a CMP 100-210. Its FP16 tensor cores are
# throttled unless it was unlocked since boot (cmp-unlock.sh), so each start
# asks tensor-probe. Throttled, or if it can't tell: quantized matrix
# multiplies use int8 (dp4a) and flash attention on sm_70 the tile kernel
# (throttled-tensor.patch). Full rate: llama.cpp's own choices, which read
# prompts about twice as fast. The router's model servers inherit the choice.
if [ "$(/app/tensor-probe)" = full ]; then
  echo "tensor-probe: full-rate tensor cores" >&2
else
  echo "tensor-probe: throttled tensor cores; int8 and tile flash attention" >&2
  export GGML_CUDA_VOLTA_MMQ=1 GGML_CUDA_VOLTA_FA_TILE=1
fi
exec /app/llama-server "$@"
