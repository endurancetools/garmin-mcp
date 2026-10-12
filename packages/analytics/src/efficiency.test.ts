import { describe, expect, it } from 'vitest';
import { efficiencyTrend } from './efficiency.js';
import type { Session } from './session.js';

function sess(date: string, extra: Partial<Session> = {}): Session {
  return {
    id: date,
    date,
    week: '2026-W19',
    sport: 'run',
    duration_s: 3600,
    avg_hr: 150,
    load_source: 'none',
    hrtss: 0,
    ef: 1.3,
    lthr_used: 170,
    lt1_used: 153,
    rhr_used: 50,
    source: 'db',
    ...extra,
  };
}

describe('efficiencyTrend', () => {
  it('aggregates aerobic runs per month: n, mean, max and GAP mean', () => {
    const rows = efficiencyTrend([
      sess('2026-05-04', { ef: 1.3, ef_gap: 1.4 }),
      sess('2026-05-10', { ef: 1.36 }),
      sess('2026-05-20', { ef: 1.2, ef_gap: 1.25 }),
      sess('2026-06-02', { ef: 1.401 }),
    ]);
    expect(rows).toEqual([
      { period: '2026-05', sport: 'run', n: 3, ef_avg: 1.287, ef_max: 1.36, ef_gap_avg: 1.325 },
      { period: '2026-06', sport: 'run', n: 1, ef_avg: 1.401, ef_max: 1.401, ef_gap_avg: undefined },
    ]);
  });

  it('keeps only sessions below the LT1 of their sport and date and at least 30 min long', () => {
    const rows = efficiencyTrend([
      sess('2026-05-03', { avg_hr: 160 }),
      sess('2026-05-04', { avg_hr: 153 }),
      sess('2026-05-05', { avg_hr: 155, lt1_used: 156, ef: 1.1 }),
      sess('2026-05-06', { duration_s: 1799 }),
      sess('2026-05-07', { duration_s: 1800, ef: 1.5 }),
      sess('2026-05-08', { ef: undefined }),
      sess('2026-05-09', { avg_hr: undefined }),
    ]);
    expect(rows).toEqual([{ period: '2026-05', sport: 'run', n: 2, ef_avg: 1.3, ef_max: 1.5, ef_gap_avg: undefined }]);
  });

  it('groups by ISO week and adds cycling EF (from NP), other sports left out', () => {
    const rows = efficiencyTrend(
      [
        sess('2026-05-04'),
        sess('2026-05-05', { sport: 'bike', ef: 1.45, lthr_used: 160, lt1_used: 144, avg_hr: 140 }),
        sess('2026-05-12', { week: '2026-W20', ef: 1.32 }),
        sess('2026-05-06', { sport: 'swim', ef: 2 }),
      ],
      'week',
    );
    expect(rows.map((r) => [r.period, r.sport, r.n, r.ef_avg])).toEqual([
      ['2026-W19', 'bike', 1, 1.45],
      ['2026-W19', 'run', 1, 1.3],
      ['2026-W20', 'run', 1, 1.32],
    ]);
  });

  it('empty without qualifying sessions', () => {
    expect(efficiencyTrend([])).toEqual([]);
  });
});
