// Reads a GGUF file's metadata (the key-value header), never its tensors.
import { closeSync, openSync, readSync } from "node:fs";

export type GgufValue = string | number | bigint | boolean | GgufValue[] | null;

class Reader {
  private buf = Buffer.alloc(0);
  private pos = 0; // in buf
  private filePos = 0;
  private readonly fd: number;

  constructor(fd: number) {
    this.fd = fd;
  }

  private need(n: number): void {
    if (this.buf.length - this.pos >= n) return;
    const rest = this.buf.subarray(this.pos);
    const chunk = Buffer.alloc(Math.max(n - rest.length, 1 << 20));
    const got = readSync(this.fd, chunk, 0, chunk.length, this.filePos);
    this.filePos += got;
    this.buf = Buffer.concat([rest, chunk.subarray(0, got)]);
    this.pos = 0;
    if (this.buf.length < n) throw new Error("GGUF header ends early");
  }

  bytes(n: number): Buffer {
    this.need(n);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  u32 = () => this.bytes(4).readUInt32LE();
  u64 = () => this.bytes(8).readBigUInt64LE();
  string = () => {
    const len = Number(this.u64());
    if (len > 64 << 20) throw new Error("GGUF string too long");
    return this.bytes(len).toString("utf8");
  };
}

/** Reads one value; arrays longer than `keepArrays` are skipped (returned as null). */
function value(r: Reader, type: number, keepArrays: number): GgufValue {
  switch (type) {
    case 0: return r.bytes(1).readUInt8();
    case 1: return r.bytes(1).readInt8();
    case 2: return r.bytes(2).readUInt16LE();
    case 3: return r.bytes(2).readInt16LE();
    case 4: return r.u32();
    case 5: return r.bytes(4).readInt32LE();
    case 6: return r.bytes(4).readFloatLE();
    case 7: return r.bytes(1).readUInt8() !== 0;
    case 8: return r.string();
    case 9: {
      const itemType = r.u32();
      const count = Number(r.u64());
      const items: GgufValue[] = [];
      for (let i = 0; i < count; i++) {
        const v = value(r, itemType, keepArrays);
        if (count <= keepArrays) items.push(v);
      }
      return count <= keepArrays ? items : null;
    }
    case 10: return r.u64();
    case 11: return r.bytes(8).readBigInt64LE();
    case 12: return r.bytes(8).readDoubleLE();
    default: throw new Error(`unknown GGUF value type ${type}`);
  }
}

/** The metadata of a GGUF file. Large arrays (the tokenizer's vocabulary) are left out. */
export function readGguf(path: string): Record<string, GgufValue> {
  const fd = openSync(path, "r");
  try {
    const r = new Reader(fd);
    if (r.bytes(4).toString("latin1") !== "GGUF") throw new Error("not a GGUF file");
    const version = r.u32();
    if (version < 2 || version > 3) throw new Error(`unsupported GGUF version ${version}`);
    r.u64(); // tensor count
    const count = Number(r.u64());
    const meta: Record<string, GgufValue> = {};
    for (let i = 0; i < count; i++) {
      const key = r.string();
      meta[key] = value(r, r.u32(), 64);
    }
    return meta;
  } finally {
    closeSync(fd);
  }
}

/** Writes a GGUF header with the given metadata and no tensors: for tests and fakes. */
export function ggufBytes(meta: Record<string, string | number | boolean>): Buffer {
  const parts: Buffer[] = [Buffer.from("GGUF"), u32(3), u64(0), u64(Object.keys(meta).length)];
  for (const [k, v] of Object.entries(meta)) {
    parts.push(str(k));
    if (typeof v === "string") parts.push(u32(8), str(v));
    else if (typeof v === "boolean") parts.push(u32(7), Buffer.from([v ? 1 : 0]));
    else if (Number.isInteger(v)) parts.push(u32(4), u32(v));
    else { const b = Buffer.alloc(4); b.writeFloatLE(v); parts.push(u32(6), b); }
  }
  return Buffer.concat(parts);
}
function u32(n: number) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function u64(n: number) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }
function str(s: string) { const b = Buffer.from(s, "utf8"); return Buffer.concat([u64(b.length), b]); }
