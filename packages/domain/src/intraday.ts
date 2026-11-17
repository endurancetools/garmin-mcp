import type { IsoDate } from 'garmin-mcp-config';
import type { IntradayKind, IntradayRow } from 'garmin-mcp-store';
import { hms, round } from './format.js';
import type { HealthMetric } from './health.js';
import { mean } from './stats.js';

/** Health metrics with hourly values, and the intraday series each one reads. */
export const HOURLY_SERIES = {
  resting_hr: ['heart_rate'],
  stress: ['stress'],
  // The stress series carries the Body Battery curve.
  body_battery: ['stress'],
  steps: ['steps'],
  respiration: ['respiration'],
  spo2: ['spo2'],
} as const satisfies Partial<Record<HealthMetric, readonly IntradayKind[]>>;
export type HourlyMetric = keyof typeof HOURLY_SERIES;

export const isHourlyMetric = (m: HealthMetric): m is HourlyMetric => m in HOURLY_SERIES;

/** Metrics whose questions Body Battery events answer ("what drained my Body Battery", "why was I stressed"). */
const EVENT_METRICS: ReadonlySet<HealthMetric> = new Set(['body_battery', 'stress']);

/** The intraday series hourly `metrics` need, Body Battery events included when they explain them. */
export function intradayKinds(metrics: readonly HealthMetric[]): IntradayKind[] {
  const kinds = new Set<IntradayKind>();
  for (const m of metrics) if (isHourlyMetric(m)) for (const k of HOURLY_SERIES[m]) kinds.add(k);
  if (metrics.some((m) => EVENT_METRICS.has(m))) kinds.add('body_battery_events');
  return [...kinds];
}

export interface HourlySummary {
  avg?: number;
  min?: number;
  min_at?: string;
  max?: number;
  max_at?: string;
  total?: number;
  hours_with_data: number;
}

export interface BodyBatteryEvent {
  type: string;
  /** Local "YYYY-MM-DD HH:MM". */
  start: string;
  duration?: string;
  body_battery_impact?: number;
  feedback?: string;
}

export interface HourlyTable {
  rows: Record<string, string | number | undefined>[];
  events: BodyBatteryEvent[];
  summary: Partial<Record<HourlyMetric, HourlySummary>>;
}

type Obj = Record<string, unknown>;
interface Sample {
  t: number;
  v: number;
}

const objOf = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);
const numOf = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Garmin's GMT instants without a zone: "2026-10-09T21:13:30.0". */
function gmtMs(v: unknown): number | undefined {
  if (typeof v !== 'string' || v.length < 16) return undefined;
  const ms = Date.parse(`${v.slice(0, 19).replace(' ', 'T')}Z`);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Column of `key` in Garmin's value descriptors (`[{ index: 1, key: "stressLevel" }]`, or
 * `bodyBatteryValueDescriptorIndex`/`...Key` in the Body Battery list).
 */
function columnOf(descriptors: unknown, key: string, fallback: number): number {
  if (!Array.isArray(descriptors)) return fallback;
  for (const d of descriptors) {
    const values = Object.values(objOf(d) ?? {});
    if (!values.includes(key)) continue;
    const index = values.find((v) => typeof v === 'number');
    if (typeof index === 'number') return index;
  }
  return fallback;
}

/** `[[timestamp, …, value, …]]` rows of `arrayKey` → samples whose value passes `keep`. */
function samples(raw: unknown, arrayKey: string, descriptorsKey: string, valueKey: string, keep: (v: number) => boolean): Sample[] {
  const o = objOf(raw);
  const rows = o?.[arrayKey];
  if (!o || !Array.isArray(rows)) return [];
  const ti = columnOf(o[descriptorsKey], 'timestamp', 0);
  const vi = columnOf(o[descriptorsKey], valueKey, 1);
  return rows.flatMap((r) => {
    if (!Array.isArray(r)) return [];
    const t = numOf(r[ti]);
    const v = numOf(r[vi]);
    return t !== undefined && v !== undefined && keep(v) ? [{ t, v }] : [];
  });
}

/** Steps per 15-minute interval (`[{ startGMT, steps }]`). */
function stepSamples(raw: unknown): Sample[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => {
    const o = objOf(r);
    const t = gmtMs(o?.startGMT);
    const v = numOf(o?.steps);
    return t !== undefined && v !== undefined && v >= 0 ? [{ t, v }] : [];
  });
}

/**
 * SpO2 readings. The shape is not confirmed by a recording (the recorded account has no Pulse Ox):
 * `spO2SingleValues`, else `spO2HourlyAverages`, both read as `[timestamp, value]` rows.
 */
function spo2Samples(raw: unknown): Sample[] {
  const valid = (v: number) => v >= 50 && v <= 100;
  const single = samples(raw, 'spO2SingleValues', 'spO2ValueDescriptorsDTOList', 'spo2Reading', valid);
  return single.length > 0 ? single : samples(raw, 'spO2HourlyAverages', 'spO2ValueDescriptorsDTOList', 'spo2Reading', valid);
}

/** Every day's `bodyBatteryActivityEvent[]` of the Body Battery report. */
function bodyBatteryEvents(raw: unknown, local: (t: number) => LocalTime): BodyBatteryEvent[] {
  const days = Array.isArray(raw) ? raw : [raw];
  return days.flatMap((day) => {
    const list = objOf(day)?.bodyBatteryActivityEvent;
    if (!Array.isArray(list)) return [];
    return list.flatMap((e) => {
      const o = objOf(e);
      const t = gmtMs(o?.eventStartTimeGmt);
      if (!o || t === undefined || typeof o.eventType !== 'string') return [];
      const lt = local(t);
      const ms = numOf(o.durationInMilliseconds);
      const feedback = typeof o.shortFeedback === 'string' && o.shortFeedback !== 'NONE' ? o.shortFeedback : undefined;
      return [
        {
          type: words(o.eventType),
          start: `${lt.date} ${lt.hour}:${lt.minute}`,
          duration: ms === undefined ? undefined : hms(ms / 1000),
          body_battery_impact: numOf(o.bodyBatteryImpact),
          feedback: feedback && words(feedback),
        },
      ];
    });
  });
}

const words = (key: string) => key.toLowerCase().replaceAll('_', ' ');

interface LocalTime {
  date: IsoDate;
  hour: string;
  minute: string;
}

function localTime(timeZone: string): (t: number) => LocalTime {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return (t) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}` as IsoDate, hour: p.hour ?? '00', minute: p.minute ?? '00' };
  };
}

interface Bucket {
  date: IsoDate;
  hour: string;
  hr: number[];
  stress: number[];
  bb: Sample[];
  steps?: number;
  resp: number[];
  spo2: number[];
}

/** Per-hour fields of a bucket; values in samples' time order. */
function hourFields(m: HourlyMetric, b: Bucket): Record<string, number | undefined> {
  switch (m) {
    case 'resting_hr':
      return b.hr.length ? { hr_avg_bpm: round(mean(b.hr), 0), hr_min_bpm: Math.min(...b.hr), hr_max_bpm: Math.max(...b.hr) } : {};
    case 'stress':
      return b.stress.length ? { stress_avg: round(mean(b.stress), 0), stress_max: Math.max(...b.stress) } : {};
    case 'body_battery':
      return b.bb.length ? { body_battery_start: b.bb[0]?.v, body_battery_end: b.bb.at(-1)?.v } : {};
    case 'steps':
      return { steps: b.steps };
    case 'respiration':
      return { respiration_brpm: round(mean(b.resp), 1) };
    case 'spo2':
      return { spo2_pct: round(mean(b.spo2), 0) };
  }
}

/**
 * Hour × metric table of up to a few days from the stored intraday series (`query_health`
 * `granularity: "hour"`): one row per local hour with data, Body Battery events, and per metric
 * the average, the peak and lowest hour (local "YYYY-MM-DD HH:00") and, for steps, the total.
 */
export function hourlyTable(metrics: readonly HourlyMetric[], days: readonly { date: IsoDate; series: readonly IntradayRow[] }[], from: IsoDate, to: IsoDate, timeZone: string): HourlyTable {
  const local = localTime(timeZone);
  const buckets = new Map<string, Bucket>();
  const bucket = (t: number): Bucket | undefined => {
    const lt = local(t);
    if (lt.date < from || lt.date > to) return undefined;
    const key = `${lt.date} ${lt.hour}`;
    let b = buckets.get(key);
    if (!b) {
      b = { date: lt.date, hour: lt.hour, hr: [], stress: [], bb: [], resp: [], spo2: [] };
      buckets.set(key, b);
    }
    return b;
  };
  const want = new Set<HealthMetric>(metrics);
  const events: BodyBatteryEvent[] = [];
  const seenEvents = new Set<string>();

  for (const day of days) {
    for (const row of day.series) {
      const raw = row.raw;
      switch (row.kind) {
        case 'heart_rate':
          if (want.has('resting_hr')) for (const s of samples(raw, 'heartRateValues', 'heartRateValueDescriptors', 'heartrate', (v) => v > 0)) bucket(s.t)?.hr.push(s.v);
          break;
        case 'stress':
          // Negative stress levels mark time off the wrist (-1) or too active to measure (-2).
          if (want.has('stress')) for (const s of samples(raw, 'stressValuesArray', 'stressValueDescriptorsDTOList', 'stressLevel', (v) => v >= 0)) bucket(s.t)?.stress.push(s.v);
          if (want.has('body_battery')) {
            const bb = samples(raw, 'bodyBatteryValuesArray', 'bodyBatteryValueDescriptorsDTOList', 'bodyBatteryLevel', (v) => v >= 0).toSorted((a, b) => a.t - b.t);
            for (const s of bb) bucket(s.t)?.bb.push(s);
          }
          break;
        case 'steps':
          if (want.has('steps')) {
            for (const s of stepSamples(raw)) {
              const b = bucket(s.t);
              if (b) b.steps = (b.steps ?? 0) + s.v;
            }
          }
          break;
        case 'respiration':
          if (want.has('respiration')) for (const s of samples(raw, 'respirationValuesArray', 'respirationValueDescriptorsDTOList', 'respiration', (v) => v > 0)) bucket(s.t)?.resp.push(s.v);
          break;
        case 'spo2':
          if (want.has('spo2')) for (const s of spo2Samples(raw)) bucket(s.t)?.spo2.push(s.v);
          break;
        case 'body_battery_events':
          for (const e of bodyBatteryEvents(raw, local)) {
            const key = `${e.type}|${e.start}`;
            if (seenEvents.has(key) || e.start.slice(0, 10) > to) continue;
            seenEvents.add(key);
            events.push(e);
          }
          break;
        case 'daily_events':
          // Shape not recorded yet (E8-2); not read.
          break;
      }
    }
  }

  const sorted = [...buckets.entries()].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, b]) => b);
  const rows = sorted.flatMap((b) => {
    const fields: Record<string, number | undefined> = {};
    for (const m of metrics) Object.assign(fields, hourFields(m, b));
    if (Object.values(fields).every((v) => v === undefined)) return [];
    return [{ date: b.date, hour: `${b.hour}:00`, ...fields }];
  });

  const summary: HourlyTable['summary'] = {};
  for (const m of metrics) summary[m] = hourlySummary(m, rows, sorted);
  return { rows, events: events.toSorted((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)), summary };
}

type Row = Record<string, string | number | undefined>;
const at = (r: Row) => `${r.date} ${String(r.hour).slice(0, 2)}:00`;

/** The row with the highest (or lowest) value of `field`; the first one on ties. */
function pick(rows: readonly Row[], field: string, dir: 'max' | 'min'): { value: number; at: string } | undefined {
  let best: { value: number; at: string } | undefined;
  for (const r of rows) {
    const v = r[field];
    if (typeof v !== 'number') continue;
    if (!best || (dir === 'max' ? v > best.value : v < best.value)) best = { value: v, at: at(r) };
  }
  return best;
}

/** Peak and lowest hour of each metric: highest HR, the hour with the highest average stress, the lowest Body Battery… */
function hourlySummary(m: HourlyMetric, rows: readonly Row[], buckets: readonly Bucket[]): HourlySummary {
  const field = { resting_hr: 'hr_avg_bpm', stress: 'stress_avg', body_battery: 'body_battery_end', steps: 'steps', respiration: 'respiration_brpm', spo2: 'spo2_pct' }[m];
  const values = rows.map((r) => r[field]).filter((v): v is number => typeof v === 'number');
  const out = (max: ReturnType<typeof pick>, min: ReturnType<typeof pick>, extra: Partial<HourlySummary> = {}): HourlySummary => ({
    ...extra,
    max: max?.value,
    max_at: max?.at,
    min: min?.value,
    min_at: min?.at,
    hours_with_data: values.length,
  });
  switch (m) {
    case 'resting_hr': {
      const all = buckets.flatMap((b) => b.hr);
      return out(pick(rows, 'hr_max_bpm', 'max'), pick(rows, 'hr_min_bpm', 'min'), { avg: round(mean(all), 0) });
    }
    case 'stress': {
      const all = buckets.flatMap((b) => b.stress);
      return out(pick(rows, 'stress_avg', 'max'), pick(rows, 'stress_avg', 'min'), { avg: round(mean(all), 0) });
    }
    case 'body_battery': {
      // Highest and lowest level reached, at the hour it was reached.
      let max: ReturnType<typeof pick>;
      let min: ReturnType<typeof pick>;
      for (const b of buckets) {
        for (const s of b.bb) {
          const when = `${b.date} ${b.hour}:00`;
          if (!max || s.v > max.value) max = { value: s.v, at: when };
          if (!min || s.v < min.value) min = { value: s.v, at: when };
        }
      }
      return out(max, min);
    }
    case 'steps':
      return out(pick(rows, 'steps', 'max'), undefined, { total: values.length ? values.reduce((a, b) => a + b, 0) : undefined });
    case 'respiration':
    case 'spo2':
      return out(pick(rows, field, 'max'), pick(rows, field, 'min'), { avg: round(mean(values), 1) });
  }
}
