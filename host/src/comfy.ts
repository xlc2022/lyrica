// ComfyUI, reached only from host-api. Results come back over its websocket
// (SaveImageWebsocket), nothing is saved, and its history is cleared after
// every job. One job at a time, so uploads can't mix.
import { randomUUID } from "node:crypto";
import { HostError } from "./http.ts";
import type { Backend } from "./backends.ts";

const unavailable = () => new HostError(503, "unavailable", "ComfyUI didn't answer.");

export class Comfy implements Backend {
  private readonly base: string;
  private readonly timeoutMs: number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(base: string, timeoutMs = 30 * 60_000) {
    this.base = base;
    this.timeoutMs = timeoutMs;
  }

  /** Runs jobs one after another. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private async upload(name: string, png: Buffer): Promise<string> {
    const form = new FormData();
    form.append("image", new Blob([png]), name);
    form.append("overwrite", "true");
    const res = await fetch(`${this.base}/upload/image`, { method: "POST", body: form }).catch(() => {
      throw unavailable();
    });
    if (!res.ok) throw new HostError(400, "invalid", "ComfyUI couldn't read that image.");
    return ((await res.json()) as { name: string }).name;
  }

  /**
   * Uploads the images (each under a fixed name, overwriting the last job's),
   * runs the workflow made by `build` from their names, and returns the PNGs.
   */
  run(images: Record<string, Buffer>, build: (names: Record<string, string>) => object): Promise<Buffer[]> {
    return this.serial(async () => {
      const names: Record<string, string> = {};
      for (const [key, data] of Object.entries(images)) names[key] = await this.upload(`lyrica-${key}.png`, data);
      const prompt = build(names);
      const clientId = randomUUID();
      const ws = new WebSocket(`${this.base.replace(/^http/, "ws")}/ws?clientId=${clientId}`);
      ws.binaryType = "arraybuffer";
      const pngs: Buffer[] = [];
      let promptId: string | null = null;
      try {
        await new Promise<void>((resolve, reject) => {
          ws.onopen = () => resolve();
          ws.onerror = () => reject(unavailable());
        });
        const done = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new HostError(503, "busy", "The image took too long.")), this.timeoutMs);
          ws.onmessage = (e) => {
            if (e.data instanceof ArrayBuffer) {
              // 4 bytes event type, 4 bytes image format (2 = PNG), then the image.
              const view = Buffer.from(e.data);
              if (view.length > 8 && view.readUInt32BE(0) === 1 && view.readUInt32BE(4) === 2) pngs.push(view.subarray(8));
              return;
            }
            const msg = JSON.parse(String(e.data));
            // Only this client's messages arrive here; skip any for another prompt.
            if (promptId && msg.data?.prompt_id && msg.data.prompt_id !== promptId) return;
            if (msg.type === "execution_error") {
              clearTimeout(timer);
              reject(new HostError(503, "unavailable", "ComfyUI failed to make the image."));
            } else if (msg.type === "executing" && msg.data.node === null) {
              clearTimeout(timer);
              resolve();
            }
          };
          ws.onclose = () => reject(unavailable());
        });
        const res = await fetch(`${this.base}/prompt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt, client_id: clientId }),
        }).catch(() => {
          throw unavailable();
        });
        if (!res.ok) throw new HostError(503, "unavailable", "ComfyUI refused the workflow.");
        promptId = ((await res.json()) as { prompt_id: string }).prompt_id;
        await done;
        return pngs;
      } finally {
        ws.onclose = null;
        ws.close();
        // No history of what was asked.
        await fetch(`${this.base}/history`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clear: true }) }).catch(() => {});
      }
    });
  }

  /** Frees ComfyUI's GPU memory. */
  async free(): Promise<void> {
    await fetch(`${this.base}/free`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
    }).catch(() => {});
  }

  // As a scheduler backend: ComfyUI loads parts during the job, and /free unloads them.
  async load(): Promise<void> {}
  async unload(): Promise<void> {
    await this.free();
  }
  url(): string {
    return this.base;
  }
  async reset(): Promise<void> {
    await this.free();
  }
  async sleep(): Promise<void> {
    await this.free();
  }
  async wake(): Promise<void> {}
}

/** Width and height of a PNG, JPEG or WebP, from its header. */
export function imageSize(b: Buffer): { width: number; height: number; type: "png" | "jpeg" | "webp" } | null {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), type: "png" };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5), type: "jpeg" };
      }
      i += 2 + len;
    }
    return null;
  }
  if (b.length > 30 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    const kind = b.toString("latin1", 12, 16);
    if (kind === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3), type: "webp" };
    if (kind === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, type: "webp" };
    if (kind === "VP8L") {
      const bits = b.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, type: "webp" };
    }
  }
  return null;
}
