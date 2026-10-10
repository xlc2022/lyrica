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

/** AMD GPUs from /sys/class/drm, in card order (the order ROCm numbers them). */
export function amdMonitor(drm = "/sys/class/drm"): GpuMonitor {
  return {
    async read() {
      const cards = readdirSync(drm)
        .filter((c) => /^card\d+$/.test(c) && existsSync(join(drm, c, "device", "mem_info_vram_total")))
        .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
      return cards.map((card, index) => {
        const dev = join(drm, card, "device");
        const read = (f: string) => readFileSync(join(dev, f), "utf8").trim();
        let name = "AMD GPU";
        try {
          name = read("product_name") || name;
        } catch {}
        return { index, name, vendor: "amd" as const, total: Number(read("mem_info_vram_total")), used: Number(read("mem_info_vram_used")) };
      });
    },
  };
}

export const noGpus: GpuMonitor = { read: async () => [] };
