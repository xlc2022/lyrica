import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { amdMonitor, gfxName } from "../src/gpus.ts";

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

  const GIB = 1024 ** 3;
  /** A KFD GPU node and its PCI device's memory files. */
  function gpu(sys: string, node: number, bus: number, gfx: number, mem: { vram: number; gtt?: number }, name: string) {
    const nodes = join(sys, "class/kfd/kfd/topology/nodes");
    file(join(nodes, `${node}/gpu_id`), String(1000 + node));
    file(join(nodes, `${node}/properties`), `gfx_target_version ${gfx}\nlocation_id ${bus << 8}\ndomain 0`);
    const dev = join(sys, `bus/pci/devices/0000:${bus.toString(16).padStart(2, "0")}:00.0`);
    file(join(dev, "mem_info_vram_total"), String(mem.vram));
    file(join(dev, "mem_info_vram_used"), String(GIB / 4));
    file(join(dev, "mem_info_gtt_total"), String(mem.gtt ?? 0));
    file(join(dev, "mem_info_gtt_used"), String(GIB));
    file(join(dev, "product_name"), name);
  }

  it("counts an integrated GPU's shared memory (GTT), and only an integrated GPU's", async () => {
    const sys = mkdtempSync(join(tmpdir(), "lyrica-sys-"));
    gpu(sys, 1, 0xc5, 110003, { vram: 2 * GIB, gtt: 30 * GIB }, "Radeon 780M");
    gpu(sys, 2, 0x03, 90006, { vram: 16 * GIB, gtt: 30 * GIB }, "Radeon VII");
    expect(await amdMonitor(sys).read()).toEqual([
      { index: 0, name: "Radeon 780M", vendor: "amd", integrated: true, total: 32 * GIB, used: GIB / 4 + GIB },
      { index: 1, name: "Radeon VII", vendor: "amd", total: 16 * GIB, used: GIB / 4 },
    ]);
    // For Vulkan, numbered by PCI address instead.
    expect((await amdMonitor(sys, { order: "pci" }).read()).map((g) => g.name)).toEqual(["Radeon VII", "Radeon 780M"]);
  });

  it("names gfx targets from KFD's version numbers", () => {
    expect([110003, 90012, 90006, 100306, 120001].map(gfxName)).toEqual(["gfx1103", "gfx90c", "gfx906", "gfx1036", "gfx1201"]);
  });
});
