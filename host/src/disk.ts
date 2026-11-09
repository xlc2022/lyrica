import { readFileSync, statSync } from "node:fs";

const SECTOR = 512;
/** A whole disk, not a partition or a stacked device: what the fallback sums. */
const WHOLE_DISK = /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;

/**
 * Bytes read so far from the block device that holds `folder`, as
 * `/proc/diskstats` counts them: a running total since boot, so a load's
 * progress is the difference from when it began. When the folder's device
 * isn't listed (a multi-device filesystem reports a device of its own), the
 * sum over every whole disk stands in. Null where nothing can be read, as on
 * a host without `/proc/diskstats`.
 */
export function diskReads(folder: string, diskstats = "/proc/diskstats"): (() => number) | null {
  let device: { major: bigint; minor: bigint } | null = null;
  try {
    const dev = statSync(folder, { bigint: true }).dev;
    // Linux's dev_t: major in bits 8-19 and 32-43, minor in bits 0-7 and 20-31.
    device = { major: ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn), minor: (dev & 0xffn) | ((dev >> 12n) & ~0xffn) };
  } catch {
    device = null;
  }
  const read = (): number => {
    const lines = readFileSync(diskstats, "utf8").split("\n");
    let own: number | null = null;
    let all = 0;
    for (const line of lines) {
      const f = line.trim().split(/\s+/);
      if (f.length < 6) continue;
      const sectors = Number(f[5]) * SECTOR;
      if (device && BigInt(f[0]!) === device.major && BigInt(f[1]!) === device.minor) own = sectors;
      if (WHOLE_DISK.test(f[2]!)) all += sectors;
    }
    return own ?? all;
  };
  try {
    read();
  } catch {
    return null;
  }
  return read;
}
