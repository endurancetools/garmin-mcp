import { addDays, eachDay } from 'garmin-mcp-config';
import { Store, type ThresholdParam } from 'garmin-mcp-store';
import { describe, expect, it } from 'vitest';
import {
  lt1For,
  lthrFor,
  profileThresholds,
  recordProfileThresholds,
  restingHrOn,
  thresholdOn,
  type ThresholdPoint,
} from './thresholds.js';

const T = 1_791_400_000_000;
const TZ = 'Europe/Warsaw';
const row = (date: string, param: ThresholdParam, value: number): ThresholdPoint => ({ date, param, value });

function profile(lthr = 168, extra: { vo2?: number } = {}) {
  return {
    social: {},
    settings: { userData: { lactateThresholdHeartRate: 999, vo2MaxRunning: extra.vo2 ?? 52 } },
    heartRateZones: [
      { sport: 'DEFAULT', maxHeartRateUsed: 192, restingHeartRateUsed: 48, lactateThresholdHeartRateUsed: lthr },
      { sport: 'CYCLING', lactateThresholdHeartRateUsed: 160 },
    ],
    powerZones: [
      { sport: 'CYCLING', functionalThresholdPower: 250 },
      { sport: 'RUNNING', functionalThresholdPower: 310 },
    ],
  };
}

describe('profileThresholds', () => {
  it('reads every parameter from the profile', () => {
    expect(profileThresholds(profile())).toEqual([
      { param: 'hrmax', value: 192 },
      { param: 'rhr', value: 48 },
      { param: 'lthr_run', value: 168 },
      { param: 'lthr_bike', value: 160 },
      { param: 'ftp_w', value: 250 },
      { param: 'run_ftp_w', value: 310 },
      { param: 'vo2max_run', value: 52 },
    ]);
  });

  it('falls back to userData LTHR and skips missing values', () => {
    expect(
      profileThresholds({
        settings: { userData: { lactateThresholdHeartRate: 171 } },
        heartRateZones: [{ sport: 'DEFAULT', maxHeartRateUsed: null }],
        powerZones: null,
      }),
    ).toEqual([{ param: 'lthr_run', value: 171 }]);
    expect(profileThresholds(null)).toEqual([]);
    expect(profileThresholds({ heartRateZones: 'x' })).toEqual([]);
  });
});

describe('recordProfileThresholds', () => {
  it('adds garmin-auto rows only when a value changes', () => {
    const store = Store.open(':memory:');
    expect(recordProfileThresholds(store, T, TZ)).toEqual({ added: [] });

    // 2026-10-07 23:30 UTC is 2026-10-08 in Warsaw.
    store.setProfile(profile(), Date.parse('2026-10-07T23:30:00Z'));
    expect(recordProfileThresholds(store, T, TZ).added).toHaveLength(7);
    expect(store.listThresholds('lthr_run')).toMatchObject([{ date: '2026-10-08', value: 168, source: 'garmin-auto', created_at: T }]);

    // Same profile again: nothing new.
    expect(recordProfileThresholds(store, T + 1, TZ)).toEqual({ added: [] });

    // Manual and test rows do not count as the last garmin-auto value.
    store.addThreshold({ date: '2026-10-09', param: 'lthr_run', value: 172, source: 'test', created_at: T + 2 });
    expect(recordProfileThresholds(store, T + 3, TZ)).toEqual({ added: [] });

    store.setProfile(profile(170, { vo2: 53 }), Date.parse('2026-10-12T08:00:00Z'));
    expect(recordProfileThresholds(store, T + 4, TZ).added).toEqual([
      { date: '2026-10-12', param: 'lthr_run', value: 170, source: 'garmin-auto', created_at: T + 4 },
      { date: '2026-10-12', param: 'vo2max_run', value: 53, source: 'garmin-auto', created_at: T + 4 },
    ]);
    expect(store.listThresholds('lthr_run').map((r) => [r.date, r.value, r.source])).toEqual([
      ['2026-10-08', 168, 'garmin-auto'],
      ['2026-10-09', 172, 'test'],
      ['2026-10-12', 170, 'garmin-auto'],
    ]);
    expect(recordProfileThresholds(store, T + 5, TZ)).toEqual({ added: [] });

    // A change back to an older value is a change too.
    store.setProfile(profile(168, { vo2: 53 }), Date.parse('2026-10-14T08:00:00Z'));
    expect(recordProfileThresholds(store, T + 6, TZ).added.map((r) => [r.date, r.param, r.value])).toEqual([['2026-10-14', 'lthr_run', 168]]);
  });
});

describe('thresholdOn', () => {
  const rows = [row('2026-06-01', 'lthr_run', 168), row('2026-09-10', 'lthr_run', 171), row('2026-05-01', 'hrmax', 192)];

  it('returns the value of the latest row on or before the date', () => {
    expect(thresholdOn(rows, 'lthr_run', '2026-06-01')).toBe(168);
    expect(thresholdOn(rows, 'lthr_run', '2026-09-09')).toBe(168);
    expect(thresholdOn(rows, 'lthr_run', '2026-09-10')).toBe(171);
    expect(thresholdOn(rows, 'lthr_run', '2027-01-01')).toBe(171);
    expect(thresholdOn(rows, 'hrmax', '2026-10-01')).toBe(192);
  });

  it('carries the first row back before the history starts', () => {
    expect(thresholdOn(rows, 'lthr_run', '2025-01-01')).toBe(168);
  });

  it('is undefined without rows of the param', () => {
    expect(thresholdOn(rows, 'lthr_bike', '2026-10-01')).toBeUndefined();
    expect(thresholdOn([], 'rhr', '2026-10-01')).toBeUndefined();
  });

  it('ignores the input order of dates and lets the later row of one date win', () => {
    const mixed = [row('2026-09-10', 'lthr_run', 171), row('2026-06-01', 'lthr_run', 168), row('2026-09-10', 'lthr_run', 173)];
    expect(thresholdOn(mixed, 'lthr_run', '2026-07-01')).toBe(168);
    expect(thresholdOn(mixed, 'lthr_run', '2026-09-10')).toBe(173);
  });
});

describe('lthrFor and lt1For', () => {
  const rows = [row('2026-06-01', 'lthr_run', 170), row('2026-06-01', 'lthr_bike', 160)];

  it('picks the sport LTHR with fallback to running, then to HRmax, then to the default', () => {
    expect(lthrFor(rows, 'run', '2026-07-01')).toEqual({ value: 170 });
    expect(lthrFor(rows, 'bike', '2026-07-01')).toEqual({ value: 160 });
    expect(lthrFor(rows, 'swim', '2026-07-01')).toEqual({ value: 170 });
    expect(lthrFor([...rows, row('2026-06-01', 'lthr_swim', 150)], 'swim', '2026-07-01')).toEqual({ value: 150 });
    expect(lthrFor(rows, 'hike', '2026-07-01')).toEqual({ value: 170 });
    expect(lthrFor([row('2026-06-01', 'lthr_bike', 160)], 'run', '2026-07-01')).toMatchObject({ value: 170, note: expect.stringMatching(/default 170/) });
    expect(lthrFor([], 'run', '2026-07-01')).toMatchObject({ value: 170, note: expect.stringMatching(/no HRmax.*default 170/) });
  });

  it('estimates LTHR as 0.89 × HRmax when the history has HRmax but no LTHR', () => {
    const hrmax = [row('2026-06-01', 'hrmax', 185)];
    // 0.89 × 185 = 164.65.
    expect(lthrFor(hrmax, 'run', '2026-07-01')).toEqual({
      value: 165,
      note: expect.stringMatching(/estimated from HRmax; confirm with a test/),
    });
    expect(lthrFor(hrmax, 'bike', '2026-07-01')).toMatchObject({ value: 165 });
    // HRmax of the day: a later row applies from its date on; the first one is carried back.
    const two = [...hrmax, row('2026-09-01', 'hrmax', 190)];
    expect(lthrFor(two, 'run', '2026-05-01').value).toBe(165);
    expect(lthrFor(two, 'run', '2026-09-01').value).toBe(169);
    // An LTHR row wins over the estimate.
    expect(lthrFor([...hrmax, row('2026-06-01', 'lthr_run', 172)], 'run', '2026-07-01')).toEqual({ value: 172 });
    // LT1 follows the estimate.
    expect(lt1For(hrmax, 'run', '2026-07-01')).toMatchObject({ value: 149, note: expect.stringMatching(/estimated from HRmax.*LT1 approximated/) });
  });

  it('uses the lt1_hr row, else 0.90 × running LTHR; cycling 7 bpm lower without its own LTHR', () => {
    const runOnly = [row('2026-06-01', 'lthr_run', 170)];
    expect(lt1For([...runOnly, row('2026-06-01', 'lt1_hr', 150)], 'run', '2026-07-01')).toEqual({ value: 150 });
    expect(lt1For([...runOnly, row('2026-06-01', 'lt1_hr', 150)], 'bike', '2026-07-01')).toEqual({ value: 143 });
    expect(lt1For(runOnly, 'run', '2026-07-01')).toMatchObject({ value: 153, note: expect.stringMatching(/approximated/) });
    expect(lt1For(runOnly, 'bike', '2026-07-01')).toMatchObject({ value: 146, note: expect.stringMatching(/running LTHR/) });
    expect(lt1For(runOnly, 'swim', '2026-07-01')).toMatchObject({ value: 153 });
    // 0.9 × 175 = 157.5 rounds half up, as `printf "%d", l*0.90+0.5` in plan-v2.
    expect(lt1For([row('2026-06-01', 'lthr_run', 175)], 'run', '2026-07-01').value).toBe(158);
    expect(lt1For([], 'run', '2026-07-01')).toMatchObject({ value: 153, note: expect.stringMatching(/default 170.*approximated/) });
  });

  it('takes 0.90 × the sport LTHR for cycling and swimming with their own LTHR', () => {
    expect(lt1For(rows, 'bike', '2026-07-01')).toEqual({ value: 144, note: expect.stringMatching(/0\.90 × cycling LTHR/) });
    // The own LTHR wins over a running lt1_hr row.
    expect(lt1For([...rows, row('2026-06-01', 'lt1_hr', 150)], 'bike', '2026-07-01').value).toBe(144);
    expect(lt1For([...rows, row('2026-06-01', 'lt1_hr', 150)], 'run', '2026-07-01').value).toBe(150);
    // 0.9 × 155 = 139.5.
    expect(lt1For([...rows, row('2026-06-01', 'lthr_swim', 155)], 'swim', '2026-07-01')).toEqual({
      value: 140,
      note: expect.stringMatching(/swimming LTHR/),
    });
    // Before the first lthr_bike row the row is carried back, like every threshold.
    expect(lt1For(rows, 'bike', '2026-01-01').value).toBe(144);
  });
});

describe('restingHrOn', () => {
  const D = '2026-10-12';
  const days = (n: number, hr: (i: number) => number | null) =>
    eachDay(addDays(D, -n), addDays(D, -1)).map((date, i) => ({ date, resting_hr: hr(i) }));

  it('averages the 28 days before the date when 14 of them have a value', () => {
    const daily = [
      ...days(40, (i) => (i < 12 ? 90 : i % 2 === 0 ? 50 : 51)), // 12 days before the window are ignored
      { date: D, resting_hr: 99 }, // the day itself too
    ];
    expect(restingHrOn(daily, [], D)).toEqual({ value: 50.5 });
    // 14 samples is enough; rounded to 0.1.
    const sparse = days(28, (i) => (i < 14 ? null : i === 27 ? 53 : 50));
    expect(restingHrOn(sparse, [], D)).toEqual({ value: 50.2 });
  });

  it('falls back to the rhr threshold, then to 50', () => {
    const thirteen = days(28, (i) => (i < 15 ? null : 45));
    expect(restingHrOn(thirteen, [row('2026-01-01', 'rhr', 47)], D)).toEqual({ value: 47 });
    expect(restingHrOn(thirteen, [], D)).toMatchObject({ value: 50, note: expect.stringMatching(/default 50/) });
    expect(restingHrOn([], [], D)).toMatchObject({ value: 50 });
  });
});
