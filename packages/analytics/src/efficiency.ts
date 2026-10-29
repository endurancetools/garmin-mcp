import { round } from 'garmin-mcp-domain';
import type { Session } from './session.js';
import type { SportGroup } from './sport.js';

/** Aerobic sessions only: at least this long (s) … */
export const EF_MIN_DURATION_S = 1800;

export type EfficiencyPeriod = 'month' | 'week';

/** Sport groups with an efficiency factor; `hike` (EF from grade adjusted speed) only in the trend when it is in `flags.intensity_sports`. */
export type EfficiencySport = 'run' | 'bike' | 'hike';
export const EF_SPORTS: readonly EfficiencySport[] = ['run', 'bike'];

/** Sports of the EF trend: run and bike, plus hike when the intensity distribution counts it. */
export function efficiencySports(intensitySports: readonly SportGroup[]): readonly EfficiencySport[] {
  return intensitySports.includes('hike') ? [...EF_SPORTS, 'hike'] : EF_SPORTS;
}

/**
 * Efficiency factor of the aerobic sessions of one sport in one month or ISO week (spec 5.6),
 * and the mean decoupling of its sessions that have one. A row with decoupling only (a sport
 * without EF, e.g. `nordic`, or no session below LT1) has `n` 0 and no EF values.
 */
export interface EfficiencyRow {
  /** `YYYY-MM` or `YYYY-Www`. */
  period: string;
  sport: SportGroup;
  n: number;
  ef_avg?: number;
  ef_max?: number;
  /** Running and hiking, over the sessions that have a grade adjusted speed. */
  ef_gap_avg?: number;
  /** Running, over the sessions with power: power per beat (W/bpm). */
  ef_power_avg?: number;
  /** Mean `decoupling_pct` of the sessions of the period and sport that have it (1 place), and their count. */
  decoupling_mean_pct?: number;
  decoupling_n?: number;
}

type EfficiencySession = Pick<Session, 'date' | 'week' | 'sport' | 'duration_s' | 'avg_hr' | 'lt1_used' | 'ef' | 'ef_gap' | 'ef_power' | 'decoupling_pct'>;

/**
 * EF per month or ISO week for running (speed per beat), cycling (normalized power per beat)
 * and, when in `sports`, hiking (grade adjusted speed per beat): sessions with an EF, average
 * HR below the LT1 of their sport and date and at least 30 min; next to it the mean
 * `decoupling_pct` of every session that has one (any sport, below LTHR, at least 60 min).
 * Sorted by period and sport; EF 3 places.
 */
export function efficiencyTrend(
  sessions: readonly EfficiencySession[],
  period: EfficiencyPeriod = 'month',
  sports: readonly EfficiencySport[] = EF_SPORTS,
): EfficiencyRow[] {
  const acc = new Map<string, { period: string; sport: SportGroup; ef: number[]; gap: number[]; pw: number[]; dec: number[] }>();
  const group = (s: EfficiencySession) => {
    const key = period === 'month' ? s.date.slice(0, 7) : s.week;
    const id = `${key}|${s.sport}`;
    const g = acc.get(id) ?? { period: key, sport: s.sport, ef: [], gap: [], pw: [], dec: [] };
    acc.set(id, g);
    return g;
  };
  for (const s of sessions) {
    if (s.decoupling_pct !== undefined) group(s).dec.push(s.decoupling_pct);
    if (!sports.some((x) => x === s.sport)) continue;
    if (s.ef === undefined || s.avg_hr === undefined || s.avg_hr >= s.lt1_used) continue;
    if ((s.duration_s ?? 0) < EF_MIN_DURATION_S) continue;
    const g = group(s);
    g.ef.push(s.ef);
    if (s.ef_gap !== undefined) g.gap.push(s.ef_gap);
    if (s.ef_power !== undefined) g.pw.push(s.ef_power);
  }
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return [...acc.values()]
    .map((g) => ({
      period: g.period,
      sport: g.sport,
      n: g.ef.length,
      ef_avg: g.ef.length ? round(avg(g.ef), 3) : undefined,
      ef_max: g.ef.length ? round(Math.max(...g.ef), 3) : undefined,
      ef_gap_avg: g.gap.length ? round(avg(g.gap), 3) : undefined,
      ef_power_avg: g.pw.length ? round(avg(g.pw), 3) : undefined,
      decoupling_mean_pct: g.dec.length ? round(avg(g.dec), 1) : undefined,
      decoupling_n: g.dec.length || undefined,
    }))
    .toSorted((a, b) => a.period.localeCompare(b.period) || a.sport.localeCompare(b.sport));
}
