import { eachDay, type IsoDate } from 'garmin-mcp-config';
import { round } from './format.js';

export interface LoadInput {
  date: IsoDate;
  training_load: number | null;
}

export interface LoadPoint {
  date: IsoDate;
  load: number;
  /** Chronic training load, 42-day EWMA ("fitness"). */
  ctl: number;
  /** Acute training load, 7-day EWMA ("fatigue"). */
  atl: number;
  /** Training stress balance, CTL − ATL of the previous day ("form"). */
  tsb: number;
}

export const CTL_DAYS = 42;
export const ATL_DAYS = 7;

/**
 * CTL/ATL/TSB from per-activity Garmin training load (EPOC based), as exponentially
 * weighted moving averages with 42 and 7 day time constants. Days without
 * activities count as zero load. History before `from` warms the averages up;
 * pass at least ~90 days of it for meaningful CTL.
 */
export function trainingLoadSeries(activities: readonly LoadInput[], from: IsoDate, to: IsoDate): LoadPoint[] {
  const daily = new Map<string, number>();
  let first = from;
  for (const a of activities) {
    if (a.training_load === null || !Number.isFinite(a.training_load)) continue;
    daily.set(a.date, (daily.get(a.date) ?? 0) + a.training_load);
    if (a.date < first) first = a.date;
  }
  const kCtl = 1 - Math.exp(-1 / CTL_DAYS);
  const kAtl = 1 - Math.exp(-1 / ATL_DAYS);
  let ctl = 0;
  let atl = 0;
  const out: LoadPoint[] = [];
  for (const date of eachDay(first, to)) {
    const load = daily.get(date) ?? 0;
    const tsb = ctl - atl;
    ctl += (load - ctl) * kCtl;
    atl += (load - atl) * kAtl;
    if (date >= from) out.push({ date, load: round(load, 1) ?? 0, ctl: round(ctl, 1) ?? 0, atl: round(atl, 1) ?? 0, tsb: round(tsb, 1) ?? 0 });
  }
  return out;
}

export type FormState = 'fresh' | 'neutral' | 'optimal_training' | 'overreaching';

/** Rough interpretation of TSB, in the usual Coggan bands scaled to CTL. */
export function formState(point: Pick<LoadPoint, 'ctl' | 'tsb'>): FormState {
  const rel = point.ctl > 0 ? point.tsb / point.ctl : 0;
  if (rel > 0.1) return 'fresh';
  if (rel > -0.1) return 'neutral';
  if (rel > -0.3) return 'optimal_training';
  return 'overreaching';
}
