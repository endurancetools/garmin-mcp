import { isoWeek, type IsoDate } from 'garmin-mcp-config';
import { round } from 'garmin-mcp-domain';
import type { ActivityRow, ImportedActivityRow } from 'garmin-mcp-store';
import { RPE_LOAD_CALIBRATION, type HrMethod } from './load.js';
import { sportGroup, type SportGroup } from './sport.js';
import { lt1For, lthrFor, restingHrOn, thresholdOn, zoneBounds, zoneFloorsFor, type ProfileZoneFloors, type ThresholdPoint } from './thresholds.js';

/** Where the training stress of a session comes from (first positive candidate wins); `none` = no load. */
export type SessionLoadSource = 'power' | 'pace' | 'swim_pace' | 'hr' | 'rpe' | 'none';

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
  /** Perceived effort on Foster's CR-10 scale (1–10); Garmin stores it × 10. */
  rpe?: number;
  feel?: number;
  /** Grade adjusted speed (m/s). */
  gap_mps?: number;
  /** Seconds in HR zones 1–5 from the activity list; absent when Garmin gave none. */
  zones_s?: readonly [number, number, number, number, number];
  /** Laps of the splits detail (`activity_details(kind=splits)`); absent when that detail was not downloaded. */
  laps?: readonly Lap[];
  source: 'db' | 'import';
}

/** One lap of the splits detail: duration (s), average heart rate, grade adjusted speed (m/s) and average power (W). */
export interface Lap {
  duration_s: number;
  avg_hr?: number;
  gap_mps?: number;
  avg_power_w?: number;
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
  /** Training stress of the session from `load_source`, 1 place; absent (never 0) when no candidate is positive. */
  tss?: number;
  /** Intensity factor of `load_source` (NP/FTP, GAP/threshold speed, swim speed/CSS or HR reserve, from zones or the average), 3 places; absent with `rpe` and `none`. */
  if?: number;
  load_source: SessionLoadSource;
  /** The heart-rate candidate (0 without heart rate); `get_load` with `source: "hrtss"` sums it. */
  hrtss: number;
  /** How `hrtss` was computed: `zones` (time in HR zones) or `avg` (average heart rate, also when there is no heart rate). */
  hr_method: HrMethod;
  ef?: number;
  ef_gap?: number;
  gap_mps?: number;
  z1_s?: number;
  z2_s?: number;
  z3_s?: number;
  z4_s?: number;
  z5_s?: number;
  lthr_used: number;
  /** LT1 HR of the sport on the session date (`lt1For`); the aerobic filter of the EF trend. */
  lt1_used: number;
  rhr_used: number;
  /** Aerobic decoupling (Pa:Hr for running, Pw:Hr from power), % (1 place): drop of EF from the first to the second half; see {@link decoupling}. */
  decoupling_pct?: number;
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

/** Laps from the splits detail (`lapDTOs`); laps without a positive duration are dropped. `undefined` without the detail. */
export function lapsFrom(splitsRaw: unknown): Lap[] | undefined {
  const dtos = obj(splitsRaw)?.['lapDTOs'];
  if (!Array.isArray(dtos)) return undefined;
  return dtos.flatMap((d: unknown) => {
    const l = obj(d);
    const duration = num(l?.['duration']);
    if (duration === undefined || !(duration > 0)) return [];
    return [{ duration_s: duration, avg_hr: num(l?.['averageHR']), gap_mps: num(l?.['avgGradeAdjustedSpeed']), avg_power_w: num(l?.['averagePower']) }];
  });
}

/**
 * Session input from a stored activity: columns, plus `normPower`, `avgGradeAdjustedSpeed`,
 * `hrTimeInZone_N`, cadence, moving time, elevation loss and event type from the activity
 * list entry, and RPE/feel from the summary detail (`activity_details(kind=summary).raw`) when
 * given: `summaryDTO.directWorkoutRpe/Feel`, which `get_activity` and `update_activity` use,
 * else `metadataDTO.workoutRpe/Feel`. Garmin's RPE 10–100 becomes CR-10 (/10). Laps from the
 * splits detail when given ({@link lapsFrom}). `undefined` for a row without a date.
 */
export function sessionFromActivity(a: ActivityRow, summaryRaw?: unknown, splitsRaw?: unknown): SessionInput | undefined {
  if (!a.date) return undefined;
  const raw = obj(a.raw);
  const summary = obj(obj(summaryRaw)?.['summaryDTO']);
  const meta = obj(obj(summaryRaw)?.['metadataDTO']);
  const rpe10 = num(summary?.['directWorkoutRpe']) ?? num(meta?.['workoutRpe']);
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
    rpe: rpe10 === undefined ? undefined : rpe10 / 10,
    feel: num(summary?.['directWorkoutFeel']) ?? num(meta?.['workoutFeel']),
    gap_mps: num(raw?.['avgGradeAdjustedSpeed']),
    zones_s: zonesFrom(raw),
    laps: lapsFrom(splitsRaw),
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
 * Zone-based heart-rate candidate (TrainingPeaks' hrTSS from the time in zones derived from
 * LTHR; Friel's estimate of TSS per hour in each zone): with `midHR_z` the middle of Garmin
 * zone z (zone 5 up to HRmax), `IF_z = (midHR_z − RHR) / (LTHR − RHR)` (0 at or below RHR) and
 * `hrTSS = Σ_z (t_z / 3600) × IF_z² × 100`. The returned IF is √(Σ t_z × IF_z² / Σ t_z), the IF
 * of a steady effort with the same stress per hour in zones. `undefined` without time in zones,
 * without bounds, or when LTHR ≤ RHR.
 */
export function hrZonesCandidate(
  zonesS: readonly number[] | undefined,
  bounds: readonly (readonly [number, number])[] | undefined,
  rhr: number,
  lthr: number,
): LoadCandidate | undefined {
  if (!zonesS || !bounds || bounds.length < zonesS.length || !(lthr > rhr)) return undefined;
  let time = 0;
  let weighted = 0;
  zonesS.forEach((t, i) => {
    const [lo, hi] = bounds[i] ?? [0, 0];
    if (!(t > 0)) return;
    const ifZone = Math.max(0, ((lo + hi) / 2 - rhr) / (lthr - rhr));
    time += t;
    weighted += t * ifZone * ifZone;
  });
  if (!(time > 0)) return undefined;
  return { source: 'hr', tss: (weighted / 3600) * 100, if: Math.sqrt(weighted / time) };
}

/** One load candidate: stress in the scale where an hour at threshold is 100, and its intensity factor (both unrounded; no IF for `rpe`). */
export interface LoadCandidate {
  source: Exclude<SessionLoadSource, 'none'>;
  tss: number;
  if?: number;
}

/** Stress of a session at a constant intensity factor: hours × IF² × 100 (TSS, rTSS and hrTSS alike). */
const stress = (durationS: number, ifValue: number): number => (durationS / 3600) * ifValue * ifValue * 100;

/** Power candidate (Coggan): IF = NP / FTP, TSS = h × IF² × 100; `undefined` without NP, FTP or duration. */
export function powerCandidate(npW: number | undefined, ftpW: number | undefined, durationS: number | undefined): LoadCandidate | undefined {
  if (!(npW !== undefined && npW > 0 && ftpW !== undefined && ftpW > 0 && durationS !== undefined && durationS > 0)) return undefined;
  const ifValue = npW / ftpW;
  return { source: 'power', tss: stress(durationS, ifValue), if: ifValue };
}

/**
 * Pace candidate (McGregor's rTSS on Garmin's average grade adjusted speed, not a normalized
 * graded pace): IF = GAP / (1000 / threshold pace), rTSS = h × IF² × 100; `undefined` without
 * GAP, threshold pace or duration.
 */
export function paceCandidate(gapMps: number | undefined, thresholdPaceSPerKm: number | undefined, durationS: number | undefined): LoadCandidate | undefined {
  if (!(gapMps !== undefined && gapMps > 0 && thresholdPaceSPerKm !== undefined && thresholdPaceSPerKm > 0 && durationS !== undefined && durationS > 0)) {
    return undefined;
  }
  const ifValue = gapMps / (1000 / thresholdPaceSPerKm);
  return { source: 'pace', tss: stress(durationS, ifValue), if: ifValue };
}

/**
 * Swim pace candidate (TrainingPeaks' sTSS): IF = (distance / moving time) / (100 / CSS),
 * sTSS = moving hours × IF³ × 100; the cube, not the square, because the cost of swimming rises
 * faster with speed (water drag) than that of running. `undefined` without distance, moving
 * time or CSS (s per 100 m).
 */
export function swimPaceCandidate(distanceM: number | undefined, movingS: number | undefined, cssSPer100m: number | undefined): LoadCandidate | undefined {
  if (!(distanceM !== undefined && distanceM > 0 && movingS !== undefined && movingS > 0 && cssSPer100m !== undefined && cssSPer100m > 0)) return undefined;
  const ifValue = distanceM / movingS / (100 / cssSPer100m);
  return { source: 'swim_pace', tss: (movingS / 3600) * ifValue ** 3 * 100, if: ifValue };
}

/** Foster's CR-10 scale of session RPE. */
const RPE_MIN = 1;
const RPE_MAX = 10;

/**
 * Session RPE candidate (Foster): stress = RPE (CR-10) × minutes × `calibration`, the
 * calibration bringing it to the scale where an hour at threshold is 100 (an approximation);
 * no intensity factor. `undefined` with an RPE outside 1–10 (an entry error, not an effort)
 * or without duration.
 */
export function rpeCandidate(rpe: number | undefined, durationS: number | undefined, calibration: number = RPE_LOAD_CALIBRATION): LoadCandidate | undefined {
  if (!(rpe !== undefined && rpe >= RPE_MIN && rpe <= RPE_MAX && durationS !== undefined && durationS > 0)) return undefined;
  return { source: 'rpe', tss: rpe * (durationS / 60) * calibration };
}

/** The resolved load of a session: rounded `tss` and `if` of the winning candidate, or `none`. */
export interface ResolvedLoad {
  tss?: number;
  if?: number;
  load_source: SessionLoadSource;
}

/**
 * The first candidate whose stress, rounded to 0.1, is a positive finite number: TSS 1 place,
 * IF 3 places. Zero, negative and NaN are no load, so a power meter that read 0 does not hide
 * the heart-rate stress of the ride; with no candidate left the load is absent, never 0.
 */
export function resolveLoad(candidates: readonly (LoadCandidate | undefined)[]): ResolvedLoad {
  for (const c of candidates) {
    const tss = c && Number.isFinite(c.tss) ? round(c.tss, 1) : undefined;
    if (c && tss !== undefined && tss > 0) return { tss, if: round(c.if, 3), load_source: c.source };
  }
  return { load_source: 'none' };
}

/**
 * Grade adjusted speed of a hike: Garmin's GAP when the hike also has a distance and an
 * elevation gain (the inputs of GAP), else `undefined` (the hike stays out of EF).
 */
export function hikeGap(s: Pick<SessionInput, 'distance_m' | 'elev_gain_m' | 'gap_mps'>): number | undefined {
  const ok = (s.distance_m ?? 0) > 0 && s.elev_gain_m !== undefined && s.gap_mps !== undefined && s.gap_mps > 0;
  return ok ? s.gap_mps : undefined;
}

/**
 * Efficiency factor: running speed in m/min per beat, cycling normalized power per beat,
 * hiking grade adjusted speed in m/min per beat ({@link hikeGap});
 * `undefined` for other sports or missing inputs.
 */
export function efficiencyFactor(
  sport: SportGroup,
  s: Pick<SessionInput, 'avg_hr' | 'duration_s' | 'distance_m' | 'np_w' | 'elev_gain_m' | 'gap_mps'>,
): number | undefined {
  const hr = s.avg_hr;
  if (hr === undefined || !(hr > 0)) return undefined;
  if (sport === 'run') {
    const dur = s.duration_s ?? 0;
    const dist = s.distance_m ?? 0;
    return dur > 0 && dist > 0 ? ((dist / dur) * 60) / hr : undefined;
  }
  if (sport === 'bike' && s.np_w !== undefined) return s.np_w / hr;
  if (sport === 'hike') {
    const gap = hikeGap(s);
    return gap === undefined ? undefined : (gap * 60) / hr;
  }
  return undefined;
}

/** Grade adjusted efficiency factor (running and hiking): GAP in m/min per beat; for a hike pass {@link hikeGap}. */
export function efficiencyFactorGap(sport: SportGroup, avgHr: number | undefined, gapMps: number | undefined): number | undefined {
  if ((sport !== 'run' && sport !== 'hike') || gapMps === undefined || avgHr === undefined || !(avgHr > 0)) return undefined;
  return (gapMps * 60) / avgHr;
}

/** Decoupling only for sessions at least this long (s). */
export const DECOUPLING_MIN_DURATION_S = 3600;
/** … with at least this many laps, so that the two halves differ by more than one straddling lap. */
export const DECOUPLING_MIN_LAPS = 4;
/** Output of the EF of each sport group with decoupling: grade adjusted speed for running, average power for the others. */
export const DECOUPLING_METRIC: Partial<Record<SportGroup, 'gap_mps' | 'avg_power_w'>> = { run: 'gap_mps', bike: 'avg_power_w', nordic: 'avg_power_w', row: 'avg_power_w' };

/** Whether a session qualifies for decoupling, laps aside: a sport with a metric, at least 60 min, average HR below LTHR. */
export function decouplingEligible(s: Pick<Session, 'sport' | 'duration_s' | 'avg_hr' | 'lthr_used'>): boolean {
  return DECOUPLING_METRIC[s.sport] !== undefined && (s.duration_s ?? 0) >= DECOUPLING_MIN_DURATION_S && s.avg_hr !== undefined && s.avg_hr < s.lthr_used;
}

/** Weighted sums of one half: time, time × HR, time × metric. */
interface Half {
  t: number;
  hr: number;
  out: number;
}

/**
 * Aerobic decoupling (Pa:Hr, Pw:Hr) from laps: the laps laid end to end are cut at half of
 * their total time (a lap across the middle counts in both halves by its share of time), and
 * each half gets EF = time-weighted mean of `metric` / time-weighted mean HR over its laps that
 * have both (positive); result `(EF1 − EF2) / EF1 × 100`. Positive = less output per beat in
 * the second half (cardiac drift). `undefined` with fewer than {@link DECOUPLING_MIN_LAPS} laps
 * or a half without a lap that has both values.
 */
export function decoupling(laps: readonly Lap[], metric: 'gap_mps' | 'avg_power_w'): number | undefined {
  if (laps.length < DECOUPLING_MIN_LAPS) return undefined;
  const mid = laps.reduce((t, l) => t + l.duration_s, 0) / 2;
  const halves: [Half, Half] = [
    { t: 0, hr: 0, out: 0 },
    { t: 0, hr: 0, out: 0 },
  ];
  let start = 0;
  for (const l of laps) {
    const first = Math.min(Math.max(mid - start, 0), l.duration_s);
    start += l.duration_s;
    const hr = l.avg_hr;
    const out = l[metric];
    if (hr === undefined || !(hr > 0) || out === undefined || !(out > 0)) continue;
    [first, l.duration_s - first].forEach((t, i) => {
      const h = halves[i === 0 ? 0 : 1];
      h.t += t;
      h.hr += t * hr;
      h.out += t * out;
    });
  }
  const [a, b] = halves;
  if (!(a.t > 0 && b.t > 0)) return undefined;
  const ef1 = a.out / a.hr;
  const ef2 = b.out / b.hr;
  return ((ef1 - ef2) / ef1) * 100;
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
  /** Multiplier of the session RPE candidate; default {@link RPE_LOAD_CALIBRATION}. */
  rpe_calibration?: number;
  /** HR zone bounds of the Garmin profile, for the zone-based heart-rate candidate. */
  floors?: ProfileZoneFloors;
  /** `zones` (default): heart-rate candidate from the time in zones when the session has zones and the profile bounds; `avg`: always from the average heart rate. */
  hr_method?: HrMethod;
}

/** Optional note sink: each default or approximation used is reported once. */
export type NoteSink = (note: string) => void;

export const NO_FTP_NOTE = 'Cycling activities with normalized power but no ftp_w in the threshold history use hrTSS; record FTP with set_threshold.';
export const NO_THRESHOLD_PACE_NOTE =
  'Running activities with a grade adjusted speed but no run_threshold_pace_s_per_km in the threshold history use hrTSS; record the threshold pace with set_threshold.';
export const NO_CSS_NOTE =
  'Swims with distance and moving time but no css_s_per_100m in the threshold history use hrTSS; record the critical swim speed with set_threshold.';

/**
 * Metrics of one session with the thresholds valid on its date (LTHR, LT1, FTP and threshold
 * pace or CSS of its sport, rolling resting HR). Load candidates in order: `power` (bike with NP
 * and `ftp_w`), `pace` (run with GAP and `run_threshold_pace_s_per_km`), `swim_pace` (swim with
 * distance, moving time and `css_s_per_100m`), `hr` (hrTSS from the time
 * in zones with the profile's zone bounds, else from the average HR; `hr_method`), `rpe`
 * (session RPE, any sport); the first positive one gives `tss`, `if` and `load_source`. LT1 notes are not reported: `get_load`
 * takes them from `thresholds_used`. `decoupling_pct` from the laps ({@link decoupling}) for
 * {@link decouplingEligible} sessions. Rounding: IF, EF, EF-GAP, GAP 3 places; TSS, hrTSS,
 * Garmin load, TE, RHR 1 place; durations, distances, HR, power, cadence, calories whole numbers.
 */
export function sessionMetrics(input: SessionInput, ctx: SessionContext, onNote?: NoteSink): Session {
  const sport = sportGroup(input.type);
  const lthr = lthrFor(ctx.thresholds, sport, input.date);
  const lt1 = lt1For(ctx.thresholds, sport, input.date);
  const rhr = restingHrOn(ctx.daily, ctx.thresholds, input.date);
  if (lthr.note) onNote?.(lthr.note);
  if (rhr.note) onNote?.(rhr.note);
  const bounds = (ctx.hr_method ?? 'zones') === 'zones' ? zoneFloorsFor(ctx.floors ?? {}, sport) : undefined;
  const hrZones = bounds ? hrZonesCandidate(input.zones_s, zoneBounds(bounds), rhr.value, lthr.value) : undefined;
  const hrAvgIf = intensityFactor(input.avg_hr, rhr.value, lthr.value);
  const hr: LoadCandidate = hrZones ?? { source: 'hr', tss: hrTss(input.duration_s, hrAvgIf), if: hrAvgIf };
  const ftp = sport === 'bike' ? thresholdOn(ctx.thresholds, 'ftp_w', input.date) : undefined;
  const pace = sport === 'run' ? thresholdOn(ctx.thresholds, 'run_threshold_pace_s_per_km', input.date) : undefined;
  if (sport === 'bike' && ftp === undefined && input.np_w !== undefined && input.np_w > 0) onNote?.(NO_FTP_NOTE);
  if (sport === 'run' && pace === undefined && input.gap_mps !== undefined && input.gap_mps > 0) onNote?.(NO_THRESHOLD_PACE_NOTE);
  const css = sport === 'swim' ? thresholdOn(ctx.thresholds, 'css_s_per_100m', input.date) : undefined;
  if (sport === 'swim' && css === undefined && (input.distance_m ?? 0) > 0 && (input.moving_s ?? 0) > 0) onNote?.(NO_CSS_NOTE);
  const load = resolveLoad([
    sport === 'bike' ? powerCandidate(input.np_w, ftp, input.duration_s) : undefined,
    sport === 'run' ? paceCandidate(input.gap_mps, pace, input.duration_s) : undefined,
    sport === 'swim' ? swimPaceCandidate(input.distance_m, input.moving_s, css) : undefined,
    hr,
    rpeCandidate(input.rpe, input.duration_s, ctx.rpe_calibration),
  ]);
  const z = input.zones_s;
  const decMetric = DECOUPLING_METRIC[sport];
  const decOk = input.laps && decMetric && decouplingEligible({ sport, duration_s: input.duration_s, avg_hr: input.avg_hr, lthr_used: lthr.value });
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
    tss: load.tss,
    if: load.if,
    load_source: load.load_source,
    hrtss: round(hr.tss, 1) ?? 0,
    hr_method: hrZones ? 'zones' : 'avg',
    ef: round(efficiencyFactor(sport, input), 3),
    ef_gap: round(efficiencyFactorGap(sport, input.avg_hr, sport === 'hike' ? hikeGap(input) : input.gap_mps), 3),
    gap_mps: round(input.gap_mps, 3),
    z1_s: round(z?.[0], 0),
    z2_s: round(z?.[1], 0),
    z3_s: round(z?.[2], 0),
    z4_s: round(z?.[3], 0),
    z5_s: round(z?.[4], 0),
    lthr_used: lthr.value,
    lt1_used: lt1.value,
    rhr_used: round(rhr.value, 1) ?? rhr.value,
    decoupling_pct: decOk ? round(decoupling(input.laps ?? [], decMetric), 1) : undefined,
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
