import { isoWeek, type IsoDate } from 'garmin-mcp-config';
import { round } from 'garmin-mcp-domain';
import type { ActivityRow, ImportedActivityRow } from 'garmin-mcp-store';
import { sportGroup, type SportGroup } from './sport.js';
import { lthrFor, restingHrOn, type ThresholdPoint } from './thresholds.js';

/** One activity, normalized from an `activities` row or an `imported_activities` row. */
export interface SessionInput {
  id: number | string;
  date: IsoDate;
  start_local?: string;
  type?: string;
  name?: string;
  event_type?: string;
  duration_s?: number;
  moving_s?: number;
  distance_m?: number;
  elev_gain_m?: number;
  elev_loss_m?: number;
  avg_hr?: number;
  max_hr?: number;
  avg_power_w?: number;
  np_w?: number;
  avg_cadence?: number;
  calories?: number;
  /** Garmin training load (EPOC based). */
  g_load?: number;
  aerobic_te?: number;
  anaerobic_te?: number;
  rpe?: number;
  feel?: number;
  /** Grade adjusted speed (m/s). */
  gap_mps?: number;
  /** Seconds in HR zones 1–5 from the activity list; absent when Garmin gave none. */
  zones_s?: readonly [number, number, number, number, number];
  source: 'db' | 'import';
}

/** Per-activity metrics (spec 5.3); field names are the tool output names. */
export interface Session {
  id: number | string;
  date: IsoDate;
  week: string;
  start_local?: string;
  type?: string;
  sport: SportGroup;
  name?: string;
  event_type?: string;
  duration_s?: number;
  moving_s?: number;
  distance_m?: number;
  elev_gain_m?: number;
  elev_loss_m?: number;
  avg_hr?: number;
  max_hr?: number;
  avg_power_w?: number;
  np_w?: number;
  avg_cadence?: number;
  calories?: number;
  g_load?: number;
  aerobic_te?: number;
  anaerobic_te?: number;
  rpe?: number;
  feel?: number;
  if: number;
  hrtss: number;
  ef?: number;
  ef_gap?: number;
  gap_mps?: number;
  z1_s?: number;
  z2_s?: number;
  z3_s?: number;
  z4_s?: number;
  z5_s?: number;
  lthr_used: number;
  rhr_used: number;
  source: 'db' | 'import';
}

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj | undefined => (v !== null && typeof v === 'object' ? (v as Obj) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const opt = (v: number | null | undefined): number | undefined => num(v);

/** HR zone seconds 1–5 from an activity list entry; `undefined` when none of them is a number. */
function zonesFrom(raw: Obj | undefined): SessionInput['zones_s'] {
  const z = [1, 2, 3, 4, 5].map((i) => num(raw?.[`hrTimeInZone_${i}`]));
  if (z.every((v) => v === undefined)) return undefined;
  const [a = 0, b = 0, c = 0, d = 0, e = 0] = z;
  return [a, b, c, d, e];
}

/**
 * Session input from a stored activity: columns, plus `normPower`, `avgGradeAdjustedSpeed`,
 * `hrTimeInZone_N`, cadence, moving time, elevation loss and event type from the activity
 * list entry, and RPE/feel from `activity_details(kind=summary).raw.metadataDTO` when given.
 * `undefined` for a row without a date.
 */
export function sessionFromActivity(a: ActivityRow, summaryRaw?: unknown): SessionInput | undefined {
  if (!a.date) return undefined;
  const raw = obj(a.raw);
  const meta = obj(obj(summaryRaw)?.['metadataDTO']);
  return {
    id: a.id,
    date: a.date,
    start_local: a.start_time_local ?? undefined,
    type: a.type ?? undefined,
    name: a.name ?? undefined,
    event_type: str(obj(raw?.['eventType'])?.['typeKey']),
    duration_s: opt(a.duration_s),
    moving_s: num(raw?.['movingDuration']),
    distance_m: opt(a.distance_m),
    elev_gain_m: opt(a.elevation_gain_m),
    elev_loss_m: num(raw?.['elevationLoss']),
    avg_hr: opt(a.avg_hr),
    max_hr: opt(a.max_hr),
    avg_power_w: opt(a.avg_power),
    np_w: num(raw?.['normPower']),
    avg_cadence: num(raw?.['averageRunningCadenceInStepsPerMinute']) ?? num(raw?.['averageBikingCadenceInRevPerMinute']),
    calories: opt(a.calories),
    g_load: opt(a.training_load),
    aerobic_te: opt(a.training_effect_aerobic),
    anaerobic_te: opt(a.training_effect_anaerobic),
    rpe: num(meta?.['workoutRpe']),
    feel: num(meta?.['workoutFeel']),
    gap_mps: num(raw?.['avgGradeAdjustedSpeed']),
    zones_s: zonesFrom(raw),
    source: 'db',
  };
}

/** Session input from an `imported_activities` row (Garmin Connect CSV export). */
export function sessionFromImported(r: ImportedActivityRow): SessionInput {
  return {
    id: r.id,
    date: r.date,
    start_local: r.start_time_local,
    type: r.type ?? undefined,
    name: r.name ?? undefined,
    duration_s: opt(r.duration_s),
    moving_s: opt(r.moving_s),
    distance_m: opt(r.distance_m),
    elev_gain_m: opt(r.elevation_gain_m),
    elev_loss_m: opt(r.elevation_loss_m),
    avg_hr: opt(r.avg_hr),
    max_hr: opt(r.max_hr),
    avg_power_w: opt(r.avg_power),
    np_w: opt(r.norm_power),
    avg_cadence: opt(r.avg_cadence),
    calories: opt(r.calories),
    aerobic_te: opt(r.training_effect_aerobic),
    anaerobic_te: opt(r.training_effect_anaerobic),
    source: 'import',
  };
}

/** Intensity factor from HR: (avg − RHR) / (LTHR − RHR); 0 without HR, at or below RHR, or when LTHR ≤ RHR. */
export function intensityFactor(avgHr: number | undefined, rhr: number, lthr: number): number {
  if (avgHr === undefined || !(avgHr > rhr) || !(lthr > rhr)) return 0;
  return (avgHr - rhr) / (lthr - rhr);
}

/** Heart-rate training stress: hours × IF² × 100. */
export function hrTss(durationS: number | undefined, ifValue: number): number {
  return ((durationS ?? 0) / 3600) * ifValue * ifValue * 100;
}

/**
 * Efficiency factor: running speed in m/min per beat, cycling normalized power per beat;
 * `undefined` for other sports or missing inputs.
 */
export function efficiencyFactor(
  sport: SportGroup,
  s: Pick<SessionInput, 'avg_hr' | 'duration_s' | 'distance_m' | 'np_w'>,
): number | undefined {
  const hr = s.avg_hr;
  if (hr === undefined || !(hr > 0)) return undefined;
  if (sport === 'run') {
    const dur = s.duration_s ?? 0;
    const dist = s.distance_m ?? 0;
    return dur > 0 && dist > 0 ? ((dist / dur) * 60) / hr : undefined;
  }
  if (sport === 'bike' && s.np_w !== undefined) return s.np_w / hr;
  return undefined;
}

/** Grade adjusted efficiency factor (running only): GAP in m/min per beat. */
export function efficiencyFactorGap(sport: SportGroup, avgHr: number | undefined, gapMps: number | undefined): number | undefined {
  if (sport !== 'run' || gapMps === undefined || avgHr === undefined || !(avgHr > 0)) return undefined;
  return (gapMps * 60) / avgHr;
}

/** Three-zone (Seiler) zone of a session from its average HR: below LT1 → 1, below LTHR → 2, else 3. */
export function seilerZoneByHr(avgHr: number, lt1: number, lthr: number): 1 | 2 | 3 {
  if (avgHr < lt1) return 1;
  return avgHr < lthr ? 2 : 3;
}

/** Thresholds context for `sessionMetrics`. */
export interface SessionContext {
  /** Threshold history rows (any order; rows of one date keep their order). */
  thresholds: readonly ThresholdPoint[];
  /** Daily resting HR for the 28-day rolling mean. */
  daily: readonly { date: IsoDate; resting_hr: number | null }[];
}

/** Optional note sink: each default or approximation used is reported once. */
export type NoteSink = (note: string) => void;

/**
 * Metrics of one session with the thresholds valid on its date (LTHR of its sport, rolling
 * resting HR). Rounding: IF, EF, EF-GAP, GAP 3 places; hrTSS, Garmin load, TE, RHR 1 place;
 * durations, distances, HR, power, cadence, calories whole numbers.
 */
export function sessionMetrics(input: SessionInput, ctx: SessionContext, onNote?: NoteSink): Session {
  const sport = sportGroup(input.type);
  const lthr = lthrFor(ctx.thresholds, sport, input.date);
  const rhr = restingHrOn(ctx.daily, ctx.thresholds, input.date);
  if (lthr.note) onNote?.(lthr.note);
  if (rhr.note) onNote?.(rhr.note);
  const ifValue = intensityFactor(input.avg_hr, rhr.value, lthr.value);
  const z = input.zones_s;
  return {
    id: input.id,
    date: input.date,
    week: isoWeek(input.date),
    start_local: input.start_local,
    type: input.type,
    sport,
    name: input.name,
    event_type: input.event_type,
    duration_s: round(input.duration_s, 0),
    moving_s: round(input.moving_s, 0),
    distance_m: round(input.distance_m, 0),
    elev_gain_m: round(input.elev_gain_m, 0),
    elev_loss_m: round(input.elev_loss_m, 0),
    avg_hr: round(input.avg_hr, 0),
    max_hr: round(input.max_hr, 0),
    avg_power_w: round(input.avg_power_w, 0),
    np_w: round(input.np_w, 0),
    avg_cadence: round(input.avg_cadence, 0),
    calories: round(input.calories, 0),
    g_load: round(input.g_load, 1),
    aerobic_te: round(input.aerobic_te, 1),
    anaerobic_te: round(input.anaerobic_te, 1),
    rpe: input.rpe,
    feel: input.feel,
    if: round(ifValue, 3) ?? 0,
    hrtss: round(hrTss(input.duration_s, ifValue), 1) ?? 0,
    ef: round(efficiencyFactor(sport, input), 3),
    ef_gap: round(efficiencyFactorGap(sport, input.avg_hr, input.gap_mps), 3),
    gap_mps: round(input.gap_mps, 3),
    z1_s: round(z?.[0], 0),
    z2_s: round(z?.[1], 0),
    z3_s: round(z?.[2], 0),
    z4_s: round(z?.[3], 0),
    z5_s: round(z?.[4], 0),
    lthr_used: lthr.value,
    rhr_used: round(rhr.value, 1) ?? rhr.value,
    source: input.source,
  };
}

/** `sessionMetrics` for many inputs, sorted by date and start time; notes deduplicated. */
export function buildSessions(inputs: readonly SessionInput[], ctx: SessionContext): { sessions: Session[]; notes: string[] } {
  const notes = new Set<string>();
  const sessions = inputs
    .map((i) => sessionMetrics(i, ctx, (n) => notes.add(n)))
    .toSorted((a, b) => a.date.localeCompare(b.date) || (a.start_local ?? '').localeCompare(b.start_local ?? ''));
  return { sessions, notes: [...notes] };
}
