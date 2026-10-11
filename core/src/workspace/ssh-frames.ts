// The pipe between SshTarget and its SSH helper. Each frame is two 4-byte
// lengths, a JSON header and a binary body (file contents, command output, a
// key). Shared by both ends, so it imports nothing.

export interface Frame {
  head: Record<string, unknown>;
  body: Buffer;
}

/** Larger frames end the connection: a broken helper can't make lyricad buffer without limit. */
export const MAX_HEAD = 64 * 1024;
export const MAX_BODY = 64 * 1024 * 1024;

export function encode(head: object, body: Buffer = Buffer.alloc(0)): Buffer {
  const json = Buffer.from(JSON.stringify(head));
  const lengths = Buffer.alloc(8);
  lengths.writeUInt32BE(json.length, 0);
  lengths.writeUInt32BE(body.length, 4);
  return Buffer.concat([lengths, json, body]);
}

/** Feeds chunks in, calls `onFrame` per whole frame. Throws on a frame it won't take. */
export function decoder(onFrame: (frame: Frame) => void): (chunk: Buffer) => void {
  let chunks: Buffer[] = [];
  let size = 0;
  return (chunk) => {
    chunks.push(chunk);
    size += chunk.length;
    while (size >= 8) {
      if (chunks[0]!.length < 8) chunks = [Buffer.concat(chunks)];
      const headLen = chunks[0]!.readUInt32BE(0);
      const bodyLen = chunks[0]!.readUInt32BE(4);
      if (headLen > MAX_HEAD || bodyLen > MAX_BODY) throw new Error("ssh helper sent an oversized frame");
      if (size < 8 + headLen + bodyLen) return;
      let buf = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
      const head = JSON.parse(buf.subarray(8, 8 + headLen).toString()) as unknown;
      if (!head || typeof head !== "object" || Array.isArray(head)) throw new Error("ssh helper sent a malformed frame");
      const body = Buffer.from(buf.subarray(8 + headLen, 8 + headLen + bodyLen));
      buf = buf.subarray(8 + headLen + bodyLen);
      chunks = buf.length ? [buf] : [];
      size = buf.length;
      onFrame({ head: head as Record<string, unknown>, body });
    }
  };
}
