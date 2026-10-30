// The machine's CPU and memory, for the status. llama.cpp picks its own CPU
// threads, one per physical core, so nothing here sets them.
import { cpus, totalmem } from "node:os";
import { readFileSync } from "node:fs";

export interface Machine {
  /** The CPU's model name, without its trademarks and core count; null when the kernel doesn't say. */
  cpu: string | null;
  /** Physical cores, counted from /proc/cpuinfo; the threads where it doesn't say. */
  cores: number;
  /** Logical CPUs (hardware threads). */
  threads: number;
  /** Bytes of memory. */
  memory: number;
}

/** "AMD Ryzen 7 7800X3D 8-Core Processor" as "AMD Ryzen 7 7800X3D", "Intel(R) Core(TM) i9-13900K" as "Intel Core i9-13900K". */
export function cpuName(model: string | undefined): string | null {
  const name = (model ?? "")
    .replace(/\((R|TM|C)\)/gi, "")
    .replace(/\s+@\s*[\d.]+\s*GHz/i, "")
    .replace(/\s+\d+-Core( Processor)?$/i, "")
    .replace(/\s(CPU|Processor)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return name || null;
}

/** Physical cores in /proc/cpuinfo: distinct (physical id, core id) pairs, or null where it lists none (most ARM kernels). */
export function coresOf(cpuinfo: string): number | null {
  const seen = new Set<string>();
  for (const block of cpuinfo.split(/\n\s*\n/)) {
    const core = /^core id\s*:\s*(\d+)/m.exec(block)?.[1];
    if (core !== undefined) seen.add(`${/^physical id\s*:\s*(\d+)/m.exec(block)?.[1] ?? 0}:${core}`);
  }
  return seen.size || null;
}

/** Read once at start: none of it changes while the host runs. */
export function readMachine(cpuinfo = readOr("/proc/cpuinfo")): Machine {
  const list = cpus();
  return { cpu: cpuName(list[0]?.model), cores: coresOf(cpuinfo) ?? list.length, threads: list.length, memory: totalmem() };
}

function readOr(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
