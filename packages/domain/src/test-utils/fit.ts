// A minimal FIT writer for domain tests: a file_id and one record per second with power only,
// after the fuller writer in packages/fit/src/test-utils/encode.ts (not exported by that package).

const FIT_EPOCH_S = 631_065_600;
const CRC_TABLE = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];

function crc(bytes: Iterable<number>): number {
  let c = 0;
  for (const byte of bytes) {
    for (const nibble of [byte & 0x0f, byte >> 4]) {
      const tmp = CRC_TABLE[c & 0x0f] ?? 0;
      c = (c >> 4) & 0x0fff;
      c = c ^ tmp ^ (CRC_TABLE[nibble] ?? 0);
    }
  }
  return c;
}

const le = (value: number, size: number) => Array.from({ length: size }, (_, i) => Math.floor(value / 2 ** (8 * i)) % 256);

/** A FIT activity starting at `startS` (Unix seconds) with one record every `stepS` seconds; `null` = no power in that record. */
export function fitWithPower(startS: number, watts: readonly (number | null)[], stepS = 1): Uint8Array {
  // file_id (global 0): type = activity; record (global 20): timestamp, power.
  const data = [0x40, 0, 0, ...le(0, 2), 1, 0, 1, 0x00, 0x00, 4];
  data.push(0x41, 0, 0, ...le(20, 2), 2, 253, 4, 0x86, 7, 2, 0x84);
  watts.forEach((w, i) => data.push(0x01, ...le(startS + i * stepS - FIT_EPOCH_S, 4), ...le(w ?? 0xffff, 2)));
  const header = [14, 0x20, ...le(2132, 2), ...le(data.length, 4), ...'.FIT'.split('').map((ch) => ch.charCodeAt(0))];
  header.push(...le(crc(header), 2));
  const file = [...header, ...data];
  file.push(...le(crc(file), 2));
  return new Uint8Array(file);
}
