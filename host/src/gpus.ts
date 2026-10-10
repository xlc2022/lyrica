// What each GPU has and uses, read without touching the Docker socket: NVML's
// nvidia-smi (host-api gets NVIDIA's "utility" capability only) or AMD's sysfs.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

export interface Gpu {
  index: number;
  name: string;
  vendor: "nvidia" | "amd";
  total: number;
  used: number;
}

export interface GpuMonitor {
  read(): Promise<Gpu[]>;
}

const MIB = 1024 * 1024;

export const nvidiaMonitor: GpuMonitor = {
  async read() {
    const { stdout } = await promisify(execFile)("nvidia-smi", ["--query-gpu=index,name,memory.total,memory.used", "--format=csv,noheader,nounits"], { timeout: 10_000 });
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [index, name, total, used] = line.split(",").map((s) => s.trim());
        return { index: Number(index), name: name ?? "NVIDIA GPU", vendor: "nvidia" as const, total: Number(total) * MIB, used: Number(used) * MIB };
      });
  },
};

/**
 * AMD GPUs, numbered as ROCm numbers them: the GPU nodes of the KFD
 * topology, in order. Each node's PCI address leads to its memory readings
 * in sysfs, so an integrated GPU that ROCm skips can't shift the numbers.
 * Without a KFD topology, falls back to DRM card order.
 */
export function amdMonitor(sys = "/sys"): GpuMonitor {
  const read = (path: string) => readFileSync(path, "utf8").trim();
  const devices = (): string[] => {
    const nodes = join(sys, "class/kfd/kfd/topology/nodes");
    if (existsSync(nodes)) {
      const out: string[] = [];
      for (const n of readdirSync(nodes).sort((a, b) => Number(a) - Number(b))) {
        try {
          if (read(join(nodes, n, "gpu_id")) === "0") continue; // a CPU node
          const props = Object.fromEntries(read(join(nodes, n, "properties")).split("\n").map((l) => l.split(/\s+/) as [string, string]));
          const loc = Number(props.location_id);
          const addr = `${Number(props.domain ?? 0).toString(16).padStart(4, "0")}:${(loc >> 8).toString(16).padStart(2, "0")}:${((loc >> 3) & 0x1f).toString(16).padStart(2, "0")}.${loc & 7}`;
          out.push(join(sys, "bus/pci/devices", addr));
        } catch {}
      }
      if (out.length) return out;
    }
    const drm = join(sys, "class/drm");
    return readdirSync(drm)
      .filter((c) => /^card\d+$/.test(c))
      .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)))
      .map((c) => join(drm, c, "device"));
  };
  return {
    async read() {
      return devices()
        .filter((dev) => existsSync(join(dev, "mem_info_vram_total")))
        .map((dev, index) => {
          let name = "AMD GPU";
          try {
            name = read(join(dev, "product_name")) || name;
          } catch {}
          return { index, name, vendor: "amd" as const, total: Number(read(join(dev, "mem_info_vram_total"))), used: Number(read(join(dev, "mem_info_vram_used"))) };
        });
    },
  };
}

export const noGpus: GpuMonitor = { read: async () => [] };
