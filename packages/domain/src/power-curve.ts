import type { FitRecord } from './fit.js';

/** Durations of the power curve, in seconds: 1, 5, 15, 30 s and 1, 2, 5, 10, 20, 30, 60 min. */
export const POWER_CURVE_DURATIONS_S = [1, 5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600] as const;

/** Best average power over one duration, and when that window started (seconds from the first record). */
export interface BestEffort {
  duration_s: number;
  power_w: number;
  start_s: number;
}

/**
 * Best average power for each of `POWER_CURVE_DURATIONS_S` from the 1 Hz records of a FIT file,
 * over elapsed time: a second without power (a pause, a dropout, coasting) counts as 0 W, so a
 * window across a stop is not joined from the efforts on both sides. Durations longer than the
 * activity are left out. `undefined` when no record has power above 0 W.
 */
export function bestEfforts(records: readonly Pick<FitRecord, 'power_w'>[]): BestEffort[] | undefined {
  if (!records.some((r) => (r.power_w ?? 0) > 0)) return undefined;
  const sums = new Float64Array(records.length + 1);
  for (let i = 0; i < records.length; i++) sums[i + 1] = (sums[i] ?? 0) + Math.max(0, records[i]?.power_w ?? 0);
  const best: BestEffort[] = [];
  for (const d of POWER_CURVE_DURATIONS_S) {
    if (d > records.length) break;
    let top = -1;
    let at = 0;
    for (let start = 0; start + d <= records.length; start++) {
      const sum = (sums[start + d] ?? 0) - (sums[start] ?? 0);
      if (sum > top) {
        top = sum;
        at = start;
      }
    }
    best.push({ duration_s: d, power_w: Math.round((top / d) * 10) / 10, start_s: at });
  }
  return best;
}

/** "1s", "30s", "1min", "20min": the label of a curve duration. */
export function durationLabel(seconds: number): string {
  return seconds < 60 ? `${seconds}s` : `${seconds / 60}min`;
}
