import type { ThresholdParam } from 'garmin-mcp-store';
import { describe, expect, it } from 'vitest';
import { FIXED_ZONE_MAPPING_NOTE, intensityDistribution, seilerShares } from './intensity.js';
import type { Session } from './session.js';
import { profileZoneFloors, type ThresholdPoint } from './thresholds.js';

const row = (date: string, param: ThresholdParam, value: number): ThresholdPoint => ({ date, param, value });
// LT1 150 (bike 143), LTHR from the session row
const THR = [row('2026-01-01', 'lthr_run', 170), row('2026-01-01', 'lt1_hr', 150)];

function sess(date: string, extra: Partial<Session> = {}): Session {
  return { id: date, date, week: '', sport: 'run', duration_s: 3600, load_source: 'none', hrtss: 0, lthr_used: 170, lt1_used: 153, rhr_used: 50, source: 'db', ...extra };
}

const zones = (z1: number, z2: number, z3: number, z4: number, z5: number) => ({ z1_s: z1, z2_s: z2, z3_s: z3, z4_s: z4, z5_s: z5 });

// HR zones as in packages/client/fixtures/heart-rate-zones.json
const PROFILE = {
  heartRateZones: [
    { sport: 'DEFAULT', lactateThresholdHeartRateUsed: 168, zone1Floor: 94, zone2Floor: 134, zone3Floor: 154, zone4Floor: 163, zone5Floor: 174, maxHeartRateUsed: 185 },
    { sport: 'CYCLING', lactateThresholdHeartRateUsed: 160, zone1Floor: 109, zone2Floor: 133, zone3Floor: 148, zone4Floor: 159, zone5Floor: 167, maxHeartRateUsed: 185 },
  ],
};
const FLOORS = profileZoneFloors(PROFILE);
// LTHR 168, LT1 151
const THR_P = [row('2026-01-01', 'lthr_run', 168), row('2026-01-01', 'lt1_hr', 151)];
const minutes = (d: { z1_min: number; z2_min: number; z3_min: number }) => [d.z1_min, d.z2_min, d.z3_min];

describe('intensityDistribution', () => {
  it('without profile zone bounds maps Garmin zones 1–2, 3 and 4–5 to Z1, Z2 and Z3, with a note', () => {
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
      note: FIXED_ZONE_MAPPING_NOTE,
    });
  });

  it('with profile zone bounds maps each Garmin zone by its bpm range against LT1 and LTHR', () => {
    const at = (z: ReturnType<typeof zones>) =>
      minutes(intensityDistribution([sess('2026-05-04', { lthr_used: 168, ...z })], THR_P, '2026-05-01', '2026-05-31', 75, FLOORS));
    // zone 1 (94–134) is below LT1 151
    expect(at(zones(600, 0, 0, 0, 0))).toEqual([10, 0, 0]);
    // zone 2 (134–154) crosses LT1: 17/20 Z1, 3/20 Z2
    expect(at(zones(0, 1200, 0, 0, 0))).toEqual([17, 3, 0]);
    // zone 3 (154–163) lies between LT1 and LTHR
    expect(at(zones(0, 0, 600, 0, 0))).toEqual([0, 10, 0]);
    // zone 4 (163–174) crosses LTHR 168: 5/11 Z2, 6/11 Z3
    expect(at(zones(0, 0, 0, 660, 0))).toEqual([0, 5, 6]);
    // zone 5 (174–185) is above LTHR
    expect(at(zones(0, 0, 0, 0, 600))).toEqual([0, 0, 10]);
    const d = intensityDistribution([sess('2026-05-04', { lthr_used: 168, ...zones(0, 0, 600, 1320, 600) })], THR_P, '2026-05-01', '2026-05-31', 75, FLOORS);
    expect(minutes(d)).toEqual([0, 20, 22]);
    expect(d.sessions_with_zones).toBe(1);
    expect(d.note).toBeUndefined();
  });

  it('cycling uses the CYCLING zone bounds and the cycling LT1 of the date', () => {
    // bike LT1 = 151 − 7 = 144, LTHR 160; zone 3 (148–159) is Z2, zone 4 (159–167) 1/8 Z2 and 7/8 Z3
    const d = intensityDistribution(
      [sess('2026-05-04', { sport: 'bike', lthr_used: 160, ...zones(0, 0, 600, 480, 0) })],
      THR_P,
      '2026-05-01',
      '2026-05-31',
      75,
      FLOORS,
    );
    expect(minutes(d)).toEqual([0, 11, 7]);
    // without CYCLING bounds the DEFAULT ones are used
    const def = intensityDistribution(
      [sess('2026-05-04', { sport: 'bike', lthr_used: 160, ...zones(0, 0, 540, 0, 0) })],
      THR_P,
      '2026-05-01',
      '2026-05-31',
      75,
      { DEFAULT: FLOORS.DEFAULT },
    );
    // zone 3 (154–163) against LT1 144 and LTHR 160: 6/9 Z2, 3/9 Z3
    expect(minutes(def)).toEqual([0, 6, 3]);
  });

  it('notes the fixed mapping only when a session with zones had no bounds', () => {
    const s = [sess('2026-05-04', { sport: 'bike', ...zones(600, 0, 0, 0, 0) }), sess('2026-05-05', { avg_hr: 120 })];
    expect(intensityDistribution(s, THR, '2026-05-01', '2026-05-31', 75, { CYCLING: FLOORS.CYCLING }).note).toBeUndefined();
    expect(intensityDistribution(s, THR, '2026-05-01', '2026-05-31', 75, { DEFAULT: FLOORS.DEFAULT }).note).toBeUndefined();
    const run = [sess('2026-05-04', zones(600, 0, 0, 0, 0))];
    expect(intensityDistribution(run, THR, '2026-05-01', '2026-05-31', 75, { CYCLING: FLOORS.CYCLING }).note).toBe(FIXED_ZONE_MAPPING_NOTE);
  });

  it('seilerShares splits a bpm range across LT1 and LTHR', () => {
    expect(seilerShares(160, 170, 150, 165)).toEqual([0, 0.5, 0.5]);
    expect(seilerShares(140, 160, 150, 155)).toEqual([0.5, 0.25, 0.25]);
    // LT1 above LTHR: no Z2
    expect(seilerShares(150, 170, 165, 160)).toEqual([0.5, 0, 0.5]);
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
