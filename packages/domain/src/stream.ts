import { hms, km, pacePerKm, round } from './format.js';

/**
 * Server-side aggregates of the activity stream (`activity/{id}/details`) for `get_activity`
 * with `detail: "stream_summary"`, and the `metrics` / `downsample_s` filters of `detail:
 * "full"`. Garmin sends at most `maxChartSize` (2000) samples at uneven spacing, already in
 * plain units (s, m, m/s, spm, ms, cm, W), so every mean is weighted by the time each sample
 * covers: sample i stands for the interval from sample i − 1 to i of the timer
 * (`sumDuration`, which leaves out pauses).
 *
 * Keys checked against a recorded run with an HRM-Pro: directHeartRate, directSpeed,
 * directGradeAdjustedSpeed, directPower, directDoubleCadence (steps/min of both feet),
 * directGroundContactTime, directVerticalOscillation, directVerticalRatio, directStrideLength,
 * directElevation, directAvailableStamina, sumDistance, sumDuration. Not seen in a recording
 * yet: directGroundContactBalanceLeft, directRespirationRate, directPerformanceCondition; a
 * stream without them simply leaves the fields out.
 */

export type StreamBucket = 'km' | '5min' | 'halves' | 'quarters';

export type StreamSample = Record<string, unknown>;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Stream key → bucket field; `zero` keeps zeros (Garmin reports 0 for a dynamic it did not measure, e.g. standing). */
const MEANS = {
  avg_hr_bpm: { key: 'directHeartRate', digits: 0, zero: false },
  avg_power_w: { key: 'directPower', digits: 0, zero: true },
  cadence_spm: { key: 'directDoubleCadence', digits: 0, zero: false },
  gct_ms: { key: 'directGroundContactTime', digits: 0, zero: false },
  gct_balance_left_pct: { key: 'directGroundContactBalanceLeft', digits: 1, zero: false },
  vertical_oscillation_cm: { key: 'directVerticalOscillation', digits: 1, zero: false },
  vertical_ratio_pct: { key: 'directVerticalRatio', digits: 1, zero: false },
  stride_cm: { key: 'directStrideLength', digits: 0, zero: false },
  avg_respiration_brpm: { key: 'directRespirationRate', digits: 1, zero: false },
  performance_condition: { key: 'directPerformanceCondition', digits: 0, zero: true },
  gap_mps: { key: 'directGradeAdjustedSpeed', digits: 3, zero: false },
} as const;

type MeanField = keyof typeof MEANS;

export interface StreamBucketRow {
  /** 1-based: kilometre, 5-minute block, half or quarter. */
  n: number;
  /** Timer time at the start and end of the bucket. */
  from: string;
  to: string;
  distance_km?: number;
  avg_pace?: string;
  avg_speed_kmh?: number;
  avg_gap_pace?: string;
  avg_hr_bpm?: number;
  max_hr_bpm?: number;
  avg_power_w?: number;
  cadence_spm?: number;
  gct_ms?: number;
  gct_balance_left_pct?: number;
  vertical_oscillation_cm?: number;
  vertical_ratio_pct?: number;
  stride_m?: number;
  avg_respiration_brpm?: number;
  performance_condition?: number;
  elevation_change_m?: number;
  stamina_end_pct?: number;
}

export interface PerformanceConditionSummary {
  /** First value Garmin reported (it starts after 6-20 min of running) and when. */
  first?: number;
  first_at?: string;
  end?: number;
  min?: number;
  max?: number;
}

export interface StreamSummary {
  bucket: StreamBucket;
  samples: number;
  buckets: StreamBucketRow[];
  performance_condition?: PerformanceConditionSummary;
}

interface Acc {
  t0: number;
  t1: number;
  d0?: number;
  d1?: number;
  e0?: number;
  e1?: number;
  sums: Partial<Record<MeanField, { wv: number; w: number }>>;
  maxHr?: number;
  stamina?: number;
}

/** Timer seconds of a sample: `sumDuration`, else `sumElapsedDuration`, else the timestamp from the first one. */
function timeOf(s: StreamSample, firstTs: number | undefined): number | undefined {
  const t = num(s.sumDuration) ?? num(s.sumElapsedDuration);
  if (t !== undefined) return t;
  const ts = num(s.directTimestamp);
  return ts !== undefined && firstTs !== undefined ? (ts - firstTs) / 1000 : undefined;
}

const COUNTS: Record<StreamBucket, number | undefined> = { km: undefined, '5min': undefined, halves: 2, quarters: 4 };

/**
 * Stream aggregated per kilometre (`sumDistance`), 5 minutes of timer time, or halves or
 * quarters of the timer time. A sample's interval goes to the bucket of its midpoint, so a
 * bucket edge between two samples is off by at most one sample spacing. Pace is the bucket's
 * distance over its time; for foot sports pace, else speed. `undefined` with fewer than two
 * timed samples, or for `km` without distance.
 */
export function streamSummary(samples: readonly StreamSample[], bucket: StreamBucket, footSport: boolean): StreamSummary | undefined {
  const firstTs = num(samples[0]?.directTimestamp);
  const timed = samples.flatMap((s) => {
    const t = timeOf(s, firstTs);
    return t === undefined ? [] : [{ s, t, d: num(s.sumDistance) }];
  });
  if (timed.length < 2) return undefined;
  const total = timed.at(-1)?.t ?? 0;
  const parts = COUNTS[bucket];
  if (bucket === 'km' && !timed.some((x) => (x.d ?? 0) > 0)) return undefined;
  const indexOf = (t: number, d: number | undefined): number => {
    if (bucket === 'km') return Math.max(0, Math.floor((d ?? 0) / 1000));
    if (bucket === '5min') return Math.max(0, Math.floor(t / 300));
    return Math.min((parts ?? 1) - 1, Math.max(0, Math.floor((t / (total || 1)) * (parts ?? 1))));
  };
  const accs = new Map<number, Acc>();
  for (let i = 1; i < timed.length; i++) {
    const prev = timed[i - 1];
    const cur = timed[i];
    if (!prev || !cur) continue;
    const w = cur.t - prev.t;
    if (!(w > 0)) continue;
    const midD = prev.d !== undefined && cur.d !== undefined ? (prev.d + cur.d) / 2 : cur.d;
    const idx = indexOf((prev.t + cur.t) / 2, midD);
    let a = accs.get(idx);
    if (!a) {
      a = { t0: prev.t, t1: cur.t, d0: prev.d, d1: cur.d, e0: num(prev.s.directElevation), sums: {} };
      accs.set(idx, a);
    }
    a.t1 = cur.t;
    a.d1 = cur.d ?? a.d1;
    a.e1 = num(cur.s.directElevation) ?? a.e1;
    a.e0 ??= num(cur.s.directElevation);
    for (const [field, m] of Object.entries(MEANS) as [MeanField, (typeof MEANS)[MeanField]][]) {
      const v = num(cur.s[m.key]);
      if (v === undefined || (!m.zero && v === 0)) continue;
      const sum = (a.sums[field] ??= { wv: 0, w: 0 });
      sum.wv += w * v;
      sum.w += w;
    }
    const hr = num(cur.s.directHeartRate);
    if (hr !== undefined && hr > 0) a.maxHr = Math.max(a.maxHr ?? 0, hr);
    a.stamina = num(cur.s.directAvailableStamina) ?? a.stamina;
  }
  const mean = (a: Acc, f: MeanField) => {
    const s = a.sums[f];
    return s && s.w > 0 ? s.wv / s.w : undefined;
  };
  const buckets = [...accs.entries()]
    .toSorted(([x], [y]) => x - y)
    .map(([idx, a]): StreamBucketRow => {
      const dist = a.d0 !== undefined && a.d1 !== undefined ? a.d1 - a.d0 : undefined;
      const dur = a.t1 - a.t0;
      const mps = dist !== undefined && dist > 0 && dur > 0 ? dist / dur : undefined;
      const gap = mean(a, 'gap_mps');
      const stride = mean(a, 'stride_cm');
      return {
        n: idx + 1,
        from: hms(a.t0) ?? '0:00',
        to: hms(a.t1) ?? '0:00',
        distance_km: km(dist),
        ...(footSport ? { avg_pace: pacePerKm(mps), avg_gap_pace: pacePerKm(gap) } : { avg_speed_kmh: round(mps === undefined ? undefined : mps * 3.6, 1) }),
        avg_hr_bpm: round(mean(a, 'avg_hr_bpm'), 0),
        max_hr_bpm: a.maxHr,
        avg_power_w: round(mean(a, 'avg_power_w'), 0),
        cadence_spm: round(mean(a, 'cadence_spm'), 0),
        gct_ms: round(mean(a, 'gct_ms'), 0),
        gct_balance_left_pct: round(mean(a, 'gct_balance_left_pct'), 1),
        vertical_oscillation_cm: round(mean(a, 'vertical_oscillation_cm'), 1),
        vertical_ratio_pct: round(mean(a, 'vertical_ratio_pct'), 1),
        stride_m: stride === undefined ? undefined : round(stride / 100, 2),
        avg_respiration_brpm: round(mean(a, 'avg_respiration_brpm'), 1),
        performance_condition: round(mean(a, 'performance_condition'), 0),
        elevation_change_m: a.e0 !== undefined && a.e1 !== undefined ? round(a.e1 - a.e0, 0) : undefined,
        stamina_end_pct: a.stamina,
      };
    });
  return { bucket, samples: timed.length, buckets, performance_condition: performanceCondition(timed) };
}

function performanceCondition(timed: readonly { s: StreamSample; t: number }[]): PerformanceConditionSummary | undefined {
  const values = timed.flatMap(({ s, t }) => {
    const v = num(s[MEANS.performance_condition.key]);
    return v === undefined ? [] : [{ v, t }];
  });
  const first = values[0];
  if (!first) return undefined;
  const vs = values.map((x) => x.v);
  return { first: first.v, first_at: hms(first.t), end: values.at(-1)?.v, min: Math.min(...vs), max: Math.max(...vs) };
}

/**
 * Samples of `detail: "full"` reduced to `metrics` (stream keys; `directTimestamp` and
 * `sumDuration` always stay so samples can be placed) and to at most one sample per
 * `downsampleS` seconds of timer time. Returns the kept keys and samples.
 */
export function filterStream(
  keys: readonly string[],
  samples: readonly StreamSample[],
  opts: { metrics?: readonly string[]; downsampleS?: number },
): { keys: string[]; samples: StreamSample[]; unknown: string[] } {
  const wanted = opts.metrics && opts.metrics.length > 0 ? new Set([...opts.metrics, 'directTimestamp', 'sumDuration']) : undefined;
  const kept = wanted ? keys.filter((k) => wanted.has(k)) : [...keys];
  const unknown = (opts.metrics ?? []).filter((m) => !keys.includes(m));
  const step = opts.downsampleS ?? 0;
  const firstTs = num(samples[0]?.directTimestamp);
  let last: number | undefined;
  const out: StreamSample[] = [];
  for (const s of samples) {
    if (step > 0) {
      const t = timeOf(s, firstTs);
      if (t !== undefined && last !== undefined && t - last < step) continue;
      if (t !== undefined) last = t;
    }
    out.push(wanted ? Object.fromEntries(kept.map((k) => [k, s[k] ?? null])) : s);
  }
  return { keys: kept, samples: out, unknown };
}
