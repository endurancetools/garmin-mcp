import { hms, round } from './format.js';

/**
 * Pure mappers for the optional activity sections of `get_activity`: time in HR or
 * power zones, weather and strength sets. Inputs are Garmin's raw responses as
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
