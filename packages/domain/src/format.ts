/** Formatting helpers for LLM-facing output: numbers with units, no empty fields. */

export function round(v: number | null | undefined, digits = 1): number | undefined {
  if (v === null || v === undefined || !Number.isFinite(v)) return undefined;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Seconds → "h:mm:ss" or "m:ss". */
export function hms(seconds: number | null | undefined): string | undefined {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return undefined;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** Speed in m/s → "m:ss /km". */
export function pacePerKm(metersPerSecond: number | null | undefined): string | undefined {
  if (!metersPerSecond || metersPerSecond <= 0) return undefined;
  return `${hms(1000 / metersPerSecond)} /km`;
}

/** Speed in m/s → "m:ss /100m", the pace of swimming. */
export function pacePer100m(metersPerSecond: number | null | undefined): string | undefined {
  if (!metersPerSecond || metersPerSecond <= 0) return undefined;
  return `${hms(100 / metersPerSecond)} /100m`;
}

export function km(meters: number | null | undefined, digits = 2): number | undefined {
  return meters === null || meters === undefined ? undefined : round(meters / 1000, digits);
}

export function hours(seconds: number | null | undefined, digits = 2): number | undefined {
  return seconds === null || seconds === undefined ? undefined : round(seconds / 3600, digits);
}

const PACE_SPORTS = /run|walk|hik/i;

/** Running, walking and hiking types, which get pace instead of speed. */
export function isFootSport(type: string | null | undefined): boolean {
  return PACE_SPORTS.test(type ?? '');
}

const SWIM_SPORTS = /swim/i;

/** Swimming types (lap_swimming, open_water_swimming...), which get the pace per 100 m next to the speed. */
export function isSwimSport(type: string | null | undefined): boolean {
  return SWIM_SPORTS.test(type ?? '');
}

/** Speed in km/h for a speed in m/s, and for swimming also the pace per 100 m (`avg_pace_100m`). */
export function speedFields(type: string | null | undefined, metersPerSecond: number | null | undefined): { avg_speed_kmh?: number; avg_pace_100m?: string } {
  if (!metersPerSecond || metersPerSecond <= 0) return {};
  const speed = { avg_speed_kmh: round(metersPerSecond * 3.6, 1) };
  return isSwimSport(type) ? { ...speed, avg_pace_100m: pacePer100m(metersPerSecond) } : speed;
}

/** Pace for foot sports, speed for everything else, and for swimming also the pace per 100 m (`avg_pace_100m`). */
export function speedOrPace(type: string | null | undefined, distanceM: number | null | undefined, durationS: number | null | undefined): { avg_pace?: string; avg_speed_kmh?: number; avg_pace_100m?: string } {
  if (!distanceM || !durationS) return {};
  const mps = distanceM / durationS;
  return isFootSport(type) ? { avg_pace: pacePerKm(mps) } : speedFields(type, mps);
}

export function iso(ms: number | null | undefined): string | undefined {
  return ms === null || ms === undefined ? undefined : new Date(ms).toISOString();
}

/**
 * Drop undefined, null, NaN, empty strings, empty arrays and empty objects
 * recursively, so responses carry no empty fields.
 */
export function compact<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => compact(v)).filter((v) => !isEmpty(v)) as T;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const c = compact(v);
      if (!isEmpty(c)) out[k] = c;
    }
    return out as T;
  }
  return value;
}

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null || v === '') return true;
  if (typeof v === 'number' && Number.isNaN(v)) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object' && !(v instanceof Date)) return Object.keys(v).length === 0;
  return false;
}
