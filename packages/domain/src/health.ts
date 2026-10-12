import { isoWeek, startOfWeek, type IsoDate } from 'garmin-mcp-config';
import type { DailyRows } from 'garmin-mcp-store';
import { hours, round } from './format.js';
import { mean, sum, trend, type Trend } from './stats.js';

export const HEALTH_METRICS = [
  'steps',
  'resting_hr',
  'hrv',
  'sleep',
  'stress',
  'body_battery',
  'respiration',
  'spo2',
  'intensity_minutes',
  'calories',
  'floors',
] as const;
export type HealthMetric = (typeof HEALTH_METRICS)[number];

export interface HealthRows {
  daily: DailyRows['daily_summary'][];
  sleep: DailyRows['sleep'][];
  hrv: DailyRows['hrv'][];
}

/** Which tables a metric needs. */
export function tablesFor(metrics: readonly HealthMetric[]): ('daily_summary' | 'sleep' | 'hrv')[] {
  const t = new Set<'daily_summary' | 'sleep' | 'hrv'>();
  for (const m of metrics) t.add(m === 'hrv' ? 'hrv' : m === 'sleep' ? 'sleep' : 'daily_summary');
  return [...t];
}

type Value = number | string | undefined;
type Fields = Record<string, Value>;

/** A numeric field of the raw daily summary JSON (fields without a column). */
function rawNum(raw: unknown, key: string): number | undefined {
  const v = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[key] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Per-day values of one metric, keyed by output field (with unit in the name). */
function dayFields(metric: HealthMetric, d: DailyRows['daily_summary'] | undefined, s: DailyRows['sleep'] | undefined, h: DailyRows['hrv'] | undefined): Fields {
  switch (metric) {
    case 'steps':
      return { steps: d?.steps ?? undefined, distance_km: km(rawNum(d?.raw, 'totalDistanceMeters')) };
    case 'resting_hr':
      return { resting_hr_bpm: d?.resting_hr ?? undefined, hr_min_bpm: rawNum(d?.raw, 'minHeartRate'), hr_max_bpm: rawNum(d?.raw, 'maxHeartRate') };
    case 'hrv':
      return {
        hrv_ms: h?.last_night_avg ?? undefined,
        hrv_status: h?.status?.toLowerCase().replaceAll('_', ' '),
        hrv_baseline_low_ms: h?.baseline_low ?? undefined,
        hrv_baseline_high_ms: h?.baseline_high ?? undefined,
      };
    case 'sleep':
      return { sleep_h: hours(s?.duration_s), sleep_score: s?.score ?? undefined };
    case 'stress':
      return { stress_avg: d?.avg_stress ?? undefined };
    case 'body_battery':
      return { body_battery_high: d?.body_battery_high ?? undefined, body_battery_low: d?.body_battery_low ?? undefined };
    case 'respiration':
      return { respiration_brpm: d?.avg_respiration ?? s?.avg_respiration ?? undefined };
    case 'spo2':
      return { spo2_pct: d?.avg_spo2 ?? s?.avg_spo2 ?? undefined };
    case 'intensity_minutes':
      return { intensity_min: d?.intensity_minutes ?? undefined };
    case 'calories':
      return { calories_total_kcal: d?.total_calories ?? undefined, calories_active_kcal: d?.active_calories ?? undefined };
    case 'floors':
      return { floors: rawNum(d?.raw, 'floorsAscended') };
  }
}

const km = (m: number | undefined): number | undefined => (m === undefined ? undefined : m / 1000);

/** Fields that add up over a week rather than average. */
const SUMMED = new Set(['intensity_min']);
/** Fields rounded to 2 decimals instead of 1. */
const PRECISE = new Set(['sleep_h', 'distance_km']);
/** Primary field per metric, used for the trend. */
const PRIMARY: Record<HealthMetric, string> = {
  steps: 'steps',
  resting_hr: 'resting_hr_bpm',
  hrv: 'hrv_ms',
  sleep: 'sleep_h',
  stress: 'stress_avg',
  body_battery: 'body_battery_high',
  respiration: 'respiration_brpm',
  spo2: 'spo2_pct',
  intensity_minutes: 'intensity_min',
  calories: 'calories_total_kcal',
  floors: 'floors',
};

export interface MetricSummary {
  avg?: number;
  min?: number;
  max?: number;
  total?: number;
  days_with_data: number;
  trend?: Trend;
}

export interface HealthTable {
  granularity: 'day' | 'week';
  rows: Record<string, string | number | undefined>[];
  summary: Partial<Record<HealthMetric, MetricSummary>>;
}

/**
 * Day or week × metric table plus per-metric average, range and trend
 * (`query_health`). `trendRows` may extend before `from` so 28-day baselines exist.
 */
export function healthTable(
  metrics: readonly HealthMetric[],
  rows: HealthRows,
  from: IsoDate,
  to: IsoDate,
  granularity: 'day' | 'week',
  trendRows: HealthRows = rows,
): HealthTable {
  const index = <T extends { date: string }>(xs: T[]) => new Map(xs.map((x) => [x.date, x]));
  const build = (src: HealthRows) => {
    const [d, s, h] = [index(src.daily), index(src.sleep), index(src.hrv)];
    const dates = [...new Set([...d.keys(), ...s.keys(), ...h.keys()])].toSorted();
    return dates.map((date) => {
      const out: Fields = {};
      for (const m of metrics) Object.assign(out, dayFields(m, d.get(date), s.get(date), h.get(date)));
      return { date, fields: out };
    });
  };

  const days = build(rows).filter((r) => r.date >= from && r.date <= to);
  const history = build(trendRows);

  let tableRows: Record<string, string | number | undefined>[];
  if (granularity === 'day') {
    tableRows = days.map((r) => ({ date: r.date, ...roundAll(r.fields) }));
  } else {
    const weeks = new Map<string, { start: string; items: Fields[] }>();
    for (const r of days) {
      const key = isoWeek(r.date);
      const w = weeks.get(key) ?? { start: startOfWeek(r.date), items: [] };
      w.items.push(r.fields);
      weeks.set(key, w);
    }
    tableRows = [...weeks.entries()].map(([week, w]) => {
      const fields = new Set(w.items.flatMap((i) => Object.keys(i)));
      const out: Record<string, string | number | undefined> = { week, week_start: w.start, days: w.items.length };
      for (const f of fields) {
        const values = w.items.map((i) => i[f]);
        if (values.some((v) => typeof v === 'string')) {
          // Categorical fields (HRV status): the state at the end of the week.
          out[`${f}_last`] = values.findLast((v) => v !== undefined);
          continue;
        }
        const nums = values as (number | undefined)[];
        out[SUMMED.has(f) ? `${f}_total` : `${f}_avg`] = round(SUMMED.has(f) ? sum(nums) : mean(nums), PRECISE.has(f) ? 2 : 1);
      }
      return out;
    });
  }

  const summary: HealthTable['summary'] = {};
  for (const m of metrics) {
    const f = PRIMARY[m];
    const values = days.map((r) => r.fields[f]).filter((v): v is number => typeof v === 'number');
    summary[m] = {
      avg: round(mean(values), 1),
      min: values.length ? Math.min(...values) : undefined,
      max: values.length ? Math.max(...values) : undefined,
      total: SUMMED.has(f) || m === 'steps' || m === 'floors' ? round(sum(values), 0) : undefined,
      days_with_data: values.length,
      trend: trend(
        history.map((r) => ({ date: r.date, value: num(r.fields[f]) })),
        to,
        m === 'resting_hr' || m === 'spo2' ? 0.01 : 0.03,
      ),
    };
  }
  return { granularity, rows: tableRows, summary };
}

function roundAll(fields: Fields): Fields {
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, typeof v === 'string' ? v : round(v, PRECISE.has(k) ? 2 : 1)]));
}

const num = (v: Value): number | undefined => (typeof v === 'number' ? v : undefined);
