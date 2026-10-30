import { hms, pacePerKm, round, type ActivityWeather } from 'garmin-mcp-domain';
import type { DecouplingBasis, Session } from './session.js';

/**
 * Side-by-side comparison of sessions (`compare_activities`): either the given ids, or a
 * reference activity and the stored sessions similar to it. Similar = the same activity type,
 * duration within ±`duration_pct` %, for foot sports the pace (grade adjusted when both have
 * it) within ±`pace_s_per_km`, optionally the same route (start and end within
 * {@link ROUTE_RADIUS_M} and distance within ±10 %) and optionally easy only (less than 5 % of
 * the time in HR zones 4-5).
 */

export interface CompareCriteria {
  duration_pct: number;
  pace_s_per_km: number;
  same_route: boolean;
  easy_only: boolean;
}

export const DEFAULT_COMPARE_CRITERIA: CompareCriteria = { duration_pct: 20, pace_s_per_km: 20, same_route: false, easy_only: false };

/** Start and end points this close (m) count as the same route. */
export const ROUTE_RADIUS_M = 300;
/** Share of the time in HR zones 4-5 below which a session counts as easy. */
export const EASY_MAX_Z45 = 0.05;

/** Start and end of an activity (decimal degrees) from its list entry; used for matching only, never output. */
export interface RouteEnds {
  start?: readonly [number, number];
  end?: readonly [number, number];
}

type Obj = Record<string, unknown>;
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function routeEnds(raw: unknown): RouteEnds {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Obj;
  const point = (lat: unknown, lon: unknown): readonly [number, number] | undefined => {
    const a = num(lat);
    const b = num(lon);
    return a !== undefined && b !== undefined && (a !== 0 || b !== 0) ? [a, b] : undefined;
  };
  return { start: point(r.startLatitude, r.startLongitude), end: point(r.endLatitude, r.endLongitude) };
}

/** Great-circle distance in metres. */
export function haversineM(a: readonly [number, number], b: readonly [number, number]): number {
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad;
  const dLon = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const FOOT = new Set(['run', 'hike']);

/** Pace (s/km) of a session: from GAP when `gap` and the session has it, else distance / time. */
function paceS(s: Session, gap: boolean): number | undefined {
  if (gap && s.gap_mps !== undefined && s.gap_mps > 0) return 1000 / s.gap_mps;
  return (s.distance_m ?? 0) > 0 && (s.duration_s ?? 0) > 0 ? ((s.duration_s ?? 0) / (s.distance_m ?? 1)) * 1000 : undefined;
}

const z45Share = (s: Session): number | undefined => {
  const zones = [s.z1_s, s.z2_s, s.z3_s, s.z4_s, s.z5_s];
  const total = zones.reduce<number>((a, z) => a + (z ?? 0), 0);
  return total > 0 ? ((s.z4_s ?? 0) + (s.z5_s ?? 0)) / total : undefined;
};

const signed = (v: number, unit: string) => `${v > 0 ? '+' : ''}${v}${unit}`;

/** Whether `c` is similar to `ref` under `crit`, and how it differs (`match`). */
export function similarity(ref: Session, refEnds: RouteEnds, c: Session, cEnds: RouteEnds, crit: CompareCriteria): string | undefined {
  if (c.id === ref.id || c.type !== ref.type) return undefined;
  const rd = ref.duration_s ?? 0;
  const cd = c.duration_s ?? 0;
  if (!(rd > 0 && cd > 0)) return undefined;
  const durPct = ((cd - rd) / rd) * 100;
  if (Math.abs(durPct) > crit.duration_pct) return undefined;
  const parts = [`duration ${signed(Math.round(durPct), '%')}`];
  if (FOOT.has(ref.sport)) {
    const gap = ref.gap_mps !== undefined && c.gap_mps !== undefined;
    const rp = paceS(ref, gap);
    const cp = paceS(c, gap);
    if (rp === undefined || cp === undefined || Math.abs(cp - rp) > crit.pace_s_per_km) return undefined;
    parts.push(`${gap ? 'GAP' : 'pace'} ${signed(Math.round(cp - rp), ' s/km')}`);
  }
  if (crit.same_route) {
    const near = (a?: readonly [number, number], b?: readonly [number, number]) => a !== undefined && b !== undefined && haversineM(a, b) <= ROUTE_RADIUS_M;
    const rdist = ref.distance_m ?? 0;
    if (!near(refEnds.start, cEnds.start) || !near(refEnds.end, cEnds.end) || !(rdist > 0) || Math.abs((c.distance_m ?? 0) - rdist) > rdist * 0.1) return undefined;
    parts.push('same route');
  }
  if (crit.easy_only) {
    const z45 = z45Share(c);
    if (z45 === undefined || z45 >= EASY_MAX_Z45) return undefined;
  }
  return parts.join(', ');
}

export interface CompareRow {
  id: number | string;
  date: string;
  type?: string;
  name?: string;
  /** How a similar session differs from the reference; `reference` on the reference row. */
  match?: string;
  duration?: string;
  distance_km?: number;
  pace?: string;
  gap_pace?: string;
  avg_speed_kmh?: number;
  elev_gain_m?: number;
  avg_hr?: number;
  max_hr?: number;
  avg_power_w?: number;
  np_w?: number;
  ef?: number;
  ef_gap?: number;
  ef_power?: number;
  decoupling_pct?: number;
  decoupling_basis?: DecouplingBasis;
  decoupling_pw_pct?: number;
  if?: number;
  tss?: number;
  load_source?: string;
  z4_z5_pct?: number;
  avg_cadence?: number;
  gct_ms?: number;
  gct_balance_left_pct?: number;
  vertical_oscillation_cm?: number;
  vertical_ratio_pct?: number;
  stride_m?: number;
  avg_respiration_brpm?: number;
  temp_c?: number;
  dew_point_c?: number;
  humidity_pct?: number;
}

/** One table row: the session's metrics, its pace strings and the weather when downloaded. */
export function compareRow(s: Session, weather: ActivityWeather | undefined, match?: string): CompareRow {
  const foot = FOOT.has(s.sport);
  const z45 = z45Share(s);
  const dist = s.distance_m ?? 0;
  const dur = s.duration_s ?? 0;
  return {
    id: s.id,
    date: s.date,
    type: s.type,
    name: s.name,
    match,
    duration: hms(s.duration_s),
    distance_km: dist > 0 ? round(dist / 1000, 2) : undefined,
    pace: foot && dist > 0 && dur > 0 ? pacePerKm(dist / dur) : undefined,
    gap_pace: foot ? pacePerKm(s.gap_mps) : undefined,
    avg_speed_kmh: !foot && dist > 0 && dur > 0 ? round((dist / dur) * 3.6, 1) : undefined,
    elev_gain_m: s.elev_gain_m,
    avg_hr: s.avg_hr,
    max_hr: s.max_hr,
    avg_power_w: s.avg_power_w,
    np_w: s.np_w,
    ef: s.ef,
    ef_gap: s.ef_gap,
    ef_power: s.ef_power,
    decoupling_pct: s.decoupling_pct,
    decoupling_basis: s.decoupling_basis,
    decoupling_pw_pct: s.decoupling_pw_pct,
    if: s.if,
    tss: s.tss,
    load_source: s.load_source,
    z4_z5_pct: z45 === undefined ? undefined : round(z45 * 100, 0),
    avg_cadence: s.avg_cadence,
    gct_ms: s.gct_ms,
    gct_balance_left_pct: s.gct_balance_left_pct,
    vertical_oscillation_cm: s.vertical_oscillation_cm,
    vertical_ratio_pct: s.vertical_ratio_pct,
    stride_m: s.stride_m,
    avg_respiration_brpm: s.avg_respiration_brpm,
    temp_c: weather?.temp_c,
    dew_point_c: weather?.dew_point_c,
    humidity_pct: weather?.humidity_pct,
  };
}
