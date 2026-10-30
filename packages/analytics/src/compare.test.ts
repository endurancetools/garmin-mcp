import { describe, expect, it } from 'vitest';
import { compareRow, DEFAULT_COMPARE_CRITERIA, haversineM, routeEnds, similarity } from './compare.js';
import type { Session } from './session.js';

const session = (extra: Partial<Session> = {}): Session => ({
  id: 1,
  date: '2026-10-01',
  week: '2026-W40',
  type: 'running',
  sport: 'run',
  duration_s: 3000,
  distance_m: 10_000,
  avg_hr: 145,
  gap_mps: 10_000 / 3000,
  load_source: 'hr',
  hrtss: 50,
  hr_method: 'zones',
  lthr_used: 170,
  lt1_used: 150,
  rhr_used: 50,
  z1_s: 1000,
  z2_s: 2000,
  source: 'db',
  ...extra,
});

const home = routeEnds({ startLatitude: 51.0191, startLongitude: 17.1479, endLatitude: 51.0149, endLongitude: 17.1474 });

describe('compare activities', () => {
  it('matches the same type within the duration and pace tolerance and says how it differs', () => {
    const ref = session();
    expect(similarity(ref, {}, session({ id: 2, duration_s: 3300, distance_m: 11_000, gap_mps: 11_000 / 3300 - 0.05 }), {}, DEFAULT_COMPARE_CRITERIA)).toBe('duration +10%, GAP +5 s/km');
    // Pace from distance and time when one of them has no GAP.
    expect(similarity(ref, {}, session({ id: 2, gap_mps: undefined, distance_m: 9700 }), {}, DEFAULT_COMPARE_CRITERIA)).toBe('duration 0%, pace +9 s/km');
    expect(similarity(ref, {}, session({ id: 2, duration_s: 3700 }), {}, DEFAULT_COMPARE_CRITERIA)).toBeUndefined();
    expect(similarity(ref, {}, session({ id: 2, gap_mps: 3 }), {}, DEFAULT_COMPARE_CRITERIA)).toBeUndefined();
    expect(similarity(ref, {}, session({ id: 2, type: 'trail_running' }), {}, DEFAULT_COMPARE_CRITERIA)).toBeUndefined();
    expect(similarity(ref, {}, ref, {}, DEFAULT_COMPARE_CRITERIA)).toBeUndefined();
    // Rides are matched on type and duration only.
    const ride = session({ type: 'road_biking', sport: 'bike', gap_mps: undefined });
    expect(similarity(ride, {}, session({ id: 2, type: 'road_biking', sport: 'bike', gap_mps: undefined, distance_m: 30_000 }), {}, DEFAULT_COMPARE_CRITERIA)).toBe('duration 0%');
  });

  it('same_route needs start and end within 300 m and the distance within 10 %; easy_only under 5 % in zones 4-5', () => {
    const crit = { ...DEFAULT_COMPARE_CRITERIA, same_route: true };
    const ref = session();
    const shifted = routeEnds({ startLatitude: 51.0191 + 0.002, startLongitude: 17.1479, endLatitude: 51.0149, endLongitude: 17.1474 });
    expect(haversineM([51.0191, 17.1479], [51.0211, 17.1479])).toBeCloseTo(222, 0);
    expect(similarity(ref, home, session({ id: 2 }), shifted, crit)).toBe('duration 0%, GAP 0 s/km, same route');
    const far = routeEnds({ startLatitude: 51.03, startLongitude: 17.1479, endLatitude: 51.0149, endLongitude: 17.1474 });
    expect(similarity(ref, home, session({ id: 2 }), far, crit)).toBeUndefined();
    expect(similarity(ref, home, session({ id: 2, distance_m: 11_500, gap_mps: 11_500 / 3000 }), home, { ...crit, pace_s_per_km: 60 })).toBeUndefined();
    expect(similarity(ref, home, session({ id: 2 }), {}, crit)).toBeUndefined();

    const easy = { ...DEFAULT_COMPARE_CRITERIA, easy_only: true };
    expect(similarity(ref, {}, session({ id: 2, z4_s: 100 }), {}, easy)).toBe('duration 0%, GAP 0 s/km');
    expect(similarity(ref, {}, session({ id: 2, z4_s: 200 }), {}, easy)).toBeUndefined();
    expect(similarity(ref, {}, session({ id: 2, z1_s: undefined, z2_s: undefined }), {}, easy)).toBeUndefined();
    expect(routeEnds({ startLatitude: 0, startLongitude: 0 })).toEqual({});
  });

  it('builds a table row with pace strings, the Z4-5 share and the weather', () => {
    const row = compareRow(session({ gct_ms: 250, ef: 1.533, z4_s: 300 }), { temp_c: 18, dew_point_c: 12, humidity_pct: 70 }, 'reference');
    expect(row).toMatchObject({ id: 1, match: 'reference', duration: '50:00', distance_km: 10, pace: '5:00 /km', gap_pace: '5:00 /km', gct_ms: 250, ef: 1.533, z4_z5_pct: 9, temp_c: 18, dew_point_c: 12 });
    expect(compareRow(session({ type: 'road_biking', sport: 'bike', distance_m: 30_000 }), undefined)).toMatchObject({ avg_speed_kmh: 36, pace: undefined, gap_pace: undefined });
  });
});
