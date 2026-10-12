import type { ThresholdParam } from 'garmin-mcp-store';
import { describe, expect, it } from 'vitest';
import { intensityDistribution } from './intensity.js';
import type { Session } from './session.js';
import type { ThresholdPoint } from './thresholds.js';

const row = (date: string, param: ThresholdParam, value: number): ThresholdPoint => ({ date, param, value });
// LT1 150 (bike 143), LTHR from the session row
const THR = [row('2026-01-01', 'lthr_run', 170), row('2026-01-01', 'lt1_hr', 150)];

function sess(date: string, extra: Partial<Session> = {}): Session {
  return { id: date, date, week: '', sport: 'run', duration_s: 3600, if: 0, hrtss: 0, lthr_used: 170, rhr_used: 50, source: 'db', ...extra };
}

const zones = (z1: number, z2: number, z3: number, z4: number, z5: number) => ({ z1_s: z1, z2_s: z2, z3_s: z3, z4_s: z4, z5_s: z5 });

describe('intensityDistribution', () => {
  it('maps Garmin zones 1–2, 3 and 4–5 to Z1, Z2 and Z3', () => {
    const d = intensityDistribution([sess('2026-05-04', zones(600, 2400, 600, 300, 100))], THR, '2026-05-01', '2026-05-31');
    expect(d).toEqual({
      from: '2026-05-01',
      to: '2026-05-31',
      z1_min: 50,
      z2_min: 10,
      z3_min: 7,
      z1_pct: 75,
      z2_pct: 15,
      z3_pct: 10,
      sessions_with_zones: 1,
      sessions_by_avg_hr: 0,
      z1_min_pct: 75,
      z1_below_target: false,
    });
  });

  it('without zones puts the whole duration in the zone of the average HR (LT1, LTHR of the date)', () => {
    const d = intensityDistribution(
      [
        sess('2026-05-04', { avg_hr: 149 }),
        sess('2026-05-05', { avg_hr: 150, duration_s: 1800 }),
        sess('2026-05-06', { avg_hr: 170, duration_s: 1200 }),
        // bike LT1 = 150 − 7 = 143, LTHR 160
        sess('2026-05-07', { sport: 'bike', avg_hr: 145, lthr_used: 160, duration_s: 600 }),
        sess('2026-05-08', { sport: 'bike', avg_hr: 142, lthr_used: 160, duration_s: 600 }),
      ],
      THR,
      '2026-05-01',
      '2026-05-31',
    );
    expect([d.z1_min, d.z2_min, d.z3_min]).toEqual([70, 40, 20]);
    expect(d.sessions_by_avg_hr).toBe(5);
    expect(d.z1_pct).toBe(53.8);
    expect(d.z1_below_target).toBe(true);
  });

  it('uses the approximated LT1 without an lt1_hr row', () => {
    // 0.90 × 170 = 153
    const d = intensityDistribution([sess('2026-05-04', { avg_hr: 152 })], [row('2026-01-01', 'lthr_run', 170)], '2026-05-01', '2026-05-31');
    expect(d.z1_min).toBe(60);
  });

  it('only run and bike inside the range; skips sessions with neither zones nor HR', () => {
    const d = intensityDistribution(
      [
        sess('2026-05-04', { sport: 'swim', avg_hr: 120 }),
        sess('2026-05-04', { sport: 'strength', ...zones(600, 0, 0, 0, 0) }),
        sess('2026-04-30', { avg_hr: 120 }),
        sess('2026-06-01', { avg_hr: 120 }),
        sess('2026-05-04'),
        sess('2026-05-04', zones(0, 0, 0, 0, 0)),
      ],
      THR,
      '2026-05-01',
      '2026-05-31',
    );
    expect(d).toMatchObject({ z1_min: 0, z2_min: 0, z3_min: 0, sessions_with_zones: 0, sessions_by_avg_hr: 0, z1_below_target: false });
    expect(d.z1_pct).toBeUndefined();
  });

  it('takes the Z1 target from the input', () => {
    const s = [sess('2026-05-04', zones(2400, 0, 1200, 0, 0))];
    expect(intensityDistribution(s, THR, '2026-05-01', '2026-05-31').z1_below_target).toBe(true);
    const d = intensityDistribution(s, THR, '2026-05-01', '2026-05-31', 60);
    expect([d.z1_pct, d.z1_min_pct, d.z1_below_target]).toEqual([66.7, 60, false]);
  });
});
