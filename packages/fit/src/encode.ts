// A minimal FIT writer: files built field by field from the FIT protocol (header, definition and
// data messages, CRC). `garmin log weight --fat` sends one to Garmin Connect; tests build synthetic
// activity files with it, independent of the parser they test.

type BaseType = 'enum' | 'uint8' | 'uint16' | 'uint32';
type Field = [num: number, type: BaseType, value: number | null | undefined];
export interface FitMessage {
  global: number;
  /** A `null` or `undefined` value is written as the base type's "invalid" (not recorded). */
  fields: Field[];
}

const BASE: Record<BaseType, { id: number; size: number; invalid: number }> = {
  enum: { id: 0x00, size: 1, invalid: 0xff },
  uint8: { id: 0x02, size: 1, invalid: 0xff },
  uint16: { id: 0x84, size: 2, invalid: 0xffff },
  uint32: { id: 0x86, size: 4, invalid: 0xffff_ffff },
};

/** FIT timestamps count seconds from 1989-12-31T00:00:00Z. */
export const FIT_EPOCH_S = 631_065_600;

const CRC_TABLE = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];

function fitCrc(bytes: Iterable<number>): number {
  let crc = 0;
  for (const byte of bytes) {
    for (const nibble of [byte & 0x0f, byte >> 4]) {
      const tmp = CRC_TABLE[crc & 0x0f] ?? 0;
      crc = (crc >> 4) & 0x0fff;
      crc = crc ^ tmp ^ (CRC_TABLE[nibble] ?? 0);
    }
  }
  return crc;
}

const le = (value: number, size: number) => Array.from({ length: size }, (_, i) => Math.floor(value / 2 ** (8 * i)) % 256);

/** A complete FIT file (protocol 2.0, little endian) with the messages in order. */
export function encodeFit(messages: FitMessage[]): Uint8Array {
  const data: number[] = [];
  const locals = new Map<string, number>();
  for (const m of messages) {
    const layout = `${m.global}:${m.fields.map(([n, t]) => `${n}/${t}`).join(',')}`;
    let local = locals.get(layout);
    if (local === undefined) {
      local = locals.size;
      if (local > 15) throw new Error('more than 16 message layouts');
      locals.set(layout, local);
      data.push(0x40 | local, 0, 0, ...le(m.global, 2), m.fields.length);
      for (const [n, t] of m.fields) data.push(n, BASE[t].size, BASE[t].id);
    }
    data.push(local);
    for (const [n, t, v] of m.fields) {
      const value = v ?? BASE[t].invalid;
      // A value out of range would wrap around silently, or be read back as "not recorded".
      if (v != null && (!Number.isInteger(v) || v < 0 || v >= BASE[t].invalid)) throw new RangeError(`FIT field ${n} of message ${m.global}: ${v} does not fit ${t}`);
      data.push(...le(value, BASE[t].size));
    }
  }
  const header = [14, 0x20, ...le(2132, 2), ...le(data.length, 4), ...'.FIT'.split('').map((c) => c.charCodeAt(0))];
  header.push(...le(fitCrc(header), 2));
  const file = [...header, ...data];
  file.push(...le(fitCrc(file), 2));
  return new Uint8Array(file);
}

const fitTime = (at: Date) => Math.floor(at.getTime() / 1000) - FIT_EPOCH_S;

/** FIT `file` type of a weight scale file. */
export const FIT_FILE_WEIGHT = 9;

export interface WeightScaleInput {
  /** When the weight was measured. */
  at: Date;
  /** When the file is written; distinct files keep Garmin from taking two entries as one upload. */
  createdAt: Date;
  weightKg: number;
  /** Body fat in percent of body weight. */
  fatPct?: number;
}

/**
 * A weight scale FIT file with one measurement: `file_id` (type weight), `file_creator`,
 * `device_info` and `weight_scale` (timestamp, weight, percent_fat; both scaled by 100).
 * Garmin Connect takes body composition only as such a file through the upload service.
 */
export function weightScaleFit(m: WeightScaleInput): Uint8Array {
  const at = fitTime(m.at);
  const hundredths = (v: number | undefined) => (v === undefined ? null : Math.round(v * 100));
  return encodeFit([
    { global: 0, fields: [[0, 'enum', FIT_FILE_WEIGHT], [4, 'uint32', fitTime(m.createdAt)]] },
    { global: 49, fields: [[0, 'uint16', null], [1, 'uint8', null]] },
    { global: 23, fields: [[253, 'uint32', at]] },
    {
      global: 30,
      fields: [
        [253, 'uint32', at],
        [0, 'uint16', hundredths(m.weightKg)],
        [1, 'uint16', hundredths(m.fatPct)],
      ],
    },
  ]);
}
