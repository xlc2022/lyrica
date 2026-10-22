// What each GPU has and uses, read without touching the Docker socket: NVML's
// nvidia-smi (host-api gets NVIDIA's "utility" capability only) or AMD's sysfs.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";

export interface Gpu {
  index: number;
  name: string;
  /** Its PCI vendor and device ID, as `10de:1df4`: a card that names itself as another model still shows what it is. */
  pciId?: string;
  vendor: "nvidia" | "amd";
  /** An integrated GPU (an APU): its memory is shared with the system. */
  integrated?: boolean;
  /** All the memory it can use: for an integrated GPU, its carve-out and shared memory (GTT). */
  total: number;
  used: number;
  /** An integrated GPU's BIOS carve-out alone: all a server that can't use shared memory sees. */
  carveOut?: { total: number; used: number };
}

export interface GpuMonitor {
  read(): Promise<Gpu[]>;
}

const MIB = 1024 * 1024;

/** nvidia-smi's pci.device_id (0x1DF410DE: device, then vendor) as `10de:1df4`. */
export function pciIdOf(id: string | undefined): { pciId?: string } {
  const m = /^0x([0-9a-f]{4})([0-9a-f]{4})$/i.exec(id ?? "");
  return m ? { pciId: `${m[2]}:${m[1]}`.toLowerCase() } : {};
}

export const nvidiaMonitor: GpuMonitor = {
  async read() {
    const { stdout } = await promisify(execFile)("nvidia-smi", ["--query-gpu=index,name,memory.total,memory.used,pci.device_id", "--format=csv,noheader,nounits"], { timeout: 10_000 });
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [index, name, total, used, id] = line.split(",").map((s) => s.trim());
        return { index: Number(index), name: name ?? "NVIDIA GPU", ...pciIdOf(id), vendor: "nvidia" as const, total: Number(total) * MIB, used: Number(used) * MIB };
      });
  },
};

/**
 * AMD integrated GPUs (APUs), by their gfx target: Raven, Picasso, Renoir,
 * Van Gogh, Rembrandt, Raphael, Mendocino, Phoenix and Hawk Point (780M),
 * Strix and Strix Halo, Krackan.
 */
const AMD_APUS = new Set(["gfx902", "gfx909", "gfx90c", "gfx1033", "gfx1035", "gfx1036", "gfx1037", "gfx1103", "gfx1150", "gfx1151", "gfx1152", "gfx1153"]);

/** KFD's gfx_target_version (e.g. 110003) as a gfx name (gfx1103). */
export function gfxName(version: number): string {
  const major = Math.floor(version / 10000);
  const minor = Math.floor(version / 100) % 100;
  const step = version % 100;
  return `gfx${major}${minor.toString(16)}${step.toString(16)}`;
}

/**
 * AMD GPUs. With ROCm they are numbered as ROCm numbers them: the GPU nodes
 * of the KFD topology, in order, so an integrated GPU that ROCm skips can't
 * shift the numbers. With Vulkan (`order: "pci"`) they are numbered by PCI
 * address, the order the Vulkan container is told to use. Without a KFD
 * topology, DRM's cards are used: by card number, or by PCI address for
 * Vulkan. Without KFD, integrated GPUs can't be told apart.
 *
 * An integrated GPU's VRAM is only the BIOS carve-out; it can also use shared
 * system memory (GTT). `total` counts both, and `carveOut` the carve-out
 * alone, for servers that can't use shared memory.
 */
export function amdMonitor(sys = "/sys", opts: { order?: "kfd" | "pci" } = {}): GpuMonitor {
  const read = (path: string) => readFileSync(path, "utf8").trim();
  const devices = (): { dev: string; gfx: string | null }[] => {
    const nodes = join(sys, "class/kfd/kfd/topology/nodes");
    if (existsSync(nodes)) {
      const out: { dev: string; gfx: string | null; addr: string }[] = [];
      for (const n of readdirSync(nodes).sort((a, b) => Number(a) - Number(b))) {
        try {
          if (read(join(nodes, n, "gpu_id")) === "0") continue; // a CPU node
          const props = Object.fromEntries(read(join(nodes, n, "properties")).split("\n").map((l) => l.split(/\s+/) as [string, string]));
          const loc = Number(props.location_id);
          const addr = `${Number(props.domain ?? 0).toString(16).padStart(4, "0")}:${(loc >> 8).toString(16).padStart(2, "0")}:${((loc >> 3) & 0x1f).toString(16).padStart(2, "0")}.${loc & 7}`;
          const version = Number(props.gfx_target_version);
          out.push({ dev: join(sys, "bus/pci/devices", addr), gfx: version ? gfxName(version) : null, addr });
        } catch {}
      }
      if (opts.order === "pci") out.sort((a, b) => (a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0));
      if (out.length) return out;
    }
    const drm = join(sys, "class/drm");
    const cards = readdirSync(drm)
      .filter((c) => /^card\d+$/.test(c))
      .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)))
      .map((c) => ({ dev: join(drm, c, "device"), gfx: null }));
    if (opts.order !== "pci") return cards;
    // The device link ends in the PCI address.
    const pci = (dev: string) => {
      try {
        return basename(realpathSync(dev));
      } catch {
        return dev;
      }
    };
    return cards.sort((a, b) => (pci(a.dev) < pci(b.dev) ? -1 : pci(a.dev) > pci(b.dev) ? 1 : 0));
  };
  const num = (path: string) => {
    try {
      return Number(read(path)) || 0;
    } catch {
      return 0;
    }
  };
  return {
    async read() {
      return devices()
        .filter(({ dev }) => existsSync(join(dev, "mem_info_vram_total")))
        .map(({ dev, gfx }, index) => {
          let name = "AMD GPU";
          try {
            name = read(join(dev, "product_name")) || name;
          } catch {}
          const integrated = gfx !== null && AMD_APUS.has(gfx);
          let pciId: string | undefined;
          try {
            pciId = `${read(join(dev, "vendor"))}:${read(join(dev, "device"))}`.replace(/0x/g, "").toLowerCase();
          } catch {}
          const vram = { total: num(join(dev, "mem_info_vram_total")), used: num(join(dev, "mem_info_vram_used")) };
          if (!integrated) return { index, name, ...(pciId ? { pciId } : {}), vendor: "amd" as const, ...vram };
          return {
            index, name, ...(pciId ? { pciId } : {}), vendor: "amd" as const, integrated: true,
            total: vram.total + num(join(dev, "mem_info_gtt_total")),
            used: vram.used + num(join(dev, "mem_info_gtt_used")),
            carveOut: vram,
          };
        });
    },
  };
}

export const noGpus: GpuMonitor = { read: async () => [] };
