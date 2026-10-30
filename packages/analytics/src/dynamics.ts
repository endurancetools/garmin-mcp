import { pacePerKm, round } from 'garmin-mcp-domain';
import type { Session } from './session.js';

/**
 * Monthly trend of running dynamics normalized to speed (`get_load` with `include_dynamics`).
 * Cadence, ground contact time, vertical oscillation and ratio and stride length all change
 * with speed, so a raw monthly mean moves with the mix of easy and fast runs. Each metric is
 * regressed on speed (grade adjusted speed, else distance / time) with the slope taken within
 * months (deviations from the month's own means), so a fitness trend across months does not
 * leak into it; a month's value at the reference speed (median of all runs in the range) is
 * `mean − slope × (month mean speed − reference speed)`. Ground contact balance does not
 * depend on speed and is reported as a plain mean.
 */

/** Runs shorter than this (s) are left out: warm-ups, strides, tests. */
export const DYNAMICS_MIN_DURATION_S = 1200;
/** A slope needs at least this many runs with the metric. */
export const DYNAMICS_MIN_RUNS = 6;

const METRICS = ['cadence_spm', 'gct_ms', 'vertical_oscillation_cm', 'vertical_ratio_pct', 'stride_m'] as const;
type Metric = (typeof METRICS)[number];

const DIGITS: Record<Metric, number> = { cadence_spm: 0, gct_ms: 0, vertical_oscillation_cm: 1, vertical_ratio_pct: 1, stride_m: 2 };

type DynamicsSession = Pick<
  Session,
  'date' | 'sport' | 'type' | 'duration_s' | 'distance_m' | 'gap_mps' | 'avg_cadence' | 'gct_ms' | 'gct_balance_left_pct' | 'vertical_oscillation_cm' | 'vertical_ratio_pct' | 'stride_m'
>;

export interface DynamicsRow {
  /** `YYYY-MM`. */
  period: string;
  n: number;
  /** Mean grade adjusted pace of the month's runs. */
  avg_pace?: string;
  cadence_spm?: number;
  cadence_spm_at_ref?: number;
  gct_ms?: number;
  gct_ms_at_ref?: number;
  vertical_oscillation_cm?: number;
  vertical_oscillation_cm_at_ref?: number;
  vertical_ratio_pct?: number;
  vertical_ratio_pct_at_ref?: number;
  stride_m?: number;
  stride_m_at_ref?: number;
  gct_balance_left_pct?: number;
}

export interface DynamicsTrend {
  /** Reference pace the `_at_ref` values are normalized to. */
  ref_pace?: string;
  /** Change of each metric per +1 km/h; absent with fewer than {@link DYNAMICS_MIN_RUNS} runs or no spread in speed. */
  per_kmh: Partial<Record<Metric, number>>;
  runs: number;
  rows: DynamicsRow[];
}

/** Road, track and treadmill runs; trail runs are left out because terrain changes the dynamics more than speed. */
export function dynamicsEligible(s: Pick<Session, 'sport' | 'type'>): boolean {
  return s.sport === 'run' && !/trail/i.test(s.type ?? '');
}

const speedOf = (s: DynamicsSession) => s.gap_mps ?? ((s.duration_s ?? 0) > 0 && (s.distance_m ?? 0) > 0 ? (s.distance_m ?? 0) / (s.duration_s ?? 1) : undefined);
const valueOf = (s: DynamicsSession, m: Metric) => (m === 'cadence_spm' ? s.avg_cadence : s[m]);
const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function median(xs: readonly number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = xs.toSorted((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/** Monthly running dynamics with values at the reference speed; `undefined` without an eligible run with dynamics. */
export function dynamicsTrend(sessions: readonly DynamicsSession[]): DynamicsTrend | undefined {
  const runs = sessions.flatMap((s) => {
    const v = speedOf(s);
    return dynamicsEligible(s) && (s.duration_s ?? 0) >= DYNAMICS_MIN_DURATION_S && v !== undefined && v > 0 && METRICS.some((m) => valueOf(s, m) !== undefined) ? [{ s, v }] : [];
  });
  if (runs.length === 0) return undefined;
  const ref = median(runs.map((r) => r.v)) ?? 0;
  const months = new Map<string, typeof runs>();
  for (const r of runs) {
    const key = r.s.date.slice(0, 7);
    months.set(key, [...(months.get(key) ?? []), r]);
  }
  const slope: Partial<Record<Metric, number>> = {};
  for (const m of METRICS) {
    let sxy = 0;
    let sxx = 0;
    let n = 0;
    for (const group of months.values()) {
      const pts = group.flatMap((r) => {
        const y = valueOf(r.s, m);
        return y === undefined ? [] : [{ x: r.v, y }];
      });
      if (pts.length < 2) continue;
      const mx = mean(pts.map((p) => p.x));
      const my = mean(pts.map((p) => p.y));
      for (const p of pts) {
        sxy += (p.x - mx) * (p.y - my);
        sxx += (p.x - mx) ** 2;
      }
      n += pts.length;
    }
    if (n >= DYNAMICS_MIN_RUNS && sxx > 0) slope[m] = sxy / sxx;
  }
  const rows = [...months.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([period, group]): DynamicsRow => {
      const row: DynamicsRow = { period, n: group.length, avg_pace: pacePerKm(mean(group.map((r) => r.v))) };
      for (const m of METRICS) {
        const pts = group.flatMap((r) => {
          const y = valueOf(r.s, m);
          return y === undefined ? [] : [{ x: r.v, y }];
        });
        if (pts.length === 0) continue;
        const my = mean(pts.map((p) => p.y));
        row[m] = round(my, DIGITS[m]);
        const b = slope[m];
        if (b !== undefined) row[`${m}_at_ref` as const] = round(my - b * (mean(pts.map((p) => p.x)) - ref), DIGITS[m]);
      }
      const bal = group.flatMap((r) => (r.s.gct_balance_left_pct === undefined ? [] : [r.s.gct_balance_left_pct]));
      if (bal.length > 0) row.gct_balance_left_pct = round(mean(bal), 1);
      return row;
    });
  const perKmh = Object.fromEntries(Object.entries(slope).map(([m, b]) => [m, round(b / 3.6, DIGITS[m as Metric] + 1)])) as Partial<Record<Metric, number>>;
  return { ref_pace: pacePerKm(ref), per_kmh: perKmh, runs: runs.length, rows };
}
