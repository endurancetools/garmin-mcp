import fs from 'node:fs';
import path from 'node:path';
import { addDays, eachDay } from 'garmin-mcp-config';
import { Store, type ThresholdParam } from 'garmin-mcp-store';
import { describe, expect, it } from 'vitest';
import {
  ftpEstimate,
  garminThresholdChanges,
  lt1For,
  lthrFor,
  profileThresholds,
  profileZoneFloors,
  profileZones,
  recordGarminHistory,
  recordProfileThresholds,
  restingHrOn,
  thresholdOn,
  thresholdPaceFromSpeed,
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

describe('running threshold pace from the profile', () => {
  it('reads userData.lactateThresholdSpeed (units of 10 m/s) as whole seconds per km', () => {
    // the value of packages/client/fixtures/user-settings.json: 3.5 m/s, 4:46 per km
    const raw = { settings: { userData: { lactateThresholdSpeed: 0.35 } } };
    expect(profileThresholds(raw)).toEqual([{ param: 'run_threshold_pace_s_per_km', value: 286 }]);
  });

  it('takes a value of 1 or more as m/s and drops implausible paces', () => {
    expect(thresholdPaceFromSpeed(4)).toBe(250);
    expect(thresholdPaceFromSpeed(0.4)).toBe(250);
    expect(thresholdPaceFromSpeed(0.05)).toBeUndefined();
    expect(thresholdPaceFromSpeed(12)).toBeUndefined();
    expect(thresholdPaceFromSpeed(0)).toBeUndefined();
    expect(thresholdPaceFromSpeed(undefined)).toBeUndefined();
  });
});

describe('profileZoneFloors', () => {
  const zone = (sport: string, floors: (number | null)[], max: number | null = 175) => ({
    sport,
    zone1Floor: floors[0],
    zone2Floor: floors[1],
    zone3Floor: floors[2],
    zone4Floor: floors[3],
    zone5Floor: floors[4],
    maxHeartRateUsed: max,
  });

  it('reads the DEFAULT and CYCLING zone floors and HRmax', () => {
    expect(
      profileZoneFloors({ heartRateZones: [zone('DEFAULT', [89, 127, 146, 154, 165]), zone('CYCLING', [103, 126, 140, 150, 158]), zone('RUNNING', [1, 2, 3, 4, 5])] }),
    ).toEqual({
      DEFAULT: { zone1Floor: 89, zone2Floor: 127, zone3Floor: 146, zone4Floor: 154, zone5Floor: 165, maxHeartRateUsed: 175 },
      CYCLING: { zone1Floor: 103, zone2Floor: 126, zone3Floor: 140, zone4Floor: 150, zone5Floor: 158, maxHeartRateUsed: 175 },
    });
  });

  it('leaves out a sport with a missing or non-rising bound', () => {
    expect(profileZoneFloors({ heartRateZones: [zone('DEFAULT', [89, 127, null, 154, 165]), zone('CYCLING', [103, 126, 140, 150, 158], 150)] })).toEqual({});
    expect(profileZoneFloors({ heartRateZones: [zone('DEFAULT', [89, 127, 127, 154, 165])] })).toEqual({});
    expect(profileZoneFloors(profile())).toEqual({});
    expect(profileZoneFloors(null)).toEqual({});
    expect(profileZoneFloors({ heartRateZones: 'x' })).toEqual({});
  });
});

/** A response fixture of garmin-mcp-client, the shape the profile stores. */
const clientFixture = (name: string): unknown =>
  JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../client/fixtures', `${name}.json`), 'utf8')) as unknown;

describe('profileZones', () => {
  it('reads HR and power zones of every sport from the client fixtures', () => {
    const zones = profileZones({ heartRateZones: clientFixture('heart-rate-zones'), powerZones: clientFixture('power-zones') });
    expect(zones).toEqual({
      hr: {
        default: { method: 'HR_MAX', floors: [89, 127, 146, 154, 165], hrmax: 175, rhr: 50, lthr: 160 },
        cycling: { method: 'HR_MAX', floors: [103, 126, 140, 150, 158], hrmax: 175, rhr: 50, lthr: 160 },
      },
      power: {
        cycling: { floors: [0, 109, 152, 178, 211, 236, 300], ftp: 200 },
        cross_country_skiing: { floors: [0, 110, 151, 181, 210, 240, 300], ftp: 200 },
        // Zones 6 and 7 are 0 in the profile: running has five power zones.
        running: { floors: [129, 157, 179, 198, 227], ftp: 200 },
        rowing: { floors: [0, 110, 150, 180, 210, 240, 300], ftp: 200 },
      },
    });
  });

  it('leaves out a sport with fewer than five rising floors, keeps the first of a repeated sport', () => {
    expect(
      profileZones({
        heartRateZones: [
          { sport: 'DEFAULT', zone1Floor: 89, zone2Floor: 127, zone3Floor: 127, zone4Floor: 154, zone5Floor: 165 },
          { sport: 'CYCLING', zone1Floor: 103, zone2Floor: 126, zone3Floor: 140, zone4Floor: 150, zone5Floor: 158 },
          { sport: 'CYCLING', zone1Floor: 1, zone2Floor: 2, zone3Floor: 3, zone4Floor: 4, zone5Floor: 5 },
          { zone1Floor: 1, zone2Floor: 2, zone3Floor: 3, zone4Floor: 4, zone5Floor: 5 },
        ],
        powerZones: [{ sport: 'CYCLING', functionalThresholdPower: 250, zone1Floor: 0, zone2Floor: 100, zone3Floor: 0 }],
      }),
    ).toEqual({ hr: { cycling: { floors: [103, 126, 140, 150, 158] } }, power: {} });
    expect(profileZones(profile())).toEqual({ hr: {}, power: {} });
    expect(profileZones(null)).toEqual({ hr: {}, power: {} });
    expect(profileZones({ heartRateZones: 'x', powerZones: [null] })).toEqual({ hr: {}, power: {} });
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

/** Garmin's threshold history as the recordings in garmin-mcp-client's fixtures give it. */
const history = () => ({
  lthr_hr: clientFixture('lactate-threshold-range'),
  lthr_speed: clientFixture('lactate-threshold-speed-range'),
  ftp: clientFixture('cycling-ftp'),
  fetched_at: T,
});

describe('garminThresholdChanges', () => {
  it('keeps the changes of each series from the recorded fixtures, oldest first', () => {
    const changes = garminThresholdChanges(history()).map((c) => [c.date, c.param, c.value]);
    expect(changes).toEqual([
      // 146 is repeated on seven days up to 2026-01-22: one row.
      ['2025-11-17', 'lthr_run', 146],
      ['2026-01-27', 'lthr_run', 159],
      ['2026-02-28', 'lthr_run', 157],
      ['2026-03-01', 'lthr_run', 160],
      ['2026-03-07', 'lthr_run', 158],
      ['2026-03-08', 'lthr_run', 160],
      // 0.340141 is 3.40141 m/s, 4:54 per km; 2026-03-07 repeats 2026-03-01.
      ['2025-11-17', 'run_threshold_pace_s_per_km', 294],
      ['2026-01-27', 'run_threshold_pace_s_per_km', 296],
      ['2026-02-28', 'run_threshold_pace_s_per_km', 301],
      ['2026-03-01', 'run_threshold_pace_s_per_km', 292],
      ['2026-03-08', 'run_threshold_pace_s_per_km', 286],
      ['2026-11-03', 'ftp_w', 200],
    ]);
  });

  it('leaves out rows without a date or a usable value, and sorts by date', () => {
    expect(
      garminThresholdChanges({
        lthr_hr: [{ from: '2026-03-02', value: 170 }, { from: 'x', value: 171 }, { from: '2026-03-01', value: 0 }, { value: 172 }, null, { from: '2026-02-01', value: 168 }],
        lthr_speed: [{ from: '2026-03-01', value: 50 }],
        ftp: { calendarDate: null, functionalThresholdPower: 250 },
      }),
    ).toEqual([
      { date: '2026-02-01', param: 'lthr_run', value: 168 },
      { date: '2026-03-02', param: 'lthr_run', value: 170 },
    ]);
    expect(garminThresholdChanges(undefined)).toEqual([]);
    expect(garminThresholdChanges({ lthr_hr: null, lthr_speed: {}, ftp: [] })).toEqual([]);
  });
});

describe('recordGarminHistory', () => {
  it("backfills garmin-auto rows with Garmin's dates, once", () => {
    const store = Store.open(':memory:');
    expect(recordGarminHistory(store, T)).toEqual({ added: [] });
    store.setThresholdHistory(history());
    expect(recordGarminHistory(store, T).added).toHaveLength(12);
    expect(store.listThresholds('ftp_w')).toMatchObject([{ date: '2026-11-03', value: 200, source: 'garmin-auto', created_at: T }]);
    expect(thresholdOn(store.listThresholds(), 'run_threshold_pace_s_per_km', '2026-02-28')).toBe(301);
    expect(thresholdOn(store.listThresholds(), 'lthr_run', '2026-03-07')).toBe(158);

    // The next day's download: the same history again, and a window that no longer reaches the first row.
    expect(recordGarminHistory(store, T + 1)).toEqual({ added: [] });
    const later = history();
    store.setThresholdHistory({ ...later, lthr_hr: (later.lthr_hr as unknown[]).slice(3) });
    expect(recordGarminHistory(store, T + 2)).toEqual({ added: [] });
    expect(store.listThresholds().filter((r) => r.source === 'garmin-auto')).toHaveLength(12);

    // The profile then has the latest value already: no profile row either.
    store.setProfile(profile(160), Date.parse('2026-10-07T23:30:00Z'));
    expect(recordProfileThresholds(store, T + 3, TZ).added.map((r) => r.param)).not.toContain('lthr_run');
  });

  it('skips a change the garmin-auto row in effect already has', () => {
    const store = Store.open(':memory:');
    // A profile row recorded before the history was downloaded.
    store.addThreshold({ date: '2025-11-01', param: 'lthr_run', value: 146, source: 'garmin-auto', created_at: T });
    store.setThresholdHistory(history());
    const lthr = recordGarminHistory(store, T + 1).added.filter((r) => r.param === 'lthr_run');
    expect(lthr.map((r) => [r.date, r.value])).toEqual([
      ['2026-01-27', 159],
      ['2026-02-28', 157],
      ['2026-03-01', 160],
      ['2026-03-07', 158],
      ['2026-03-08', 160],
    ]);
  });

  it('leaves test, manual and import rows as they are; a test on the same date keeps precedence', () => {
    const store = Store.open(':memory:');
    store.addThreshold({ date: '2026-03-01', param: 'lthr_run', value: 178, source: 'test', created_at: T });
    store.addThreshold({ date: '2026-02-28', param: 'run_threshold_pace_s_per_km', value: 270, source: 'manual', created_at: T });
    store.addThreshold({ date: '2026-11-03', param: 'ftp_w', value: 245, source: 'import', created_at: T });
    store.setThresholdHistory(history());
    const added = recordGarminHistory(store, T + 1).added.map((r) => [r.date, r.param]);
    expect(added).not.toContainEqual(['2026-03-01', 'lthr_run']);
    expect(added).not.toContainEqual(['2026-02-28', 'run_threshold_pace_s_per_km']);
    expect(added).not.toContainEqual(['2026-11-03', 'ftp_w']);
    expect(added).toHaveLength(9);
    const rows = store.listThresholds();
    expect(rows.filter((r) => r.source !== 'garmin-auto').map((r) => [r.date, r.param, r.value])).toEqual([
      ['2026-11-03', 'ftp_w', 245],
      ['2026-03-01', 'lthr_run', 178],
      ['2026-02-28', 'run_threshold_pace_s_per_km', 270],
    ]);
    expect(thresholdOn(rows, 'lthr_run', '2026-03-01')).toBe(178);
    expect(thresholdOn(rows, 'run_threshold_pace_s_per_km', '2026-02-28')).toBe(270);
    expect(thresholdOn(rows, 'ftp_w', '2026-11-03')).toBe(245);
    // The next change Garmin made applies from its own date.
    expect(thresholdOn(rows, 'lthr_run', '2026-03-07')).toBe(158);
    expect(recordGarminHistory(store, T + 2)).toEqual({ added: [] });
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

describe('ftpEstimate', () => {
  const effort = (activity_id: number, date: string, best_20min_w: number) => ({ activity_id, date, best_20min_w });

  it('is 95 % of the best 20 min power of the 90 days to the date, with its ride', () => {
    const est = ftpEstimate([effort(1, '2026-07-01', 300), effort(2, '2026-09-20', 280), effort(3, '2026-10-01', 291)], '2026-10-08');
    expect(est).toMatchObject({ value: 276, best_20min_w: 291, activity_id: 3, date: '2026-10-01' });
    expect(est?.note).toMatch(/^Estimate, not a test: 95 % of the best 20 min power of the rides from 2026-07-10 to 2026-10-08/);
    expect(est?.note).toMatch(/set_threshold/);
  });

  it('counts the first day of the window and the date itself, not later rides; a tie takes the later ride', () => {
    expect(ftpEstimate([effort(1, '2026-07-10', 300), effort(2, '2026-10-09', 400)], '2026-10-08')).toMatchObject({ value: 285, activity_id: 1 });
    expect(ftpEstimate([effort(1, '2026-07-09', 300)], '2026-10-08')).toBeUndefined();
    expect(ftpEstimate([effort(1, '2026-09-01', 260), effort(2, '2026-10-08', 260)], '2026-10-08')).toMatchObject({ value: 247, activity_id: 2, date: '2026-10-08' });
    expect(ftpEstimate([], '2026-10-08')).toBeUndefined();
  });
});
