// Recognising the same model on different endpoints, by name. A weak match:
// the user confirms before anything uses it.

const FORMAT = /^(gguf|safetensors|mlx|exl2|exl3|awq|gptq|gptq-int4|gptq-int8|fp8|fp16|f16|bf16|f32|fp32|int4|int8|nf4|\d+bit|i?q\d(_[a-z0-9]+)*|instruct-gguf)$/;

/**
 * A model ID reduced for matching across endpoints: lowercased, without an
 * organisation prefix, a file extension, or quantisation and format words.
 * `deepseek/DeepSeek-4.1-Flash`, `deepseek-4.1-flash-Q4_K_M.gguf` and
 * `DeepSeek-4.1-Flash-FP8` all become `deepseek-4.1-flash`.
 */
export function baseName(modelId: string): string {
  const last = modelId.toLowerCase().split(/[/\\]/).filter(Boolean).at(-1) ?? "";
  const words = last.replace(/\.(gguf|safetensors)$/, "").replace(/:latest$/, "").split(/[-\s]+/).filter(Boolean);
  while (words.length > 1 && FORMAT.test(words.at(-1)!)) words.pop();
  return words.join("-");
}
