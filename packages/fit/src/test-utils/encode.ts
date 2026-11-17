// A minimal FIT writer for tests: synthetic activity files built field by field from the FIT
// protocol (header, definition and data messages, CRC), independent of the parser under test.

type BaseType = 'enum' | 'uint8' | 'uint16' | 'uint32';
type Field = [num: number, type: BaseType, value: number | null | undefined];
export interface FitMessage {
  global: number;
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

export function fitCrc(bytes: Iterable<number>): number {
  let crc = 0;
  for (const byte of bytes) {
    for (const nibble of [byte & 0x0f, byte >> 4]) {
      const tmp = CRC_TABLE[crc & 0x0f]!;
      crc = (crc >> 4) & 0x0fff;
      crc = crc ^ tmp ^ CRC_TABLE[nibble]!;
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
    for (const [, t, v] of m.fields) data.push(...le(v ?? BASE[t].invalid, BASE[t].size));
  }
  const header = [14, 0x20, ...le(2132, 2), ...le(data.length, 4), ...'.FIT'.split('').map((c) => c.charCodeAt(0))];
  header.push(...le(fitCrc(header), 2));
  const file = [...header, ...data];
  file.push(...le(fitCrc(file), 2));
  return new Uint8Array(file);
}

export const fileId = (): FitMessage => ({ global: 0, fields: [[0, 'enum', 4]] });

export interface RecordInput {
  time_s: number;
  power_w?: number | null;
  heart_rate_bpm?: number | null;
  cadence?: number | null;
  speed_m_s?: number | null;
  elevation_m?: number | null;
  /** `enhanced_speed`/`enhanced_altitude` (32 bit) instead of `speed`/`altitude`. */
  enhanced?: boolean;
}

export function record(r: RecordInput): FitMessage {
  const speed = r.speed_m_s == null ? null : Math.round(r.speed_m_s * 1000);
  const altitude = r.elevation_m == null ? null : Math.round((r.elevation_m + 500) * 5);
  return {
    global: 20,
    fields: [
      [253, 'uint32', r.time_s - FIT_EPOCH_S],
      [7, 'uint16', r.power_w],
      [3, 'uint8', r.heart_rate_bpm],
      [4, 'uint8', r.cadence],
      r.enhanced ? [73, 'uint32', speed] : [6, 'uint16', speed],
      r.enhanced ? [78, 'uint32', altitude] : [2, 'uint16', altitude],
    ],
  };
}

/** Timer start (event_type 0) or stop_all (4). */
export const timer = (time_s: number, running: boolean): FitMessage => ({
  global: 21,
  fields: [
    [253, 'uint32', time_s - FIT_EPOCH_S],
    [0, 'enum', 0],
    [1, 'enum', running ? 0 : 4],
  ],
});

/** Event 42/43 (front/rear gear change), event_type marker, `data` = gear_change_data. */
export function gearChange(
  time_s: number,
  derailleur: 'front' | 'rear',
  g: { front_gear_num: number; front_teeth: number; rear_gear_num: number; rear_teeth: number },
): FitMessage {
  const data = g.rear_gear_num + g.rear_teeth * 2 ** 8 + g.front_gear_num * 2 ** 16 + g.front_teeth * 2 ** 24;
  return {
    global: 21,
    fields: [
      [253, 'uint32', time_s - FIT_EPOCH_S],
      [0, 'enum', derailleur === 'front' ? 42 : 43],
      [1, 'enum', 3],
      [3, 'uint32', data],
    ],
  };
}
