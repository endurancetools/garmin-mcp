import type { DailyRows } from 'garmin-mcp-store';
import { compact, hms, hours, round } from './format.js';
import { mean } from './stats.js';

type SleepRow = DailyRows['sleep'];

export interface SleepNight {
  date: string;
  start_utc?: string;
  end_utc?: string;
  duration?: string;
  duration_h?: number;
  score?: number;
  quality?: string;
  stages_h?: { deep?: number; light?: number; rem?: number; awake?: number };
  stages_pct?: { deep?: number; light?: number; rem?: number };
  avg_spo2_pct?: number;
  avg_respiration_brpm?: number;
  avg_overnight_hrv_ms?: number;
  resting_hr_bpm?: number;
  body_battery_change?: number;
}

function rawOf(row: SleepRow): Record<string, unknown> {
  return (row.raw && typeof row.raw === 'object' ? row.raw : {}) as Record<string, unknown>;
}

export function sleepNight(row: SleepRow): SleepNight {
  const raw = rawOf(row);
  const dto = (raw.dailySleepDTO ?? {}) as Record<string, unknown>;
  const scores = (dto.sleepScores ?? {}) as { overall?: { qualifierKey?: string } };
  const total = row.duration_s ?? 0;
  const pct = (v: number | null) => (total > 0 && v !== null ? round((v / total) * 100, 0) : undefined);
  const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
  return {
    date: row.date,
    start_utc: row.start_utc ?? undefined,
    end_utc: row.end_utc ?? undefined,
    duration: hms(row.duration_s),
    duration_h: hours(row.duration_s),
    score: row.score ?? undefined,
    quality: scores.overall?.qualifierKey?.toLowerCase(),
    stages_h: { deep: hours(row.deep_s), light: hours(row.light_s), rem: hours(row.rem_s), awake: hours(row.awake_s) },
    stages_pct: { deep: pct(row.deep_s), light: pct(row.light_s), rem: pct(row.rem_s) },
    avg_spo2_pct: row.avg_spo2 ?? undefined,
    avg_respiration_brpm: row.avg_respiration ?? undefined,
    avg_overnight_hrv_ms: num(raw.avgOvernightHrv),
    resting_hr_bpm: num(raw.restingHeartRate),
    body_battery_change: num(raw.bodyBatteryChange),
  };
}

/** At most this many stage segments; shorter ones are merged into their neighbours above it. */
export const MAX_STAGE_SEGMENTS = 60;

/** `sleepLevels[].activityLevel` → stage. */
const STAGES: Record<number, SleepStage> = { 0: 'deep', 1: 'light', 2: 'rem', 3: 'awake' };

export type SleepStage = 'deep' | 'light' | 'rem' | 'awake';

export interface SleepTimeline {
  stages?: { from: string; to: string; stage: SleepStage }[];
  awakenings?: { count: number; longest_min?: number; longest_at?: string; at?: string[] };
  restless_moments?: number;
  min_hr?: { bpm: number; at: string };
  hrv?: { min_ms: number; min_at: string; max_ms: number; max_at: string };
  lowest_spo2?: { pct: number; at?: string };
  body_battery?: { start: number; end: number };
}

type Obj = Record<string, unknown>;

const objOf = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);
const listOf = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(objOf).filter((o): o is Obj => o !== undefined) : []);
const numOf = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Garmin's GMT instants: epoch ms, or "2026-10-09T21:13:30.0" without a zone. */
function gmtMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string' || v.length < 16) return undefined;
  const ms = Date.parse(`${v.slice(0, 19).replace(' ', 'T')}Z`);
  return Number.isNaN(ms) ? undefined : ms;
}

/** `[{ value, <time key> }]` → points with a numeric value, in time order. */
function series(v: unknown, valueKey: string, timeKey: string): { ms: number; value: number }[] {
  return listOf(v)
    .map((p) => ({ ms: gmtMs(p[timeKey]), value: numOf(p[valueKey]) }))
    .filter((p): p is { ms: number; value: number } => p.ms !== undefined && p.value !== undefined && p.value >= 0)
    .toSorted((a, b) => a.ms - b.ms);
}

/** First point with the lowest (or highest) value. */
function extreme(points: readonly { ms: number; value: number }[], pick: 'min' | 'max') {
  let best: { ms: number; value: number } | undefined;
  for (const p of points) if (!best || (pick === 'min' ? p.value < best.value : p.value > best.value)) best = p;
  return best;
}

interface Segment {
  start: number;
  end: number;
  stage: SleepStage;
}

function coalesce(segments: readonly Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segments) {
    const last = out.at(-1);
    if (last && last.stage === s.stage && s.start - last.end <= 60_000) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

const length = (s: Segment) => s.end - s.start;

/** Joins the shortest segment with its longer neighbour until at most `max` remain. */
function mergeTo(segments: readonly Segment[], max: number): Segment[] {
  let out = coalesce(segments);
  while (out.length > max) {
    let i = 0;
    for (let j = 1; j < out.length; j++) if (length(out[j] as Segment) < length(out[i] as Segment)) i = j;
    const prev = out[i - 1];
    const next = out[i + 1];
    const n = !prev || (next && length(next) > length(prev)) ? i + 1 : i - 1;
    const a = Math.min(i, n);
    const joined = { start: (out[a] as Segment).start, end: (out[a + 1] as Segment).end, stage: (out[n] as Segment).stage };
    out = coalesce([...out.slice(0, a), joined, ...out.slice(a + 2)]);
  }
  return out;
}

/**
 * The course of one night from the raw sleep JSON (and the night's HRV readings, when the
 * `hrv` table has them), without further requests. Clock times are "HH:MM" in `timeZone`.
 */
export function sleepTimeline(sleepRaw: unknown, hrvRaw: unknown, timeZone: string): SleepTimeline | undefined {
  const raw = objOf(sleepRaw) ?? {};
  const clockFmt = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const clock = (ms: number) => clockFmt.format(new Date(ms));

  const levels = listOf(raw.sleepLevels)
    .map((l) => ({ start: gmtMs(l.startGMT), end: gmtMs(l.endGMT), stage: STAGES[Math.round(numOf(l.activityLevel) ?? -1)] }))
    .filter((s): s is Segment => s.start !== undefined && s.end !== undefined && s.stage !== undefined && s.end > s.start)
    .toSorted((a, b) => a.start - b.start);
  const awake = coalesce(levels).filter((s) => s.stage === 'awake');
  const longest = awake.reduce<Segment | undefined>((a, s) => (!a || s.end - s.start > a.end - a.start ? s : a), undefined);

  const restlessList = listOf(raw.sleepRestlessMoments);
  const restless = numOf(raw.restlessMomentsCount) ?? (restlessList.length > 0 ? restlessList.reduce((a, m) => a + (numOf(m.value) ?? 1), 0) : undefined);

  const minHr = extreme(series(raw.sleepHeartRate, 'value', 'startGMT'), 'min');
  const hrvReadings = series(objOf(hrvRaw)?.hrvReadings, 'hrvValue', 'readingTimeGMT');
  const hrv = hrvReadings.length > 0 ? hrvReadings : series(raw.hrvData, 'value', 'startGMT');
  const hrvMin = extreme(hrv, 'min');
  const hrvMax = extreme(hrv, 'max');
  // Shape not confirmed by a recording (the recorded account has no Pulse Ox during sleep).
  const spo2 = extreme(
    series(raw.wellnessSpO2SleepDataDTOList, 'spo2Reading', 'epochTimestamp').filter((p) => p.value > 0),
    'min',
  );
  const spo2Lowest = numOf(objOf(raw.dailySleepDTO)?.lowestSpO2Value);
  const battery = series(raw.sleepBodyBattery, 'value', 'startGMT');

  const timeline: SleepTimeline = {
    stages: mergeTo(levels, MAX_STAGE_SEGMENTS).map((s) => ({ from: clock(s.start), to: clock(s.end), stage: s.stage })),
    awakenings:
      levels.length > 0
        ? {
            count: awake.length,
            longest_min: longest && round((longest.end - longest.start) / 60_000, 0),
            longest_at: longest && clock(longest.start),
            at: awake.map((s) => clock(s.start)),
          }
        : undefined,
    restless_moments: restless,
    min_hr: minHr && { bpm: minHr.value, at: clock(minHr.ms) },
    hrv: hrvMin && hrvMax && { min_ms: hrvMin.value, min_at: clock(hrvMin.ms), max_ms: hrvMax.value, max_at: clock(hrvMax.ms) },
    lowest_spo2: spo2 ? { pct: spo2.value, at: clock(spo2.ms) } : spo2Lowest !== undefined && spo2Lowest > 0 ? { pct: spo2Lowest } : undefined,
    body_battery: battery[0] && { start: battery[0].value, end: (battery.at(-1) ?? battery[0]).value },
  };
  const out = compact(timeline);
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * One night in one line, e.g. "23:13-06:48, 7 h 22 min, score 79 (fair), deep 0.8 h, REM 1.6 h,
 * awake 0.2 h, 1 awakening, HRV 34 ms, resting HR 56 bpm"; clock times in `timeZone`, parts
 * without a value left out. Undefined for a row without sleep. Read from the row alone.
 */
export function sleepLine(row: SleepRow, timeZone: string): string | undefined {
  if (!row.duration_s) return undefined;
  const night = sleepNight(row);
  const awakenings = sleepTimeline(row.raw, undefined, timeZone)?.awakenings?.count;
  const clockFmt = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const clock = (utc: string | undefined) => {
    const ms = utc === undefined ? Number.NaN : Date.parse(utc);
    return Number.isNaN(ms) ? undefined : clockFmt.format(new Date(ms));
  };
  const start = clock(night.start_utc);
  const end = clock(night.end_utc);
  const minutes = Math.round(row.duration_s / 60);
  const h = (v: number | undefined, label: string) => (v === undefined ? undefined : `${label} ${round(v, 1)} h`);
  const parts = [
    start && end ? `${start}-${end}` : undefined,
    `${Math.floor(minutes / 60)} h ${minutes % 60} min`,
    night.score !== undefined ? `score ${night.score}${night.quality ? ` (${night.quality})` : ''}` : undefined,
    h(night.stages_h?.deep, 'deep'),
    h(night.stages_h?.rem, 'REM'),
    h(night.stages_h?.awake, 'awake'),
    awakenings !== undefined ? `${awakenings} awakening${awakenings === 1 ? '' : 's'}` : undefined,
    night.avg_overnight_hrv_ms !== undefined ? `HRV ${round(night.avg_overnight_hrv_ms, 0)} ms` : undefined,
    night.resting_hr_bpm !== undefined ? `resting HR ${night.resting_hr_bpm} bpm` : undefined,
  ];
  return parts.filter((p): p is string => p !== undefined).join(', ');
}

export interface SleepRangeSummary {
  nights: number;
  avg_duration_h?: number;
  avg_score?: number;
  avg_deep_h?: number;
  avg_rem_h?: number;
  best_night?: { date: string; score?: number };
  worst_night?: { date: string; score?: number };
  short_nights_under_6h: number;
}

export function sleepRange(rows: readonly SleepRow[]): { summary: SleepRangeSummary; nights: SleepNight[] } {
  const withSleep = rows.filter((r) => (r.duration_s ?? 0) > 0);
  const scored = withSleep.filter((r) => r.score !== null).toSorted((a, b) => (a.score ?? 0) - (b.score ?? 0));
  return {
    summary: {
      nights: withSleep.length,
      avg_duration_h: hours(mean(withSleep.map((r) => r.duration_s))),
      avg_score: round(mean(withSleep.map((r) => r.score)), 0),
      avg_deep_h: hours(mean(withSleep.map((r) => r.deep_s))),
      avg_rem_h: hours(mean(withSleep.map((r) => r.rem_s))),
      best_night: scored.at(-1) && { date: (scored.at(-1) as SleepRow).date, score: (scored.at(-1) as SleepRow).score ?? undefined },
      worst_night: scored[0] && { date: scored[0].date, score: scored[0].score ?? undefined },
      short_nights_under_6h: withSleep.filter((r) => (r.duration_s ?? 0) < 6 * 3600).length,
    },
    nights: rows.map(sleepNight),
  };
}
