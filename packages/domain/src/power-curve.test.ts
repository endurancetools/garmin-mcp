import { describe, expect, it } from 'vitest';
import { bestEfforts, durationLabel, POWER_CURVE_DURATIONS_S } from './power-curve.js';

const watts = (...values: (number | null)[]) => values.map((power_w) => ({ power_w }));
const repeat = (n: number, w: number | null) => Array.from({ length: n }, () => w);

describe('bestEfforts', () => {
  it('finds the best window of each duration and where it starts', () => {
    // 10 min at 200 W, 5 min at 300 W with a 1 s spike of 900 W, 50 min at 150 W.
    const records = watts(...repeat(600, 200), ...repeat(150, 300), 900, ...repeat(149, 300), ...repeat(3000, 150));
    const best = bestEfforts(records) ?? [];
    expect(best.map((b) => b.duration_s)).toEqual([...POWER_CURVE_DURATIONS_S]);
    expect(best[0]).toEqual({ duration_s: 1, power_w: 900, start_s: 750 });
    expect(best.find((b) => b.duration_s === 300)).toEqual({ duration_s: 300, power_w: 302, start_s: 600 });
    // 20 min: the 5 min block with all 10 min at 200 W before it and 5 min at 150 W after.
    expect(best.find((b) => b.duration_s === 1200)).toEqual({ duration_s: 1200, power_w: 213, start_s: 0 });
    expect(best.at(-1)).toEqual({ duration_s: 3600, power_w: 171, start_s: 0 });
  });

  it('counts seconds without power as 0 W and leaves out durations longer than the activity', () => {
    // Two 30 s efforts at 400 W around a 30 s stop: the best minute is not 400 W.
    const best = bestEfforts(watts(...repeat(30, 400), ...repeat(30, null), ...repeat(30, 400))) ?? [];
    expect(best.map((b) => durationLabel(b.duration_s))).toEqual(['1s', '5s', '15s', '30s', '1min']);
    expect(best.find((b) => b.duration_s === 30)?.power_w).toBe(400);
    expect(best.find((b) => b.duration_s === 60)?.power_w).toBe(200);
  });

  it('gives nothing without power', () => {
    expect(bestEfforts(watts(...repeat(100, null)))).toBeUndefined();
    expect(bestEfforts(watts(...repeat(100, 0)))).toBeUndefined();
    expect(bestEfforts([])).toBeUndefined();
  });
});
