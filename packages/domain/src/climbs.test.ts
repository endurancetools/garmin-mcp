import { describe, expect, it } from 'vitest';
import { CLIMB_RULES, detectClimbs, type ProfilePoint } from './climbs.js';

/** Profile every `step` m from 0 to `length` m; `elevation` gives the height at a distance. */
const profile = (length: number, elevation: (d: number) => number, step = 20): ProfilePoint[] =>
  Array.from({ length: Math.floor(length / step) + 1 }, (_, i) => ({ distance_m: i * step, elevation_m: elevation(i * step) }));

/** Piecewise linear height from [distance, grade %] breaks, starting at 100 m. */
const ramps =
  (...parts: [from: number, gradePct: number][]) =>
  (d: number): number => {
    let e = 100;
    for (const [i, [from, grade]] of parts.entries()) {
      const to = parts[i + 1]?.[0] ?? Infinity;
      if (d <= from) break;
      e += ((Math.min(d, to) - from) * grade) / 100;
    }
    return e;
  };

/** Deterministic noise in [-amp, amp] (a small linear congruential generator). */
const noise = (amp: number, seed = 7) => {
  let x = seed;
  return () => {
    x = (x * 1_103_515_245 + 12_345) % 2_147_483_648;
    return (x / 2_147_483_648) * 2 * amp - amp;
  };
};

describe('climbs', () => {
  it('finds one climb with its foot, top, gain and grades', () => {
    // 2 km flat, 1.5 km at 6 % (90 m) with 200 m at 10 % in it, 2 km flat.
    const climbs = detectClimbs(profile(5500, ramps([0, 0], [2000, 6], [2600, 10], [2800, 6], [3500, 0])));
    expect(climbs).toHaveLength(1);
    const [c] = climbs;
    expect(c?.start_m).toBeGreaterThanOrEqual(1950);
    expect(c?.start_m).toBeLessThanOrEqual(2050);
    expect(c?.end_m).toBeGreaterThanOrEqual(3450);
    expect(c?.end_m).toBeLessThanOrEqual(3550);
    expect(c?.gain_m).toBeGreaterThan(95);
    expect(c?.gain_m).toBeLessThanOrEqual(98);
    expect(c?.avg_grade_pct).toBeGreaterThan(6);
    expect(c?.avg_grade_pct).toBeLessThan(6.8);
    expect(c?.max_grade_pct).toBeGreaterThan(9);
    expect(c?.max_grade_pct).toBeLessThanOrEqual(10);
    expect(c?.length_m).toBe((c?.end_m ?? 0) - (c?.start_m ?? 0));
  });

  it('merges climbs up to 200 m apart and keeps farther ones apart', () => {
    // Two 800 m climbs at 5 % with a 150 m dip at -2 % between them: one climb.
    const merged = detectClimbs(profile(5000, ramps([0, 0], [1000, 5], [1800, -2], [1950, 5], [2750, 0])));
    expect(merged).toHaveLength(1);
    expect(merged[0]?.start_m).toBeLessThanOrEqual(1050);
    expect(merged[0]?.end_m).toBeGreaterThanOrEqual(2700);
    expect(merged[0]?.gain_m).toBeGreaterThan(75);
    // The same climbs 500 m of flat apart: two.
    const apart = detectClimbs(profile(5500, ramps([0, 0], [1000, 5], [1800, 0], [2300, 5], [3100, 0])));
    expect(apart.map((c) => Math.round(c.gain_m))).toEqual([40, 40]);
    expect(apart[1]?.start_m).toBeGreaterThan(2200);
  });

  it('finds nothing on the flat, on rolling ground or below the minimums', () => {
    expect(detectClimbs(profile(10_000, () => 100))).toEqual([]);
    // 100 m waves of ±4 m: grade up to 25 %, but never 30 m of gain.
    expect(detectClimbs(profile(10_000, (d) => 100 + 4 * Math.sin((d / 100) * Math.PI)))).toEqual([]);
    // 2 km at 2 % (40 m): too flat. 400 m at 10 % (40 m): too short. 600 m at 4 % (24 m): too low.
    expect(detectClimbs(profile(6000, ramps([0, 0], [1000, 2], [3000, 0])))).toEqual([]);
    expect(detectClimbs(profile(4000, ramps([0, 0], [1000, 10], [1400, 0])))).toEqual([]);
    expect(detectClimbs(profile(4000, ramps([0, 0], [1000, 4], [1600, 0])))).toEqual([]);
    expect(detectClimbs([])).toEqual([]);
    expect(detectClimbs(profile(400, (d) => d / 5))).toEqual([]);
  });

  it('is not split or invented by elevation noise', () => {
    const jitter = noise(3);
    const flat = profile(10_000, () => 100 + jitter());
    expect(detectClimbs(flat)).toEqual([]);
    const jitter2 = noise(3, 11);
    const noisy = detectClimbs(profile(5500, (d) => ramps([0, 0], [2000, 6], [3500, 0])(d) + jitter2()));
    expect(noisy).toHaveLength(1);
    expect(noisy[0]?.gain_m).toBeGreaterThan(85);
    expect(noisy[0]?.gain_m).toBeLessThan(95);
    expect(noisy[0]?.avg_grade_pct).toBeGreaterThan(5.4);
    expect(noisy[0]?.avg_grade_pct).toBeLessThan(6.6);
  });

  it('skips points without numbers or out of distance order, and uses uneven spacing', () => {
    const uneven = profile(5500, ramps([0, 0], [2000, 6], [3500, 0]), 5).filter((_, i) => i % 7 === 0 || i % 11 === 0);
    const messy = [...uneven.slice(0, 50), { distance_m: 10, elevation_m: 900 }, { distance_m: Number.NaN, elevation_m: 0 }, ...uneven.slice(50)];
    const [c] = detectClimbs(messy);
    expect(c?.gain_m).toBeGreaterThan(88);
    expect(CLIMB_RULES).toMatchObject({ minLengthM: 500, minAvgGradePct: 3, minGainM: 30, maxGapM: 200 });
  });
});
