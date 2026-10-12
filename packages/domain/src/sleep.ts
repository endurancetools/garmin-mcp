import type { DailyRows } from 'garmin-mcp-store';
import { hms, hours, round } from './format.js';
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
