import { hms, isFootSport, km, pacePerKm, round, speedOrPace } from './format.js';

/**
 * Pure mappers for the optional activity sections of `get_activity`: time in HR or
 * power zones, weather, strength sets and typed splits. Inputs are Garmin's raw responses as
 * cached in `activity_details`; every field is read defensively because the
 * client's schemas for these endpoints are lenient and not yet confirmed by
 * recordings, and rows cached before they existed were never validated.
 */

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

export interface ZoneTime {
  zone?: number;
  from_bpm?: number;
  from_w?: number;
  time?: string;
  pct?: number;
}

/** `hrTimeInZones` / `powerTimeInZones`: `[{ zoneNumber, secsInZone, zoneLowBoundary }]`. */
export function zoneTimes(raw: unknown, unit: 'bpm' | 'w'): ZoneTime[] {
  const zones = (Array.isArray(raw) ? raw : []).map(obj).filter((z): z is Obj => z !== undefined);
  const total = zones.reduce((a, z) => a + (num(z.secsInZone) ?? 0), 0);
  return zones.map((z) => {
    const secs = num(z.secsInZone);
    return {
      zone: num(z.zoneNumber),
      [unit === 'bpm' ? 'from_bpm' : 'from_w']: round(num(z.zoneLowBoundary), 0),
      time: hms(secs),
      pct: total ? round(((secs ?? 0) / total) * 100, 0) : undefined,
    };
  });
}

export interface ActivityWeather {
  temp_c?: number;
  feels_like_c?: number;
  dew_point_c?: number;
  humidity_pct?: number;
  wind_kmh?: number;
  wind_gust_kmh?: number;
  wind_from?: string;
  wind_dir_deg?: number;
  conditions?: string;
  station?: string;
  observed_at?: string;
}

const fToC = (f: number | undefined) => (f === undefined ? undefined : round(((f - 32) * 5) / 9, 1));

/**
 * `activity/{id}/weather`. Garmin sends temperatures in Fahrenheit whatever the
 * account units, and wind in the account's display unit (km/h, or mph for
 * `statute_us`). Not confirmed by a recording yet (E2-8). Output is always metric.
 */
export function activityWeather(raw: unknown, units: string | undefined): ActivityWeather | undefined {
  const w = obj(raw);
  if (!w || num(w.temp) === undefined) return undefined;
  const wind = (v: unknown) => {
    const n = num(v);
    return n === undefined ? undefined : round(units === 'statute_us' ? n * 1.609_344 : n, 0);
  };
  return {
    temp_c: fToC(num(w.temp)),
    feels_like_c: fToC(num(w.apparentTemp)),
    dew_point_c: fToC(num(w.dewPoint)),
    humidity_pct: round(num(w.relativeHumidity), 0),
    wind_kmh: wind(w.windSpeed),
    wind_gust_kmh: wind(w.windGust),
    wind_from: str(w.windDirectionCompassPoint)?.toUpperCase(),
    wind_dir_deg: round(num(w.windDirection), 0),
    conditions: str(obj(w.weatherTypeDTO)?.desc)?.toLowerCase(),
    station: str(obj(w.weatherStationDTO)?.name),
    observed_at: str(w.issueDate),
  };
}

export interface StrengthSet {
  set: number;
  exercise?: string;
  reps?: number;
  weight_kg?: number;
  duration?: string;
  rest_after?: string;
}

export interface StrengthSets {
  sets: StrengthSet[];
  total_sets: number;
  total_reps?: number;
  /** Sum of reps × weight over sets with a weight. */
  volume_kg?: number;
}

const exerciseKey = (v: unknown) => str(v)?.toLowerCase();

/**
 * `activity/{id}/exerciseSets`: `{ exerciseSets: [{ setType: ACTIVE|REST, exercises:
 * [{ category, name, probability }], repetitionCount, weight (grams), duration (s) }] }`.
 * Rest sets become `rest_after` of the preceding active set.
 */
export function strengthSets(raw: unknown): StrengthSets | undefined {
  const list = obj(raw)?.exerciseSets;
  if (!Array.isArray(list)) return undefined;
  const sets: StrengthSet[] = [];
  for (const item of list.map(obj)) {
    if (!item) continue;
    const duration = num(item.duration);
    if (str(item.setType) === 'REST') {
      const last = sets.at(-1);
      if (last && duration !== undefined) last.rest_after = hms(duration);
      continue;
    }
    const best = (Array.isArray(item.exercises) ? item.exercises : [])
      .map(obj)
      .filter((e): e is Obj => e !== undefined)
      .toSorted((a, b) => (num(b.probability) ?? 0) - (num(a.probability) ?? 0))[0];
    const grams = num(item.weight);
    sets.push({
      set: sets.length + 1,
      exercise: exerciseKey(best?.name) ?? exerciseKey(best?.category),
      reps: num(item.repetitionCount),
      weight_kg: grams !== undefined && grams > 0 ? round(grams / 1000, 1) : undefined,
      duration: hms(duration),
    });
  }
  if (sets.length === 0) return undefined;
  const reps = sets.reduce((a, s) => a + (s.reps ?? 0), 0);
  const volume = sets.reduce((a, s) => a + (s.reps ?? 0) * (s.weight_kg ?? 0), 0);
  return { sets, total_sets: sets.length, total_reps: reps || undefined, volume_kg: round(volume, 0) || undefined };
}

/** Garmin's split types as `get_activity` names them; any other type is its key in lower case. */
const SPLIT_TYPES: Record<string, string> = { RWD_RUN: 'run', RWD_WALK: 'walk', RWD_STAND: 'stand', CLIMB_PRO_CYCLING_CLIMB: 'climb' };
/**
 * ClimbPro cuts every climb into sections (`parentIndex` = the climb); a long trail run has
 * hundreds of them, so the list keeps the climbs and leaves the sections out.
 */
const LEFT_OUT_SPLITS = new Set(['CLIMB_PRO_CYCLING_CLIMB_SECTION']);
const splitType = (v: unknown) => {
  const key = str(v);
  return key === undefined ? undefined : (SPLIT_TYPES[key] ?? key.toLowerCase());
};

interface SplitNumbers {
  type?: string;
  duration?: string;
  distance_km?: number;
  avg_pace?: string;
  avg_speed_kmh?: number;
  /** Swimming: the same speed as pace per 100 m, "m:ss /100m". */
  avg_pace_100m?: string;
  avg_gap_pace?: string;
  avg_hr_bpm?: number;
  max_hr_bpm?: number;
  elevation_gain_m?: number;
  elevation_loss_m?: number;
}

export interface TypedSplit extends SplitNumbers {
  /** Local clock time the split started, "hh:mm:ss". */
  start?: string;
  avg_grade_pct?: number;
  max_grade_pct?: number;
}

export interface SplitSummary extends SplitNumbers {
  count?: number;
  /** Share of the time and distance of the type's family (run, walk and stand; the interval types), in percent. */
  time_pct?: number;
  distance_pct?: number;
}

/** Numbers shared by a typed split and a split summary; standing has no pace. */
function splitNumbers(s: Obj, type: string | undefined, sport: string | undefined): SplitNumbers {
  const moving = type !== 'stand';
  return {
    type,
    duration: hms(num(s.duration)),
    distance_km: km(num(s.distance)),
    ...(moving ? speedOrPace(sport, num(s.distance), num(s.duration)) : {}),
    avg_gap_pace: moving && isFootSport(sport) ? pacePerKm(num(s.avgGradeAdjustedSpeed)) : undefined,
    avg_hr_bpm: round(num(s.averageHR), 0),
    max_hr_bpm: round(num(s.maxHR), 0),
    elevation_gain_m: round(num(s.elevationGain), 0),
    elevation_loss_m: round(num(s.elevationLoss), 0),
  };
}

/**
 * Run, walk and stand splits shorter than this many seconds are merged into a neighbouring one in
 * `typed_splits`: a long trail run has a hundred and more of them, mostly a few seconds each.
 */
export const MIN_TYPED_SPLIT_S = 120;
/** The run/walk/stand splits; only these are merged. Climbs and intervals overlap them and stay as they are. */
const MOTION_SPLITS = new Set(['RWD_RUN', 'RWD_WALK', 'RWD_STAND']);

/** Sum of `key` over the two splits; undefined when neither has it. */
function sum(a: Obj, b: Obj, key: string): number | undefined {
  const x = num(a[key]);
  const y = num(b[key]);
  return x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
}

/** Larger `key` of the two splits. */
function max(a: Obj, b: Obj, key: string): number | undefined {
  const x = num(a[key]);
  const y = num(b[key]);
  return x === undefined ? y : y === undefined ? x : Math.max(x, y);
}

/** `key` averaged over the two splits weighted by `by` (time or distance), over the ones that have both. */
function weighted(a: Obj, b: Obj, key: string, by: string): number | undefined {
  const parts = [a, b].flatMap((s) => {
    const v = num(s[key]);
    return v === undefined ? [] : [{ v, w: num(s[by]) ?? 0 }];
  });
  const total = parts.reduce((t, p) => t + p.w, 0);
  if (parts.length === 0) return undefined;
  return total > 0 ? parts.reduce((t, p) => t + p.v * p.w, 0) / total : parts[0]?.v;
}

/**
 * One split out of two neighbours (`first` started earlier): time, distance, gain and loss add up,
 * heart rate and grade adjusted speed are averaged over time, grade over distance; the type is
 * the longer one's, the start the earlier one's.
 */
function mergeSplits(first: Obj, second: Obj): Obj {
  const longer = (num(second.duration) ?? 0) > (num(first.duration) ?? 0) ? second : first;
  return {
    type: longer.type,
    startTimeLocal: first.startTimeLocal,
    startTimeGMT: first.startTimeGMT,
    messageIndex: first.messageIndex,
    duration: sum(first, second, 'duration'),
    distance: sum(first, second, 'distance'),
    elevationGain: sum(first, second, 'elevationGain'),
    elevationLoss: sum(first, second, 'elevationLoss'),
    averageHR: weighted(first, second, 'averageHR', 'duration'),
    maxHR: max(first, second, 'maxHR'),
    avgGradeAdjustedSpeed: weighted(first, second, 'avgGradeAdjustedSpeed', 'duration'),
    averageGrade: weighted(first, second, 'averageGrade', 'distance'),
    maxGrade: max(first, second, 'maxGrade'),
  };
}

/**
 * Merges every run/walk/stand split shorter than `minS` into the previous run/walk/stand split, or,
 * at the start, into the next one. Other splits in between neither merge nor stop the merging.
 * `sorted` is in start order; the result keeps it, as a merged split starts with its earlier part.
 */
function mergeShortSplits(sorted: Obj[], minS: number): { kept: Obj[]; merged: number } {
  const kept: Obj[] = [];
  const motion: number[] = [];
  let leadIsShort = false;
  let merged = 0;
  for (const s of sorted) {
    if (!MOTION_SPLITS.has(str(s.type) ?? '')) {
      kept.push(s);
      continue;
    }
    const duration = num(s.duration);
    const short = duration !== undefined && duration < minS;
    const last = motion.at(-1);
    if (short && last !== undefined) {
      kept[last] = mergeSplits(kept[last] as Obj, s);
      merged++;
      continue;
    }
    if (last === undefined) leadIsShort = short;
    motion.push(kept.length);
    kept.push(s);
  }
  const [first, next] = motion;
  if (leadIsShort && first !== undefined && next !== undefined) {
    kept[first] = mergeSplits(kept[first] as Obj, kept[next] as Obj);
    kept.splice(next, 1);
    merged++;
  }
  return { kept, merged };
}

/**
 * `activity/{id}/typedsplits`: `{ splits: [{ type, startTimeLocal, duration (s), distance (m),
 * avgGradeAdjustedSpeed (m/s), averageGrade, maxGrade, ... }] }`, in start order. Pace or speed
 * follows the activity's sport, as for laps. Run, walk and stand splits shorter than `minS`
 * (`MIN_TYPED_SPLIT_S`) are merged into a neighbour; `merged` says how many.
 */
export function typedSplits(raw: unknown, sport: string | undefined, minS = MIN_TYPED_SPLIT_S): { splits: TypedSplit[]; merged: number } {
  const list = obj(raw)?.splits;
  const sorted = (Array.isArray(list) ? list : [])
    .map(obj)
    .filter((s): s is Obj => s !== undefined && !LEFT_OUT_SPLITS.has(str(s.type) ?? ''))
    .toSorted((a, b) => (str(a.startTimeGMT) ?? '').localeCompare(str(b.startTimeGMT) ?? '') || (num(a.messageIndex) ?? 0) - (num(b.messageIndex) ?? 0));
  const { kept, merged } = mergeShortSplits(sorted, minS);
  const splits = kept.map((s) => ({
    type: splitType(s.type),
    start: str(s.startTimeLocal)?.slice(11, 19),
    ...splitNumbers(s, splitType(s.type), sport),
    avg_grade_pct: round(num(s.averageGrade), 1),
    max_grade_pct: round(num(s.maxGrade), 1),
  }));
  return { splits, merged };
}

/**
 * The family of a split type: its key without the last part (`RWD_RUN` → `RWD`, `INTERVAL_ACTIVE`
 * → `INTERVAL`). The types of one family split the activity between them; families overlap (the
 * run/walk/stand splits and the interval splits each cover the whole activity, climbs a part).
 */
const splitFamily = (v: unknown) => str(v)?.replace(/_[^_]*$/, '');

/** Share of `part` in `total` in percent, one decimal; undefined without both. */
const share = (part: number | undefined, total: number) => (part === undefined || !(total > 0) ? undefined : round((part / total) * 100, 1));

/**
 * Totals per split type (`splitType`, `noOfSplits`), from `activity/{id}/split_summaries` or the
 * same `splitSummaries` list of the activity itself. `time_pct` and `distance_pct` are the type's
 * share in the sum of its family (run, walk and stand together; the interval types together), as
 * the families overlap; a type alone in its family (a climb, a single interval) has no share.
 */
export function splitSummaries(list: unknown, sport: string | undefined): SplitSummary[] {
  const items = (Array.isArray(list) ? list : []).map(obj).filter((s): s is Obj => s !== undefined);
  const families = new Map<string | undefined, { types: number; duration: number; distance: number }>();
  for (const s of items) {
    const f = families.get(splitFamily(s.splitType)) ?? { types: 0, duration: 0, distance: 0 };
    families.set(splitFamily(s.splitType), { types: f.types + 1, duration: f.duration + (num(s.duration) ?? 0), distance: f.distance + (num(s.distance) ?? 0) });
  }
  return items.map((s) => {
    const family = families.get(splitFamily(s.splitType));
    const shared = family !== undefined && family.types > 1;
    return {
      type: splitType(s.splitType),
      count: num(s.noOfSplits),
      ...splitNumbers(s, splitType(s.splitType), sport),
      time_pct: shared ? share(num(s.duration), family.duration) : undefined,
      distance_pct: shared ? share(num(s.distance), family.distance) : undefined,
    };
  });
}

export interface LapGroup {
  intensity?: string;
  laps: number;
  duration?: string;
  distance_km?: number;
  avg_pace?: string;
  avg_speed_kmh?: number;
  /** Swimming: the same speed as pace per 100 m, "m:ss /100m". */
  avg_pace_100m?: string;
  avg_gap_pace?: string;
  avg_hr_bpm?: number;
  max_hr_bpm?: number;
  avg_power_w?: number;
}

/** `key` averaged over `items` weighted by their `duration`, over the ones with a positive value. */
function timeWeighted(items: Obj[], key: string): number | undefined {
  let sum = 0;
  let time = 0;
  for (const l of items) {
    const v = num(l[key]);
    const d = num(l.duration);
    if (v === undefined || v <= 0 || d === undefined || d <= 0) continue;
    sum += v * d;
    time += d;
  }
  return time > 0 ? sum / time : undefined;
}

/**
 * Laps (`lapDTOs`) grouped by `intensityType` (warmup, active, interval, recovery, rest,
 * cooldown...), in the order the groups first appear: lap count, total time and distance, pace or
 * speed from those totals (as for laps), and heart rate, power and grade adjusted speed averaged
 * over time. Computed from the raw seconds and metres, never from the formatted lap rows.
 */
export function lapSummary(laps: unknown, sport: string | undefined): LapGroup[] {
  const groups = new Map<string | undefined, Obj[]>();
  for (const l of (Array.isArray(laps) ? laps : []).map(obj)) {
    if (!l) continue;
    const key = str(l.intensityType)?.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  const foot = isFootSport(sport);
  return [...groups].map(([intensity, items]) => {
    const total = (key: string) => (items.some((l) => num(l[key]) !== undefined) ? items.reduce((a, l) => a + (num(l[key]) ?? 0), 0) : undefined);
    const duration = total('duration');
    const distance = total('distance');
    const maxHr = items.map((l) => num(l.maxHR)).filter((v): v is number => v !== undefined && v > 0);
    return {
      intensity,
      laps: items.length,
      duration: hms(duration),
      distance_km: km(distance),
      ...speedOrPace(sport, distance, duration),
      avg_gap_pace: foot ? pacePerKm(timeWeighted(items, 'avgGradeAdjustedSpeed')) : undefined,
      avg_hr_bpm: round(timeWeighted(items, 'averageHR'), 0),
      max_hr_bpm: maxHr.length > 0 ? round(Math.max(...maxHr), 0) : undefined,
      avg_power_w: round(timeWeighted(items, 'averagePower'), 0),
    };
  });
}
