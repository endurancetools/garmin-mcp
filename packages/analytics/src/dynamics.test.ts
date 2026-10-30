import { describe, expect, it } from 'vitest';
import { dynamicsEligible, dynamicsTrend } from './dynamics.js';
import type { Session } from './session.js';

type Run = Parameters<typeof dynamicsTrend>[0][number];

/** GCT falls 40 ms per m/s; `offset` shifts a month (−10 = better at every speed). */
const run = (date: string, v: number, offset = 0, extra: Partial<Run> = {}): Run => ({
  date: date as Session['date'],
  sport: 'run',
  type: 'running',
  duration_s: 3000,
  distance_m: v * 3000,
  gap_mps: v,
  avg_cadence: 150 + 6 * v,
  gct_ms: 400 - 40 * v + offset,
  gct_balance_left_pct: 49.5,
  ...extra,
});

describe('running dynamics trend', () => {
  it('normalizes each month to the reference speed with a slope taken within months', () => {
    // September easy, October faster: raw GCT drops, but at the same speed only by the 10 ms offset.
    const sessions = [
      ...[2.6, 2.8, 3.0, 3.2].map((v, i) => run(`2026-09-0${i + 1}`, v)),
      ...[3.0, 3.2, 3.4, 3.6].map((v, i) => run(`2026-10-0${i + 1}`, v, -10)),
    ];
    const t = dynamicsTrend(sessions);
    expect(t?.runs).toBe(8);
    expect(t?.ref_pace).toBe('5:23 /km'); // median 3.1 m/s
    expect(t?.per_kmh).toMatchObject({ gct_ms: -11.1, cadence_spm: 1.7 });
    const [sep, oct] = t?.rows ?? [];
    expect(sep).toMatchObject({ period: '2026-09', n: 4, gct_ms: 284, gct_ms_at_ref: 276, cadence_spm: 167, cadence_spm_at_ref: 169, gct_balance_left_pct: 49.5 });
    expect(oct).toMatchObject({ period: '2026-10', n: 4, gct_ms: 258, gct_ms_at_ref: 266 });
    // The raw means differ by 26 ms, at the reference speed by the true 10 ms.
    expect((sep?.gct_ms_at_ref ?? 0) - (oct?.gct_ms_at_ref ?? 0)).toBe(10);
  });

  it('leaves out trail runs, other sports, short runs and runs without dynamics; no slope from too few runs', () => {
    expect(dynamicsEligible({ sport: 'run', type: 'trail_running' })).toBe(false);
    expect(dynamicsEligible({ sport: 'run', type: 'treadmill_running' })).toBe(true);
    const few = [
      run('2026-09-01', 3),
      run('2026-09-02', 3.2),
      run('2026-09-03', 3.1, 0, { type: 'trail_running' }),
      run('2026-09-04', 3.1, 0, { duration_s: 600 }),
      run('2026-09-05', 3.1, 0, { sport: 'bike', type: 'road_biking' }),
      { date: '2026-09-06' as Session['date'], sport: 'run' as const, type: 'running', duration_s: 3000, gap_mps: 3 },
    ];
    const t = dynamicsTrend(few);
    expect(t?.runs).toBe(2);
    expect(t?.per_kmh).toEqual({});
    expect(t?.rows[0]?.gct_ms_at_ref).toBeUndefined();
    expect(t?.rows[0]?.gct_ms).toBe(276);
    expect(dynamicsTrend([])).toBeUndefined();
  });
});
