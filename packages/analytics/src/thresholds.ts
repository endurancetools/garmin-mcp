import { addDays, dateIn, type IsoDate } from 'garmin-mcp-config';
import { round } from 'garmin-mcp-domain';
import type { NewThreshold, Store, ThresholdParam, ThresholdRow } from 'garmin-mcp-store';
import type { SportGroup } from './sport.js';

/** Used when the history has neither an LTHR nor an HRmax (bpm). */
export const DEFAULT_LTHR = 170;
/** LTHR estimate without an LTHR row: this share of HRmax (rounded). */
export const LTHR_FROM_HRMAX = 0.89;
/** Used when there is neither a rolling resting HR nor an `rhr` row (bpm). */
export const DEFAULT_RHR = 50;
/** LT1 approximation: this share of the sport's own LTHR, or of the running LTHR without an `lt1_hr` row. */
export const LT1_FROM_LTHR = 0.9;
/** Cycling LT1 without an `lthr_bike` row sits this many bpm below the running one. */
export const BIKE_LT1_OFFSET = 7;
/** Rolling resting HR: mean over the days [D − 28, D − 1] … */
export const RHR_WINDOW_DAYS = 28;
/** … when at least this many of them have a value. */
export const RHR_MIN_SAMPLES = 14;

/** The fields of a threshold row the lookups need; rows of one date keep their input order. */
export type ThresholdPoint = Pick<ThresholdRow, 'date' | 'param' | 'value'>;

/** A resolved value; `note` says when it is a default or an approximation. */
export interface Resolved {
  value: number;
  note?: string;
}

/** Garmin profile parameters recorded as `garmin-auto` rows, in this order. */
export const PROFILE_THRESHOLD_PARAMS = [
  'hrmax',
  'rhr',
  'lthr_run',
  'lthr_bike',
  'ftp_w',
  'run_ftp_w',
  'vo2max_run',
] as const satisfies readonly ThresholdParam[];

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj | undefined => (v !== null && typeof v === 'object' ? (v as Obj) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const bySport = (list: unknown, sport: string): Obj | undefined =>
  Array.isArray(list) ? list.map(obj).find((z) => z?.['sport'] === sport) : undefined;

/**
 * Threshold values in a stored Garmin profile (`profile.raw`): HR zones of the DEFAULT and
 * CYCLING sport, power zones of CYCLING and RUNNING, and `settings.userData`. Missing or
 * non-numeric values are left out.
 */
export function profileThresholds(profileRaw: unknown): { param: ThresholdParam; value: number }[] {
  const p = obj(profileRaw);
  const hz = bySport(p?.['heartRateZones'], 'DEFAULT');
  const hzBike = bySport(p?.['heartRateZones'], 'CYCLING');
  const pzBike = bySport(p?.['powerZones'], 'CYCLING');
  const pzRun = bySport(p?.['powerZones'], 'RUNNING');
  const user = obj(obj(p?.['settings'])?.['userData']);
  const values: Record<(typeof PROFILE_THRESHOLD_PARAMS)[number], number | undefined> = {
    hrmax: num(hz?.['maxHeartRateUsed']),
    rhr: num(hz?.['restingHeartRateUsed']),
    lthr_run: num(hz?.['lactateThresholdHeartRateUsed']) ?? num(user?.['lactateThresholdHeartRate']),
    lthr_bike: num(hzBike?.['lactateThresholdHeartRateUsed']),
    ftp_w: num(pzBike?.['functionalThresholdPower']),
    run_ftp_w: num(pzRun?.['functionalThresholdPower']),
    vo2max_run: num(user?.['vo2MaxRunning']),
  };
  return PROFILE_THRESHOLD_PARAMS.flatMap((param) => {
    const value = values[param];
    return value === undefined ? [] : [{ param, value }];
  });
}

/** Lower bounds of Garmin's HR zones 1–5 and the HRmax Garmin used (bpm), from one sport of the profile. */
export interface ZoneFloors {
  zone1Floor: number;
  zone2Floor: number;
  zone3Floor: number;
  zone4Floor: number;
  zone5Floor: number;
  maxHeartRateUsed: number;
}

/** HR zone boundaries of the profile's DEFAULT and CYCLING sport; a sport is absent when they are missing. */
export interface ProfileZoneFloors {
  DEFAULT?: ZoneFloors;
  CYCLING?: ZoneFloors;
}

const ZONE_FLOOR_KEYS = ['zone1Floor', 'zone2Floor', 'zone3Floor', 'zone4Floor', 'zone5Floor', 'maxHeartRateUsed'] as const;

/**
 * HR zone boundaries of the DEFAULT and CYCLING sport in a stored Garmin profile (`profile.raw`).
 * A sport is left out unless all six values are numbers rising strictly from zone 1 to HRmax.
 * These are the profile's current zones, not the ones of an activity's date.
 */
export function profileZoneFloors(profileRaw: unknown): ProfileZoneFloors {
  const zones = obj(profileRaw)?.['heartRateZones'];
  const one = (sport: string): ZoneFloors | undefined => {
    const z = bySport(zones, sport);
    const values = ZONE_FLOOR_KEYS.map((k) => num(z?.[k]));
    if (values.some((v, i) => v === undefined || (i > 0 && !(v > (values[i - 1] ?? Infinity))))) return undefined;
    return Object.fromEntries(ZONE_FLOOR_KEYS.map((k, i) => [k, values[i]])) as unknown as ZoneFloors;
  };
  const DEFAULT = one('DEFAULT');
  const CYCLING = one('CYCLING');
  return { ...(DEFAULT && { DEFAULT }), ...(CYCLING && { CYCLING }) };
}

/**
 * Adds a `garmin-auto` row for each profile value that differs from the last `garmin-auto`
 * row of its param, dated with the local date of `profile.fetched_at`. Idempotent and offline;
 * run it before every analytics read. A second, different value on a date that already has a
 * `garmin-auto` row is not stored (the UNIQUE key keeps the first); the next profile fetch on
 * a later date records it.
 */
export function recordProfileThresholds(store: Store, now: number, timeZone: string): { added: NewThreshold[] } {
  const profile = store.getProfile();
  if (!profile) return { added: [] };
  const date = dateIn(timeZone, new Date(profile.fetched_at));
  const added: NewThreshold[] = [];
  for (const { param, value } of profileThresholds(profile.raw)) {
    const last = store.listThresholds(param).findLast((r) => r.source === 'garmin-auto');
    if (last?.value === value) continue;
    const row: NewThreshold = { date, param, value, source: 'garmin-auto', created_at: now };
    if (store.addThreshold(row).added) added.push(row);
  }
  return { added };
}

/**
 * Value of `param` on `date`: the row with the latest date ≤ `date` whatever its source (same
 * date: the later row in `rows`); before the whole history, the first row (carried back);
 * no rows, `undefined`.
 */
export function thresholdOn(rows: readonly ThresholdPoint[], param: ThresholdParam, date: IsoDate): number | undefined {
  const own = rows.filter((r) => r.param === param).toSorted((a, b) => a.date.localeCompare(b.date));
  return (own.findLast((r) => r.date <= date) ?? own[0])?.value;
}

/** The sport's own LTHR parameter; other groups use `lthr_run`. */
const ownLthrParam = (sport: SportGroup): 'lthr_bike' | 'lthr_swim' | undefined =>
  sport === 'bike' ? 'lthr_bike' : sport === 'swim' ? 'lthr_swim' : undefined;

/**
 * Lactate threshold HR for a sport on `date`: bike and swim fall back to the running LTHR;
 * without any LTHR, 0.89 × HRmax (rounded) when HRmax is in the history, else 170.
 */
export function lthrFor(rows: readonly ThresholdPoint[], sport: SportGroup, date: IsoDate): Resolved {
  const own = ownLthrParam(sport);
  const value = (own && thresholdOn(rows, own, date)) ?? thresholdOn(rows, 'lthr_run', date);
  if (value !== undefined) return { value };
  const hrmax = thresholdOn(rows, 'hrmax', date);
  if (hrmax !== undefined) {
    return {
      value: Math.round(LTHR_FROM_HRMAX * hrmax),
      note: `No LTHR in the threshold history; ${LTHR_FROM_HRMAX.toFixed(2)} × HRmax (${hrmax} bpm) used, estimated from HRmax; confirm with a test.`,
    };
  }
  return { value: DEFAULT_LTHR, note: `No LTHR and no HRmax in the threshold history; default ${DEFAULT_LTHR} bpm used.` };
}

/**
 * LT1 HR on `date`. Bike and swim with their own LTHR row: 0.90 × that LTHR (rounded). Otherwise
 * the `lt1_hr` row, else 0.90 × running LTHR (rounded); cycling then 7 bpm lower.
 */
export function lt1For(rows: readonly ThresholdPoint[], sport: SportGroup, date: IsoDate): Resolved {
  const own = ownLthrParam(sport);
  const ownLthr = own ? thresholdOn(rows, own, date) : undefined;
  if (ownLthr !== undefined) {
    const label = own === 'lthr_bike' ? 'cycling' : 'swimming';
    return {
      value: Math.round(LT1_FROM_LTHR * ownLthr),
      note: `LT1 approximated as ${LT1_FROM_LTHR.toFixed(2)} × ${label} LTHR; confirm with a test.`,
    };
  }
  const offset = sport === 'bike' ? BIKE_LT1_OFFSET : 0;
  const lt1 = thresholdOn(rows, 'lt1_hr', date);
  if (lt1 !== undefined) return { value: lt1 - offset };
  const lthr = lthrFor(rows, 'run', date);
  const note = `LT1 approximated as ${LT1_FROM_LTHR.toFixed(2)} × running LTHR; confirm with a test.`;
  return {
    value: Math.round(LT1_FROM_LTHR * lthr.value) - offset,
    note: lthr.note ? `${lthr.note} ${note}` : note,
  };
}

/**
 * Resting HR used for `date`: mean `resting_hr` of the days [D − 28, D − 1] when at least 14 of
 * them have a value (rounded to 0.1), else the `rhr` threshold on that date, else 50.
 */
export function restingHrOn(
  daily: readonly { date: IsoDate; resting_hr: number | null }[],
  rows: readonly ThresholdPoint[],
  date: IsoDate,
): Resolved {
  const from = addDays(date, -RHR_WINDOW_DAYS);
  const samples = daily.flatMap((d) =>
    d.date >= from && d.date < date && d.resting_hr !== null && Number.isFinite(d.resting_hr) && d.resting_hr > 0
      ? [d.resting_hr]
      : [],
  );
  if (samples.length >= RHR_MIN_SAMPLES) {
    return { value: round(samples.reduce((s, v) => s + v, 0) / samples.length, 1) ?? DEFAULT_RHR };
  }
  const value = thresholdOn(rows, 'rhr', date);
  if (value !== undefined) return { value };
  return { value: DEFAULT_RHR, note: `No resting HR history; default ${DEFAULT_RHR} bpm used.` };
}

/** Sports `by_sport` of `get_thresholds` resolves; other groups use the running thresholds. */
export const THRESHOLD_SPORTS = ['run', 'bike', 'swim'] as const satisfies readonly SportGroup[];
export type ThresholdSport = (typeof THRESHOLD_SPORTS)[number];

/** LTHR and LT1 of one sport; a note says when a value is a fallback, a default or an approximation. */
export interface SportThresholds {
  lthr: number;
  lt1: number;
  lthr_note?: string;
  lt1_note?: string;
}

/**
 * LTHR and LT1 of run, bike and swim on `date` through `lthrFor` and `lt1For`. Bike and swim
 * without their own LTHR row note that the running LTHR is used.
 */
export function thresholdsBySport(rows: readonly ThresholdPoint[], date: IsoDate): Record<ThresholdSport, SportThresholds> {
  const one = (sport: ThresholdSport): SportThresholds => {
    const lthr = lthrFor(rows, sport, date);
    const lt1 = lt1For(rows, sport, date);
    const own = sport === 'run' ? undefined : (`lthr_${sport}` as const);
    const fallback =
      own && !lthr.note && thresholdOn(rows, own, date) === undefined ? `No ${own} in the threshold history; the running LTHR is used.` : undefined;
    const lthrNote = lthr.note ?? fallback;
    return { lthr: lthr.value, lt1: lt1.value, ...(lthrNote && { lthr_note: lthrNote }), ...(lt1.note && { lt1_note: lt1.note }) };
  };
  return { run: one('run'), bike: one('bike'), swim: one('swim') };
}

/** HRmax on `date` from the threshold history (Garmin profile or a test); no row, no value and a note. */
export function hrmaxOn(rows: readonly ThresholdPoint[], date: IsoDate): Partial<Resolved> {
  const value = thresholdOn(rows, 'hrmax', date);
  if (value !== undefined) return { value };
  return { note: 'No HRmax in the threshold history (Garmin profile or set_threshold); no default is assumed.' };
}
