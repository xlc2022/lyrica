import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { amdMonitor } from "../src/gpus.ts";

function file(path: string, text: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

describe("AMD GPUs", () => {
  it("are numbered as ROCm numbers them, skipping a GPU ROCm doesn't use", async () => {
    const sys = mkdtempSync(join(tmpdir(), "lyrica-sys-"));
    const nodes = join(sys, "class/kfd/kfd/topology/nodes");
    file(join(nodes, "0/gpu_id"), "0");
    file(join(nodes, "1/gpu_id"), "4242");
    file(join(nodes, "1/properties"), `simd_count 192\nlocation_id ${(0x03 << 8) | 0}\ndomain 0`);
    const dgpu = join(sys, "bus/pci/devices/0000:03:00.0");
    file(join(dgpu, "mem_info_vram_total"), String(24 * 1024 ** 3));
    file(join(dgpu, "mem_info_vram_used"), String(1024 ** 3));
    file(join(dgpu, "product_name"), "Radeon RX 7900 XTX");
    // An integrated GPU that DRM lists first, but ROCm doesn't number.
    file(join(sys, "class/drm/card0/device/mem_info_vram_total"), String(512 * 1024 ** 2));
    file(join(sys, "class/drm/card0/device/mem_info_vram_used"), "0");
    expect(await amdMonitor(sys).read()).toEqual([
      { index: 0, name: "Radeon RX 7900 XTX", vendor: "amd", total: 24 * 1024 ** 3, used: 1024 ** 3 },
    ]);
  });
});
