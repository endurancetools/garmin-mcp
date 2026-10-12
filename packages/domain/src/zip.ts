import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/**
 * Minimal ZIP reader (stored and deflate entries) for Garmin's "original" FIT
 * download, which is a zip with one .fit file. Reads the central directory, so
 * entries with data descriptors work too.
 */
export function unzip(buf: Uint8Array): ZipEntry[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = Buffer.from(buf.subarray(p + 46, p + 46 + nameLen)).toString('utf8');
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(start, start + compSize);
    if (method !== 0 && method !== 8) throw new Error(`unsupported zip compression method ${method}`);
    out.push({ name, data: method === 0 ? raw : new Uint8Array(inflateRawSync(raw)) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
