import FitParser from 'fit-file-parser';

/** One second of an activity. A value the device did not record in that second is `null`. */
export interface FitRecord {
  /** Unix time in seconds; consecutive records are exactly 1 s apart. */
  time_s: number;
  power_w: number | null;
  heart_rate_bpm: number | null;
  /** As the device writes it: rpm on a bike, steps per minute of one foot when running. */
  cadence: number | null;
  speed_m_s: number | null;
  elevation_m: number | null;
}

/** A front or rear shift of electronic gears (Di2, eTap, AXS), with the gears after it. */
export interface FitGearChange {
  time_s: number;
  derailleur: 'front' | 'rear';
  /** Gear position counted from 1 (the smallest chainring, the largest cog); `null` when not recorded. */
  front_gear_num: number | null;
  front_teeth: number | null;
  rear_gear_num: number | null;
  rear_teeth: number | null;
}

export interface FitActivity {
  records: FitRecord[];
  gear_changes: FitGearChange[];
}

/**
 * A second without its own record repeats the previous record (smart recording writes one only
 * when something changes), unless the timer was stopped or the previous record is older than this:
 * then the second is a pause and all its values are `null`.
 */
export const MAX_HOLD_S = 10;

const VALUE_KEYS = ['power_w', 'heart_rate_bpm', 'cadence', 'speed_m_s', 'elevation_m'] as const;
type Values = Pick<FitRecord, (typeof VALUE_KEYS)[number]>;

const EMPTY: Values = { power_w: null, heart_rate_bpm: null, cadence: null, speed_m_s: null, elevation_m: null };
const TIMER_STOPS = new Set(['stop', 'stop_all', 'stop_disable', 'stop_disable_all']);

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round = (v: number | null, digits: number): number | null => (v === null ? null : Math.round(v * 10 ** digits) / 10 ** digits);
const seconds =(d: unknown): number | null => (d instanceof Date && !Number.isNaN(d.getTime()) ? Math.floor(d.getTime() / 1000) : null);

/** A gear position or tooth count; 0 is FIT's "invalid" for these `uint8z` fields. */
const gear = (v: unknown): number | null => {
  const n = num(v);
  return n === null || n === 0 || n === 0xff ? null : n;
};

/**
 * Decodes a FIT activity file into 1 Hz records from the first to the last recorded second, plus
 * the gear shifts. Throws on a file that is not FIT or fails its CRC.
 */
export async function readFit(bytes: Uint8Array): Promise<FitActivity> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  let parsed;
  try {
    parsed = await new FitParser({ force: false, mode: 'list', speedUnit: 'm/s', lengthUnit: 'm' }).parseAsync(buffer);
  } catch (error) {
    // The parser rejects validation failures with a bare string.
    throw error instanceof Error ? error : new Error(`Not a readable FIT file: ${String(error)}`);
  }

  const bySecond = new Map<number, Values>();
  for (const r of parsed.records ?? []) {
    const t = seconds(r.timestamp);
    if (t === null) continue;
    // Several records in one second: the last one wins.
    bySecond.set(t, {
      power_w: num(r.power),
      heart_rate_bpm: num(r.heart_rate),
      cadence: num(r.cadence),
      // FIT resolution: 0.001 m/s and 0.2 m; rounding drops the float noise of scale and offset.
      speed_m_s: round(num(r.enhanced_speed) ?? num(r.speed), 3),
      elevation_m: round(num(r.enhanced_altitude) ?? num(r.altitude), 1),
    });
  }

  const events = parsed.events ?? [];
  const timer = events
    .filter((e) => e.event === 'timer')
    .flatMap((e) => {
      const t = seconds(e.timestamp);
      return t === null ? [] : [{ t, running: !TIMER_STOPS.has(String(e.event_type)) }];
    })
    .toSorted((a, b) => a.t - b.t);

  const records: FitRecord[] = [];
  const times = [...bySecond.keys()].toSorted((a, b) => a - b);
  const first = times[0];
  const last = times.at(-1);
  if (first !== undefined && last !== undefined) {
    let held: { t: number; values: Values } | null = null;
    let running = true;
    let next = 0;
    for (let t = first; t <= last; t++) {
      for (let event = timer[next]; event !== undefined && event.t <= t; event = timer[++next]) running = event.running;
      const own = bySecond.get(t);
      if (own) held = { t, values: own };
      const values = own ?? (held && running && t - held.t <= MAX_HOLD_S ? held.values : EMPTY);
      records.push({ time_s: t, ...values });
    }
  }

  const gear_changes: FitGearChange[] = events.flatMap((e) => {
    const derailleur = e.event === 'front_gear_change' ? 'front' : e.event === 'rear_gear_change' ? 'rear' : null;
    const t = seconds(e.timestamp);
    if (derailleur === null || t === null) return [];
    // Devices write `data` (gear_change_data); its components are the four gear fields.
    const data = num(e.data);
    const byte = (i: number) => (data === null ? null : Math.floor(data / 2 ** (8 * i)) % 256);
    return [
      {
        time_s: t,
        derailleur,
        front_gear_num: gear(e.front_gear_num ?? byte(2)),
        front_teeth: gear(e.front_gear ?? byte(3)),
        rear_gear_num: gear(e.rear_gear_num ?? byte(0)),
        rear_teeth: gear(e.rear_gear ?? byte(1)),
      },
    ];
  });
  gear_changes.sort((a, b) => a.time_s - b.time_s);

  return { records, gear_changes };
}
