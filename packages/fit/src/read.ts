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

/** The longest activity `readFit` lays out as 1 Hz records; a longer one is an error, not millions of rows. */
export const MAX_SPAN_S = 7 * 24 * 3600;

/** Without a usable `session` message, records further than this from their neighbours are a run of their own. */
export const MAX_GAP_S = 12 * 3600;

/** How far outside the activity window a record or a gear shift may still lie. */
const WINDOW_MARGIN_S = 60;

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
 * The time window an activity's records and gear shifts must fall in. Anything outside it has a
 * broken timestamp (a device clock at the FIT epoch, a jump into the future) and is dropped before
 * the 1 Hz series is laid out, so one such second cannot stretch the series over years.
 *
 * The window is the span of the `session` messages when it is usable: its end is not before its
 * start, it is at most `MAX_SPAN_S` long and at least one record lies in it. Otherwise it is the
 * largest run of records (by count) in which neighbours are at most `MAX_GAP_S` apart. Either way
 * it is widened by `WINDOW_MARGIN_S` on both sides. `null` = nothing to go by, nothing is dropped.
 */
function activityWindow(times: readonly number[], sessions: readonly { start_time?: unknown; timestamp?: unknown; total_elapsed_time?: unknown }[]): { from: number; to: number } | null {
  const widen = (from: number, to: number) => ({ from: from - WINDOW_MARGIN_S, to: to + WINDOW_MARGIN_S });

  const spans = sessions.flatMap((s) => {
    const start = seconds(s.start_time);
    const elapsed = num(s.total_elapsed_time);
    const ends = [seconds(s.timestamp), start !== null && elapsed !== null ? start + Math.ceil(elapsed) : null].filter((t) => t !== null);
    return start === null || ends.length === 0 ? [] : [{ start, end: Math.max(...ends) }];
  });
  if (spans.length > 0) {
    const session = widen(Math.min(...spans.map((s) => s.start)), Math.max(...spans.map((s) => s.end)));
    const usable =
      session.to >= session.from &&
      session.to - session.from <= MAX_SPAN_S + 2 * WINDOW_MARGIN_S &&
      (times.length === 0 || times.some((t) => t >= session.from && t <= session.to));
    if (usable) return session;
  }

  // `times` is sorted: split it where neighbours are more than MAX_GAP_S apart, keep the largest run.
  let best: { from: number; to: number; n: number } | null = null;
  let runStart = 0;
  for (let i = 1; i <= times.length; i++) {
    if (i < times.length && times[i]! - times[i - 1]! <= MAX_GAP_S) continue;
    const n = i - runStart;
    if (best === null || n > best.n) best = { from: times[runStart]!, to: times[i - 1]!, n };
    runStart = i;
  }
  return best && widen(best.from, best.to);
}

/**
 * Decodes a FIT activity file into 1 Hz records from the first to the last recorded second, plus
 * the gear shifts; records and shifts with a timestamp far outside the activity are dropped (see
 * `activityWindow`). Throws on a file that is not FIT, fails its CRC or whose records still span
 * more than `MAX_SPAN_S`.
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

  const allTimes = [...bySecond.keys()].toSorted((a, b) => a - b);
  const window = activityWindow(allTimes, parsed.sessions ?? []);
  const inWindow = (t: number) => window === null || (t >= window.from && t <= window.to);
  const times = allTimes.filter(inWindow);
  const first = times[0];
  const last = times.at(-1);
  if (first !== undefined && last !== undefined && last - first > MAX_SPAN_S) {
    const days = (s: number) => Math.round((s / 86_400) * 10) / 10;
    throw new Error(
      `The records of this FIT file span ${days(last - first)} days, more than the ${days(MAX_SPAN_S)} days an activity is read for; its timestamps are probably broken.`,
    );
  }

  const records: FitRecord[] = [];
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
    if (derailleur === null || t === null || !inWindow(t)) return [];
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
