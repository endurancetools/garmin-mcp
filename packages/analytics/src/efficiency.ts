import { round } from 'garmin-mcp-domain';
import type { Session } from './session.js';

/** Aerobic sessions only: at least this long (s) … */
export const EF_MIN_DURATION_S = 1800;

export type EfficiencyPeriod = 'month' | 'week';

/** Efficiency factor of the aerobic sessions of one sport in one month or ISO week (spec 5.6). */
export interface EfficiencyRow {
  /** `YYYY-MM` or `YYYY-Www`. */
  period: string;
  sport: 'run' | 'bike';
  n: number;
  ef_avg: number;
  ef_max: number;
  /** Running only, over the sessions that have a grade adjusted speed. */
  ef_gap_avg?: number;
}

type EfficiencySession = Pick<Session, 'date' | 'week' | 'sport' | 'duration_s' | 'avg_hr' | 'lt1_used' | 'ef' | 'ef_gap'>;

/**
 * EF per month or ISO week for running (speed per beat) and cycling (normalized power per
 * beat): sessions with an EF, average HR below the LT1 of their sport and date and at least
 * 30 min.
 * Sorted by period and sport; 3 places.
 */
export function efficiencyTrend(sessions: readonly EfficiencySession[], period: EfficiencyPeriod = 'month'): EfficiencyRow[] {
  const acc = new Map<string, { period: string; sport: 'run' | 'bike'; ef: number[]; gap: number[] }>();
  for (const s of sessions) {
    if (s.sport !== 'run' && s.sport !== 'bike') continue;
    if (s.ef === undefined || s.avg_hr === undefined || s.avg_hr >= s.lt1_used) continue;
    if ((s.duration_s ?? 0) < EF_MIN_DURATION_S) continue;
    const key = period === 'month' ? s.date.slice(0, 7) : s.week;
    const id = `${key}|${s.sport}`;
    const g = acc.get(id) ?? { period: key, sport: s.sport, ef: [], gap: [] };
    g.ef.push(s.ef);
    if (s.ef_gap !== undefined) g.gap.push(s.ef_gap);
    acc.set(id, g);
  }
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return [...acc.values()]
    .map((g) => ({
      period: g.period,
      sport: g.sport,
      n: g.ef.length,
      ef_avg: round(avg(g.ef), 3) ?? 0,
      ef_max: round(Math.max(...g.ef), 3) ?? 0,
      ef_gap_avg: g.gap.length ? round(avg(g.gap), 3) : undefined,
    }))
    .toSorted((a, b) => a.period.localeCompare(b.period) || a.sport.localeCompare(b.sport));
}
