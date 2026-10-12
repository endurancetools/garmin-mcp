import { addDays, eachDay } from 'garmin-mcp-config';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOAD_FLAGS,
  dailyTss,
  loadFlags,
  LOAD_RATIO_DAYS,
  loadOn,
  loadRatio,
  loadSeries,
  resolveLoadFlags,
  sampleSd,
  weekJump,
  weeklyBySport,
  type LoadDay,
} from './load.js';
import type { Session } from './session.js';

function sess(date: string, extra: Partial<Session> = {}): Session {
  return {
    id: date,
    date,
    week: '',
    sport: 'run',
    duration_s: 3600,
    distance_m: 10_000,
    tss: 100,
    if: 1,
    load_source: 'hr',
    hrtss: 100,
    hr_method: 'avg',
    lthr_used: 170,
    lt1_used: 153,
    rhr_used: 50,
    source: 'db',
    ...extra,
  };
}

const day = (extra: Partial<LoadDay> = {}): LoadDay => ({
  date: '2026-05-06',
  tss: 50,
  ctl: 50,
  atl: 50,
  tsb: 0,
  acwr: 1,
  monotony: 1,
  strain: 300,
  warming_up: false,
  ...extra,
});

describe('loadSeries', () => {
  it('constant 100 a day for 300 days: ACWR 1.00, monotony 0 (SD 0), CTL > 99', () => {
    const days = eachDay('2025-01-01', addDays('2025-01-01', 299));
    const series = loadSeries(days.map((d) => sess(d)), 'hrtss', days.at(-1)!);
    expect(series).toHaveLength(300);
    const last = series.at(-1)!;
    expect(last.acwr).toBe(1);
    expect(last.monotony).toBe(0);
    expect(last.strain).toBe(0);
    expect(last.ctl).toBeGreaterThan(99);
    expect(last.atl).toBe(100);
    expect(last.tss).toBe(100);
  });

  it('starts on the first day with an activity and runs to `to` with zero days', () => {
    const series = loadSeries([sess('2026-05-03', { hrtss: 40 }), sess('2026-05-01', { hrtss: 60 })], 'hrtss', '2026-05-05');
    expect(series.map((d) => [d.date, d.tss])).toEqual([
      ['2026-05-01', 60],
      ['2026-05-02', 0],
      ['2026-05-03', 40],
      ['2026-05-04', 0],
      ['2026-05-05', 0],
    ]);
    expect(series[0]?.tsb).toBe(0);
    expect(series[1]?.tsb).toBeLessThan(0);
    expect(loadSeries([], 'hrtss', '2026-05-05')).toEqual([]);
  });

  it('sums sessions of one day', () => {
    const series = loadSeries([sess('2026-05-01', { hrtss: 30.04 }), sess('2026-05-01', { hrtss: 20.03 })], 'hrtss', '2026-05-01');
    expect(series[0]?.tss).toBe(50.1);
  });

  it('cuts ACWR windows at the series start and gives 0 for an empty chronic window', () => {
    const series = loadSeries([sess('2026-01-01')], 'hrtss', '2026-02-15');
    expect(series[0]?.acwr).toBe(1);
    // day 2: acute mean 50, chronic mean 50
    expect(series[1]?.acwr).toBe(1);
    // day 8: acute window holds only zeros, chronic window still has the 100
    expect(loadOn(series, '2026-01-08')?.acwr).toBe(0);
    // after 28 days the chronic mean is 0 too
    expect(loadOn(series, '2026-02-15')?.acwr).toBe(0);
  });

  it('monotony with a rest day and strain = weekly sum × monotony', () => {
    const days = eachDay('2026-05-01', '2026-05-06');
    const series = loadSeries(days.map((d) => sess(d)), 'hrtss', '2026-05-07');
    const last = series.at(-1)!;
    // six days of 100 and one of 0: mean 85.71, sample SD 37.80
    expect(last.monotony).toBe(2.27);
    expect(last.strain).toBe(1361);
    expect(series[0]?.monotony).toBe(0);
  });

  it('Garmin load source sums training_load, sessions without one count 0', () => {
    const sessions = [sess('2026-05-01', { g_load: 80 }), sess('2026-05-01'), sess('2026-05-02', { g_load: 40 })];
    expect([...dailyTss(sessions, 'garmin_load')]).toEqual([
      ['2026-05-01', 80],
      ['2026-05-02', 40],
    ]);
    expect([...dailyTss(sessions, 'hrtss')]).toEqual([
      ['2026-05-01', 200],
      ['2026-05-02', 100],
    ]);
    expect(loadSeries(sessions, 'garmin_load', '2026-05-02').map((d) => d.tss)).toEqual([80, 40]);
  });

  it('auto sums the session TSS of the hierarchy; a session without load counts 0, hrtss keeps the heart-rate stress', () => {
    const sessions = [
      sess('2026-05-01', { tss: 120, if: 0.95, load_source: 'power', hrtss: 90 }),
      sess('2026-05-01', { tss: undefined, if: undefined, load_source: 'none', hrtss: 0 }),
      sess('2026-05-02', { tss: 64.3, if: 0.8, load_source: 'pace', hrtss: 70 }),
    ];
    expect([...dailyTss(sessions, 'auto')]).toEqual([
      ['2026-05-01', 120],
      ['2026-05-02', 64.3],
    ]);
    expect([...dailyTss(sessions, 'hrtss')]).toEqual([
      ['2026-05-01', 90],
      ['2026-05-02', 70],
    ]);
    expect(loadSeries(sessions, 'auto', '2026-05-02').map((d) => d.tss)).toEqual([120, 64.3]);
  });

  it('warming_up for the first 42 days from the first session (days 0..41), then false', () => {
    const series = loadSeries([sess('2026-01-01')], 'hrtss', '2026-03-01');
    expect(loadOn(series, '2026-01-01')?.warming_up).toBe(true);
    expect(loadOn(series, addDays('2026-01-01', 41))?.warming_up).toBe(true);
    expect(loadOn(series, addDays('2026-01-01', 42))?.warming_up).toBe(false);
    expect(series.at(-1)?.warming_up).toBe(false);
  });

  it('only Garmin-load days without any load still start the series', () => {
    const series = loadSeries([sess('2026-05-01')], 'garmin_load', '2026-05-02');
    expect(series.map((d) => d.tss)).toEqual([0, 0]);
  });
});

describe('sampleSd', () => {
  it('uses n − 1 and is 0 below two values', () => {
    expect(sampleSd([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
    expect(sampleSd([5])).toBe(0);
    expect(sampleSd([])).toBe(0);
  });
});

describe('loadOn', () => {
  it('returns the last day on or before the date', () => {
    const series = [day({ date: '2026-05-01' }), day({ date: '2026-05-03' })];
    expect(loadOn(series, '2026-05-02')?.date).toBe('2026-05-01');
    expect(loadOn(series, '2026-05-09')?.date).toBe('2026-05-03');
    expect(loadOn(series, '2026-04-30')).toBeUndefined();
  });
});

describe('loadFlags', () => {
  const codes = (d: LoadDay, flags = DEFAULT_LOAD_FLAGS) => loadFlags(d, [], flags).map((f) => f.code);

  it('no flags on a neutral day or without a day', () => {
    expect(codes(day())).toEqual([]);
    expect(loadFlags(undefined, [])).toEqual([]);
  });

  it('ACWR raises one of high, warn and low', () => {
    expect(codes(day({ acwr: 1.51 }))).toEqual(['acwr_high']);
    expect(codes(day({ acwr: 1.5 }))).toEqual(['acwr_warn']);
    expect(codes(day({ acwr: 1.31 }))).toEqual(['acwr_warn']);
    expect(codes(day({ acwr: 1.3 }))).toEqual([]);
    expect(codes(day({ acwr: 0.79 }))).toEqual(['acwr_low']);
    expect(codes(day({ acwr: 0.8 }))).toEqual([]);
  });

  it('acwr_low only above CTL 20', () => {
    expect(codes(day({ acwr: 0.5, ctl: 20 }))).toEqual([]);
    expect(codes(day({ acwr: 0.5, ctl: 20.1 }))).toEqual(['acwr_low']);
  });

  it('monotony and TSB', () => {
    expect(codes(day({ monotony: 2.01 }))).toEqual(['monotony_high']);
    expect(codes(day({ monotony: 2 }))).toEqual([]);
    expect(codes(day({ tsb: -30.1 }))).toEqual(['tsb_low']);
    expect(codes(day({ tsb: -30 }))).toEqual([]);
    expect(codes(day({ tsb: 15.1 }))).toEqual(['tsb_fresh']);
    expect(codes(day({ tsb: 15 }))).toEqual([]);
    const texts = loadFlags(day({ acwr: 1.6, monotony: 2.5, tsb: -35 }), []).map((f) => f.text);
    expect(texts).toHaveLength(3);
    expect(texts[0]).toContain('1.6');
  });

  it('no TSB flags while the model warms up; ACWR, monotony and the week jump stay', () => {
    expect(codes(day({ tsb: -45, warming_up: true }))).toEqual([]);
    expect(codes(day({ tsb: 25, warming_up: true }))).toEqual([]);
    expect(codes(day({ tsb: -45, acwr: 1.6, monotony: 2.5, warming_up: true }))).toEqual(['acwr_high', 'monotony_high']);
    const sessions = [sess('2026-04-28'), sess('2026-05-04', { duration_s: 4500 })];
    expect(loadFlags(day({ date: '2026-05-05', tsb: -45, warming_up: true }), sessions).map((f) => f.code)).toEqual(['week_jump']);
  });

  it('custom thresholds override the defaults', () => {
    const flags = resolveLoadFlags({ acwr_high: 1.2, tsb_low: -10 });
    expect(flags).toEqual({ ...DEFAULT_LOAD_FLAGS, acwr_high: 1.2, tsb_low: -10 });
    expect(codes(day({ acwr: 1.25, tsb: -11 }), flags)).toEqual(['acwr_high', 'tsb_low']);
    expect(resolveLoadFlags({ acwr_high: Number.NaN, acwr_warn: undefined })).toEqual(DEFAULT_LOAD_FLAGS);
    expect(resolveLoadFlags()).toEqual(DEFAULT_LOAD_FLAGS);
  });

  it('hr_method is zones by default and takes only zones or avg', () => {
    expect(DEFAULT_LOAD_FLAGS.hr_method).toBe('zones');
    expect(resolveLoadFlags({ hr_method: 'avg' }).hr_method).toBe('avg');
    expect(resolveLoadFlags({ hr_method: 'peak', acwr_high: 'x' })).toEqual(DEFAULT_LOAD_FLAGS);
  });

  it('adds the week jump of the day', () => {
    // last 7 days of 2026-05-05: 2026-04-29..2026-05-05; the 7 before: 2026-04-22..2026-04-28
    const sessions = [sess('2026-04-28'), sess('2026-05-04', { duration_s: 4500 })];
    expect(loadFlags(day({ date: '2026-05-05' }), sessions).map((f) => f.code)).toEqual(['week_jump']);
  });
});

describe('weekJump', () => {
  // asOf 2026-05-07: last 7 days 2026-05-01..2026-05-07, the 7 before 2026-04-24..2026-04-30
  const prev = [sess('2026-04-28'), sess('2026-04-30', { sport: 'bike', distance_m: 40_000 })];

  it('flags growth of total hours above the limit', () => {
    const cur = [sess('2026-05-05', { sport: 'bike', duration_s: 7200 }), sess('2026-05-06', { sport: 'bike', duration_s: 2000 })];
    const f = weekJump([...prev, ...cur], '2026-05-07', 15);
    expect(f?.code).toBe('week_jump');
    expect(f?.text).toBe('hours +28% (2 → 2.6 h, last 7 days vs the 7 before); above the 15% rule of thumb.');
    expect(f?.text).not.toContain('running km');
  });

  it('flags growth of running km even with fewer hours', () => {
    const cur = [sess('2026-05-05', { distance_m: 12_000 })];
    const f = weekJump([...prev, ...cur], '2026-05-07', 15);
    expect(f?.text).toMatch(/^running km \+20% \(10 → 12 km, last 7 days vs the 7 before\)/);
    expect(f?.text).not.toContain('hours');
  });

  it('no flag at or below the limit, after `asOf`, or with an empty reference window', () => {
    expect(weekJump([...prev, sess('2026-05-05', { duration_s: 8100, distance_m: 11_000 })], '2026-05-07', 15)).toBeUndefined();
    expect(weekJump([...prev, sess('2026-05-08', { duration_s: 20_000 })], '2026-05-07', 15)).toBeUndefined();
    expect(weekJump([sess('2026-05-05')], '2026-05-07', 15)).toBeUndefined();
  });

  it('no flag with less than 1 h in the reference window', () => {
    const cur = [sess('2026-05-05', { duration_s: 10_800, distance_m: 30_000 })];
    expect(weekJump([sess('2026-04-28', { duration_s: 3000 }), ...cur], '2026-05-07', 15)).toBeUndefined();
    expect(weekJump([sess('2026-04-28', { duration_s: 3600 }), ...cur], '2026-05-07', 15)?.code).toBe('week_jump');
  });

  it('a Tuesday after a heavy week sees the jump that ISO weeks lost', () => {
    // 2026-05-12 is a Tuesday: its ISO week (W20) has no sessions yet against a heavy W19,
    // but the last 7 days (2026-05-06..2026-05-12) hold the heavy days against a light 7 before
    const light = [sess('2026-04-29'), sess('2026-05-01'), sess('2026-05-03')];
    const heavy = ['2026-05-06', '2026-05-07', '2026-05-08', '2026-05-09', '2026-05-10'].map((d) => sess(d));
    const tooOld = sess('2026-04-28', { duration_s: 36_000, distance_m: 100_000 });
    const f = weekJump([tooOld, ...light, ...heavy], '2026-05-12', 15);
    expect(f?.text).toBe(
      'hours +67% (3 → 5 h, last 7 days vs the 7 before), running km +67% (30 → 50 km, last 7 days vs the 7 before); above the 15% rule of thumb.',
    );
  });
});

describe('weeklyBySport', () => {
  it('sums sessions per ISO week and sport with rounded totals and zone hours', () => {
    const rows = weeklyBySport([
      sess('2026-05-04', { week: '2026-W19', duration_s: 3000, distance_m: 9876, elev_gain_m: 120, tss: 70.6, hrtss: 55.4, g_load: 80, z1_s: 600, z2_s: 1200, z3_s: 600, z4_s: 300, z5_s: 300 }),
      sess('2026-05-06', { week: '2026-W19', duration_s: 1800, distance_m: 5000, tss: 30.3, hrtss: 30.3 }),
      sess('2026-05-05', { week: '2026-W19', sport: 'bike', duration_s: 5400, distance_m: 45_000 }),
      sess('2026-04-30', { week: '2026-W18', duration_s: 3600 }),
    ]);
    expect(rows.map((r) => `${r.week} ${r.sport}`)).toEqual(['2026-W18 run', '2026-W19 bike', '2026-W19 run']);
    expect(rows[2]).toEqual({
      week: '2026-W19',
      sport: 'run',
      sessions: 2,
      hours: 1.33,
      km: 14.9,
      elev_m: 120,
      tss: 101,
      hrtss: 86,
      g_load: 80,
      z12_h: 0.5,
      z3_h: 0.17,
      z45_h: 0.17,
    });
    expect(rows[1]).toMatchObject({ sessions: 1, hours: 1.5, km: 45, g_load: 0, z12_h: 0 });
  });

  it('shows nordic and row as their own groups', () => {
    const rows = weeklyBySport([
      sess('2026-05-04', { week: '2026-W19', sport: 'nordic', duration_s: 5400, distance_m: 20_000 }),
      sess('2026-05-05', { week: '2026-W19', sport: 'row', duration_s: 1800, distance_m: 6000 }),
      sess('2026-05-06', { week: '2026-W19', sport: 'hike', duration_s: 7200, distance_m: 8000 }),
    ]);
    expect(rows.map((r) => [r.sport, r.hours, r.km])).toEqual([
      ['hike', 2, 8],
      ['nordic', 1.5, 20],
      ['row', 0.5, 6],
    ]);
  });
});

describe('loadRatio', () => {
  const TO = '2026-10-10';
  const currentFrom = addDays(TO, -(LOAD_RATIO_DAYS - 1));
  /** Daily sessions with Garmin load 100 from `from`: own TSS 70 before the current window, `current` inside it. */
  const history = (from: string, current: number) =>
    eachDay(from, TO).map((d) => sess(d, { g_load: 100, tss: d < currentFrom ? 70 : current, hrtss: 70 }));
  const nineWindows = addDays(currentFrom, -9 * LOAD_RATIO_DAYS);

  it('flags a drift upwards against the median of the earlier 28-day windows', () => {
    expect(loadRatio(history(nineWindows, 100), 'auto', TO)).toEqual({ ratio_28d: 1, usual: 0.7, windows: 9, drifted: true });
  });

  it('flags a drift downwards', () => {
    expect(loadRatio(history(nineWindows, 50), 'auto', TO)).toMatchObject({ ratio_28d: 0.5, usual: 0.7, drifted: true });
  });

  it('stays quiet within 25 % of the usual ratio and reads hrTSS with source hrtss', () => {
    expect(loadRatio(history(nineWindows, 80), 'auto', TO)).toMatchObject({ ratio_28d: 0.8, usual: 0.7, drifted: false });
    expect(loadRatio(history(nineWindows, 100), 'hrtss', TO)).toMatchObject({ ratio_28d: 0.7, usual: 0.7, drifted: false });
  });

  it('has no usual ratio and no drift without 8 earlier windows', () => {
    const r = loadRatio(history(addDays(currentFrom, -7 * LOAD_RATIO_DAYS), 100), 'auto', TO);
    expect(r).toEqual({ ratio_28d: 1, windows: 7, drifted: false });
    expect(loadRatio([], 'auto', TO)).toEqual({ windows: 0, drifted: false });
  });

  it('counts only days that have both loads and ignores sessions after to', () => {
    const sessions = [
      sess(TO, { tss: 80, g_load: 100 }),
      sess(addDays(TO, -1), { tss: 500, g_load: undefined }),
      sess(addDays(TO, -2), { tss: undefined, load_source: 'none', g_load: 300 }),
      sess(addDays(TO, 1), { tss: 10, g_load: 100 }),
    ];
    expect(loadRatio(sessions, 'auto', TO)).toMatchObject({ ratio_28d: 0.8, windows: 0 });
  });
});
