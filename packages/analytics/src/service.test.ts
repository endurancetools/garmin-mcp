import fs from 'node:fs';
import path from 'node:path';
import { addDays, eachDay, InputError } from 'garmin-mcp-config';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { loadOutput, readinessOutput, setThresholdOutput, thresholdsOutput } from './output.js';
import { activity, NOW, setup, TODAY } from './test-utils/fake.js';

/** The compile-time check of `apps/mcp-server/src/tools.ts`: a service result must fit its output schema. */
type Fits<T> = T extends readonly (infer E)[]
  ? readonly Fits<E>[]
  : T extends object
    ? {
        [K in keyof T as K extends string ? (string extends K ? (unknown extends T[K] ? never : K) : K) : never]: undefined extends T[K]
          ? Fits<T[K]> | null
          : string extends K
            ? Fits<T[K]> | undefined
            : Fits<T[K]>;
      }
    : T;

const fits = <O extends z.ZodType>(_schema: O, value: Fits<z.output<O>>) => value;

function profile(lthr: number) {
  return {
    social: {},
    settings: { userData: { vo2MaxRunning: 52 } },
    heartRateZones: [{ sport: 'DEFAULT', maxHeartRateUsed: 192, restingHeartRateUsed: 48, lactateThresholdHeartRateUsed: lthr }],
    powerZones: [],
  };
}

/** Daily 1 h runs at 150 bpm from June, resting HR 50 from May, LTHR 170: hrTSS 69.4 a day; profile synced, empty. */
function trained() {
  const t = setup();
  t.store.markReferenceFetched('profile', NOW);
  t.activities(t.dailyRuns('2026-06-01', TODAY), '2026-06-01', TODAY);
  t.daily('daily_summary', '2026-05-01', TODAY, () => ({ resting_hr: 50, avg_stress: 30, body_battery_high: 80 }));
  t.store.addThreshold({ date: '2026-01-01', param: 'lthr_run', value: 170, source: 'manual', created_at: NOW });
  return t;
}

describe('AnalyticsService.getLoad', () => {
  it('answers the own load model in the tool envelope, from the cache', async () => {
    const { analytics, calls } = trained();
    const res = await analytics.getLoad({ include_series: true, include_activities: true, include_efficiency: true });
    fits(loadOutput, res);
    expect(loadOutput.safeParse(res).success).toBe(true);
    expect(res.meta.source).toBe('cache');
    expect(res.meta.sync_hint).toBeUndefined();
    expect(res.data).toMatchObject({
      from: '2026-09-11',
      to: TODAY,
      source: 'auto',
      latest: { date: TODAY, tss: 69.4, acwr: 1, monotony: 0, strain: 0, warming_up: false, load_ratio_28d: 0.69 },
      thresholds_used: {
        date: TODAY,
        by_sport: {
          run: { lthr: 170, lt1: 153 },
          bike: { lthr: 170, lt1: 146, lthr_note: 'No lthr_bike in the threshold history; the running LTHR is used.' },
          swim: { lthr: 170, lt1: 153 },
        },
        rhr: 50,
      },
      intensity: { z1_pct: 100, sessions_by_avg_hr: 28, z1_below_target: false },
      flags_used: { acwr_high: 1.5, z1_min_pct: 75 },
    });
    expect(res.data.latest?.ctl).toBeGreaterThan(60);
    expect(res.data.flags).toBeUndefined();
    expect(res.data.series).toHaveLength(28);
    expect(res.data.activities).toHaveLength(28);
    expect(res.data.activities?.[0]).toMatchObject({ id: 103, date: '2026-09-11', sport: 'run', tss: 69.4, if: 0.833, load_source: 'hr', hrtss: 69.4, lthr_used: 170, lt1_used: 153, rhr_used: 50, source: 'db' });
    expect(res.data.efficiency?.map((e) => e.period)).toEqual(['2026-09', '2026-10']);
    expect(res.data.weeks?.at(-1)).toMatchObject({ week: '2026-W41', sport: 'run', sessions: 4, hours: 4, km: 40 });
    expect(res.data.note).toMatch(/differs from garmin_load_model in get_training_status and get_period_summary/);
    expect(res.meta.note).toMatch(/LT1 approximated/);
    // Four months of history: fewer than 8 earlier 28-day windows, so no usual ratio and no drift note.
    expect(res.data.latest?.load_ratio_usual).toBeUndefined();
    expect(res.meta.note).not.toMatch(/drifted/);
    expect(calls).toEqual([]);
  });

  it('sums Garmin training load with source garmin_load and applies own flag thresholds', async () => {
    const { analytics } = trained();
    const res = await analytics.getLoad({ source: 'garmin_load', flags: { tsb_fresh: -100, nope: 1, acwr_warn: 'x' } });
    expect(res.data.latest).toMatchObject({ tss: 100, acwr: 1 });
    expect(res.data.flags?.map((f) => f.code)).toEqual(['tsb_fresh']);
    expect(res.data.flags_used).toMatchObject({ tsb_fresh: -100, acwr_warn: 1.3 });
    expect(res.meta.note).toMatch(/Ignored flags .*: nope, acwr_warn/);
  });

  it('counts hiking in the intensity and EF only with flags.intensity_sports', async () => {
    const t = trained();
    // 2 h mountain walk below LT1 (153): grade adjusted speed 1.5 m/s, EF 90 / 130
    const hike = activity(9300, addDays(TODAY, -1), {
      activityName: 'Hike',
      activityType: { typeId: 3, typeKey: 'hiking' },
      duration: 7200,
      distance: 8000,
      elevationGain: 600,
      averageHR: 130,
      avgGradeAdjustedSpeed: 1.5,
    });
    t.activities([hike], addDays(TODAY, -1), TODAY);
    const plain = await t.analytics.getLoad({ include_efficiency: true, include_activities: true, flags: { z1_min_pct: 101 } });
    expect(plain.data.flags_used.intensity_sports).toEqual(['run', 'bike', 'nordic', 'row']);
    expect(plain.data.intensity).toMatchObject({ z1_min: 1680, sessions_by_avg_hr: 28 });
    expect(plain.data.flags?.find((f) => f.code === 'z1_below_target')?.text).toMatch(/^Z1 is 100% of run, bike, nordic and row time /);
    expect(plain.data.efficiency?.map((e) => e.sport)).toEqual(['run', 'run']);
    expect(plain.data.activities?.find((a) => a.id === 9300)).toMatchObject({ sport: 'hike', ef: 0.692, ef_gap: 0.692 });

    const sports = ['run', 'bike', 'nordic', 'row', 'hike'];
    const withHike = await t.analytics.getLoad({ include_efficiency: true, flags: { z1_min_pct: 101, intensity_sports: sports } });
    expect(loadOutput.safeParse(withHike).success).toBe(true);
    expect(withHike.data.flags_used.intensity_sports).toEqual(sports);
    expect(withHike.data.intensity).toMatchObject({ z1_min: 1800, sessions_by_avg_hr: 29 });
    expect(withHike.data.flags?.find((f) => f.code === 'z1_below_target')?.text).toMatch(/^Z1 is 100% of run, bike, nordic, row and hike time /);
    expect(withHike.data.efficiency?.at(-1)).toEqual({ period: '2026-10', sport: 'run', n: 8, ef_avg: 1.111, ef_max: 1.111 });
    expect(withHike.data.efficiency?.at(-2)).toEqual({ period: '2026-10', sport: 'hike', n: 1, ef_avg: 0.692, ef_max: 0.692, ef_gap_avg: 0.692 });

    const bad = await t.analytics.getLoad({ flags: { intensity_sports: ['run', 'walk'] } });
    expect(bad.data.flags_used.intensity_sports).toEqual(['run', 'bike', 'nordic', 'row']);
    expect(bad.meta.note).toMatch(/Ignored flags \(unknown key or invalid value\): intensity_sports/);
  });

  it('notes a drift of own load against Garmin load from the usual ratio; none with source garmin_load', async () => {
    const t = setup();
    t.store.markReferenceFetched('profile', NOW);
    const recent = addDays(TODAY, -27);
    const before = t.dailyRuns('2025-12-01', addDays(recent, -1));
    const last28 = t.dailyRuns(recent, TODAY, before.length + 1, { activityTrainingLoad: 60 });
    t.activities([...before, ...last28], '2025-12-01', TODAY);
    t.daily('daily_summary', '2025-11-01', TODAY, () => ({ resting_hr: 50 }));
    t.store.addThreshold({ date: '2025-01-01', param: 'lthr_run', value: 170, source: 'manual', created_at: NOW });
    const res = await t.analytics.getLoad();
    expect(loadOutput.safeParse(res).success).toBe(true);
    expect(res.data.latest).toMatchObject({ load_ratio_28d: 1.16, load_ratio_usual: 0.69 });
    expect(res.meta.note).toContain('Own load vs Garmin load drifted (ratio 1.16 vs usual 0.69): check thresholds or the HR strap.');
    const garmin = await t.analytics.getLoad({ source: 'garmin_load' });
    expect(garmin.data.latest?.load_ratio_28d).toBeUndefined();
    expect(garmin.meta.note).not.toMatch(/drifted/);
  });

  it('auto takes power and pace before heart rate; source hrtss keeps the heart-rate numbers', async () => {
    const t = setup();
    t.store.markReferenceFetched('profile', NOW);
    const runs = t.dailyRuns('2026-06-01', addDays(TODAY, -1), 1, { avgGradeAdjustedSpeed: 3.5 });
    const ride = activity(9000, TODAY, { activityType: { typeKey: 'road_biking' }, normPower: 200 });
    t.activities([...runs, ride], '2026-06-01', TODAY);
    t.daily('daily_summary', '2026-05-01', TODAY, () => ({ resting_hr: 50 }));
    for (const [param, value] of [['lthr_run', 170], ['ftp_w', 250], ['run_threshold_pace_s_per_km', 250]] as const) {
      t.store.addThreshold({ date: '2026-01-01', param, value, source: 'manual', created_at: NOW });
    }
    const auto = await t.analytics.getLoad({ from: addDays(TODAY, -1), include_activities: true });
    expect(loadOutput.safeParse(auto).success).toBe(true);
    expect(auto.data.source).toBe('auto');
    expect(auto.data.activities?.map((a) => [a.load_source, a.tss, a.if, a.hrtss])).toEqual([
      ['pace', 76.6, 0.875, 69.4],
      ['power', 64, 0.8, 69.4],
    ]);
    expect(auto.data.latest?.tss).toBe(64);
    expect(auto.data.weeks?.find((w) => w.sport === 'bike')).toMatchObject({ tss: 64, hrtss: 69 });
    expect(auto.data.thresholds_used.by_sport).toMatchObject({ run: { lthr: 170, threshold_pace: 250 }, bike: { ftp: 250 } });
    expect(auto.data.note).toMatch(/from power .*else pace .*else heart rate/);
    const hr = await t.analytics.getLoad({ from: addDays(TODAY, -1), source: 'hrtss' });
    expect(hr.data.latest?.tss).toBe(69.4);
    expect(hr.data.latest?.ctl).toBeLessThan(auto.data.latest?.ctl ?? 0);
  });

  it('include_by_sport adds the load model of each sport group next to the unchanged total, and its columns in the series', async () => {
    const t = setup();
    t.store.markReferenceFetched('profile', NOW);
    const runs = t.dailyRuns('2026-06-01', TODAY);
    const rides = eachDay(addDays(TODAY, -9), TODAY).map((d, i) => activity(9000 + i, d, { activityType: { typeKey: 'road_biking' } }));
    t.activities([...runs, ...rides], '2026-06-01', TODAY);
    t.daily('daily_summary', '2026-05-01', TODAY, () => ({ resting_hr: 50 }));
    t.store.addThreshold({ date: '2026-01-01', param: 'lthr_run', value: 170, source: 'manual', created_at: NOW });
    const from = addDays(TODAY, -10);
    const plain = await t.analytics.getLoad({ from, include_series: true });
    expect(plain.data.by_sport).toBeUndefined();
    expect(plain.data.series?.[0]).not.toHaveProperty('run_ctl');
    const res = await t.analytics.getLoad({ from, include_series: true, include_by_sport: true });
    fits(loadOutput, res);
    expect(loadOutput.safeParse(res).success).toBe(true);
    expect(res.data.latest).toEqual(plain.data.latest);
    const { run, bike } = res.data.by_sport ?? {};
    expect(Object.keys(res.data.by_sport ?? {})).toEqual(['run', 'bike']);
    expect(run).toEqual({ ctl: expect.any(Number), atl: expect.any(Number), tsb: expect.any(Number), acwr: 1 });
    expect((run?.ctl ?? 0) + (bike?.ctl ?? 0)).toBeCloseTo(res.data.latest?.ctl ?? 0, 0);
    expect(bike?.ctl).toBeLessThan(run?.ctl ?? 0);
    expect(bike?.tsb).toBeLessThan(0);
    // Rides start 9 days before `to`: the first day of the range has only the run columns.
    expect(res.data.series?.[0]).toMatchObject({ ...plain.data.series?.[0], run_ctl: expect.any(Number) });
    expect(res.data.series?.[0]).not.toHaveProperty('bike_ctl');
    expect(res.data.series?.at(-1)).toMatchObject({ run_ctl: run?.ctl, bike_ctl: bike?.ctl, bike_tsb: bike?.tsb, bike_acwr: bike?.acwr });
    const noSeries = await t.analytics.getLoad({ from, include_by_sport: true });
    expect(noSeries.data.series).toBeUndefined();
    expect(noSeries.data.by_sport).toEqual(res.data.by_sport);
  });

  it('auto scores a swim from its speed against CSS (sTSS), and thresholds_used.by_sport.swim has css', async () => {
    const t = setup();
    t.store.markReferenceFetched('profile', NOW);
    const swim = activity(9050, TODAY, { activityType: { typeKey: 'lap_swimming' }, distance: 1600, duration: 1800, movingDuration: 1390, averageHR: 140 });
    t.activities([swim], addDays(TODAY, -1), TODAY);
    t.daily('daily_summary', addDays(TODAY, -40), TODAY, () => ({ resting_hr: 50 }));
    t.store.addThreshold({ date: '2026-01-01', param: 'lthr_run', value: 170, source: 'manual', created_at: NOW });
    const hrOnly = await t.analytics.getLoad({ from: TODAY, include_activities: true });
    expect(hrOnly.data.activities?.[0]?.load_source).toBe('hr');
    expect(hrOnly.data.thresholds_used.by_sport.swim.css).toBeUndefined();
    expect(hrOnly.meta.note).toContain('no css_s_per_100m');
    t.store.addThreshold({ date: '2026-01-01', param: 'css_s_per_100m', value: 80, source: 'manual', created_at: NOW });
    const auto = await t.analytics.getLoad({ from: TODAY, include_activities: true });
    expect(loadOutput.safeParse(auto).success).toBe(true);
    expect(auto.data.activities?.[0]).toMatchObject({ sport: 'swim', load_source: 'swim_pace', tss: 30.2, if: 0.921 });
    expect(auto.data.latest?.tss).toBe(30.2);
    expect(auto.data.thresholds_used.by_sport.swim).toMatchObject({ css: 80 });
    expect(auto.data.note).toMatch(/swimming speed \/ CSS/);
  });

  it('auto counts strength without heart rate from the session RPE of its summary detail; flags.rpe_calibration overrides 0.23', async () => {
    const t = setup();
    t.store.markReferenceFetched('profile', NOW);
    const lift = activity(9100, TODAY, { activityType: { typeKey: 'strength_training' }, averageHR: undefined, duration: 2700, distance: 0 });
    t.activities([lift], addDays(TODAY, -1), TODAY);
    t.store.putActivityDetail(9100, 'summary', { activityId: 9100, summaryDTO: { directWorkoutRpe: 60 } }, NOW);
    t.daily('daily_summary', addDays(TODAY, -40), TODAY, () => ({ resting_hr: 50 }));
    const auto = await t.analytics.getLoad({ from: TODAY, include_activities: true });
    expect(loadOutput.safeParse(auto).success).toBe(true);
    expect(auto.data.activities?.[0]).toMatchObject({ sport: 'strength', rpe: 6, tss: 62.1, load_source: 'rpe', hrtss: 0 });
    expect(auto.data.activities?.[0]?.if).toBeUndefined();
    expect(auto.data.latest?.tss).toBe(62.1);
    expect(auto.data.flags_used.rpe_calibration).toBe(0.23);
    expect(auto.data.note).toMatch(/else session RPE/);
    const own = await t.analytics.getLoad({ from: TODAY, include_activities: true, flags: { rpe_calibration: 0.2 } });
    expect(own.data.activities?.[0]).toMatchObject({ tss: 54, load_source: 'rpe' });
    expect(own.data.flags_used.rpe_calibration).toBe(0.2);
    const hr = await t.analytics.getLoad({ from: TODAY, source: 'hrtss' });
    expect(hr.data.latest?.tss).toBe(0);
  });

  it('heart rate from the time in zones with the profile zone bounds; flags.hr_method "avg" forces the average', async () => {
    const t = setup();
    const zones = { zone1Floor: 94, zone2Floor: 134, zone3Floor: 154, zone4Floor: 163, zone5Floor: 174 };
    t.store.setProfile({ ...profile(170), heartRateZones: [{ sport: 'DEFAULT', maxHeartRateUsed: 185, lactateThresholdHeartRateUsed: 170, ...zones }] }, NOW);
    // 5 × 3 min in zone 5, 32 min in zone 1, average HR 135.
    const run = activity(9200, TODAY, { duration: 2820, averageHR: 135, hrTimeInZone_1: 1920, hrTimeInZone_5: 900 });
    t.activities([run], addDays(TODAY, -1), TODAY);
    t.daily('daily_summary', addDays(TODAY, -40), TODAY, () => ({ resting_hr: 50 }));
    const byZones = await t.analytics.getLoad({ from: TODAY, include_activities: true });
    expect(loadOutput.safeParse(byZones).success).toBe(true);
    expect(byZones.data.activities?.[0]).toMatchObject({ load_source: 'hr', hr_method: 'zones', tss: 44.3, hrtss: 44.3 });
    expect(byZones.data.flags_used.hr_method).toBe('zones');
    const byAvg = await t.analytics.getLoad({ from: TODAY, include_activities: true, flags: { hr_method: 'avg' } });
    expect(byAvg.data.activities?.[0]).toMatchObject({ load_source: 'hr', hr_method: 'avg', tss: 39.3, hrtss: 39.3 });
    expect(byAvg.data.flags_used.hr_method).toBe('avg');
    const bad = await t.analytics.getLoad({ from: TODAY, flags: { hr_method: 'peak' } });
    expect(bad.data.flags_used.hr_method).toBe('zones');
    expect(bad.meta.note).toMatch(/Ignored flags \(unknown key or invalid value\): hr_method/);
  });

  it('decoupling_pct from the splits detail; activities without laps counted in one note', async () => {
    const t = setup();
    t.store.markReferenceFetched('profile', NOW);
    const yesterday = addDays(TODAY, -1);
    const ride = activity(9400, TODAY, { activityType: { typeKey: 'road_biking' }, duration: 3600, averageHR: 135 });
    const runs = [activity(9401, yesterday), activity(9402, addDays(TODAY, -2)), activity(9403, addDays(TODAY, -3), { duration: 1800 })];
    t.activities([ride, ...runs], addDays(TODAY, -3), TODAY);
    const laps = [130, 132, 134, 136, 138, 140].map((hr) => ({ duration: 600, averageHR: hr, averagePower: 200 }));
    t.store.putActivityDetail(9400, 'splits', { activityId: 9400, lapDTOs: laps }, NOW);
    t.store.addThreshold({ date: '2026-01-01', param: 'lthr_run', value: 170, source: 'manual', created_at: NOW });
    t.daily('daily_summary', addDays(TODAY, -40), TODAY, () => ({ resting_hr: 50 }));
    const res = await t.analytics.getLoad({ from: addDays(TODAY, -3), include_activities: true, include_efficiency: true });
    expect(loadOutput.safeParse(res).success).toBe(true);
    expect(res.data.activities?.find((a) => a.id === 9400)?.decoupling_pct).toBe(4.3);
    expect(res.data.activities?.filter((a) => a.decoupling_pct !== undefined)).toHaveLength(1);
    expect(res.data.efficiency?.find((e) => e.sport === 'bike')).toMatchObject({ decoupling_mean_pct: 4.3, decoupling_n: 1 });
    // Two 60-min runs below LTHR without laps; the 30-min run does not qualify.
    expect(res.meta.note).toContain('decoupling_pct needs the laps of an activity: 2 activities of 60 min or more below LTHR');
    const plain = await t.analytics.getLoad({ from: addDays(TODAY, -3) });
    expect(plain.meta.note ?? '').not.toMatch(/decoupling_pct/);
  });

  it('marks a week of history as warming up: no TSB flag in get_load, load signal unknown in get_readiness', async () => {
    const t = setup();
    t.store.markReferenceFetched('profile', NOW);
    t.activities(t.dailyRuns(addDays(TODAY, -6), TODAY), addDays(TODAY, -60), TODAY);
    t.daily('daily_summary', addDays(TODAY, -60), TODAY, () => ({ resting_hr: 50, avg_stress: 30, body_battery_high: 80 }));
    t.store.addThreshold({ date: '2026-01-01', param: 'lthr_run', value: 170, source: 'manual', created_at: NOW });
    const load = await t.analytics.getLoad();
    expect(loadOutput.safeParse(load).success).toBe(true);
    expect(load.data.latest).toMatchObject({ date: TODAY, warming_up: true });
    expect(load.data.latest?.tsb).toBeLessThan(-20);
    expect(load.data.flags?.map((f) => f.code) ?? []).not.toContain('tsb_low');
    const res = await t.analytics.getReadiness({ date: TODAY });
    expect(readinessOutput.safeParse(res).success).toBe(true);
    expect(res.data.signals.find((s) => s.name === 'load')).toEqual({ name: 'load', rating: 'unknown', detail: 'load model warming up (6 of 42 days)' });
  });

  it('adds imported activities only on dates outside the synced activity ranges, and hints the gap', async () => {
    const { analytics, store } = trained();
    const imported = (id: string, start: string) => ({
      id,
      start_time_local: start,
      type: 'running',
      duration_s: 3600,
      distance_m: 10_000,
      avg_hr: 150,
      source_file: 'export.csv',
      imported_at: NOW,
    });
    store.upsertImportedActivities([imported('csv-outside', '2026-05-15 08:00:00'), imported('csv-inside', '2026-09-15 08:00:00')]);
    const res = await analytics.getLoad({ from: '2026-05-01', include_activities: true });
    const ids = res.data.activities?.map((a) => a.id) ?? [];
    expect(ids).toContain('csv-outside');
    expect(ids).not.toContain('csv-inside');
    expect(res.data.activities?.find((a) => a.id === 'csv-outside')).toMatchObject({ date: '2026-05-15', source: 'import', hrtss: 69.4 });
    expect(ids).toHaveLength(131);
    expect(res.meta.sync_hint).toEqual({ scope: 'activities', from: '2026-05-01', to: '2026-05-31' });
  });

  it('gives a sync hint and the default thresholds on an empty cache, without calling Garmin', async () => {
    const { analytics, calls } = setup();
    const res = await analytics.getLoad();
    expect(loadOutput.safeParse(res).success).toBe(true);
    expect(res.meta.sync_hint).toEqual({ scope: 'all', from: '2026-09-11', to: TODAY });
    expect(res.meta.note).toMatch(/garmin_sync/);
    expect(res.data.latest).toBeUndefined();
    expect(res.data.thresholds_used).toMatchObject({ rhr: 50, by_sport: { run: { lthr: 170, lthr_note: expect.stringMatching(/default 170 bpm/) } } });
    expect(res.data.thresholds_used.by_sport.bike.lthr_note).toBe(res.data.thresholds_used.by_sport.run.lthr_note);
    expect(res.meta.note).toMatch(/default 170 bpm/);
    expect(calls).toEqual([]);
  });

  it('rejects a bad range or source', async () => {
    const { analytics } = setup();
    await expect(analytics.getLoad({ from: '2026-10-09', to: '2026-10-01' })).rejects.toThrow(InputError);
    await expect(analytics.getLoad({ source: 'epoc' as never })).rejects.toThrow(/Unknown load source/);
  });
});

describe('AnalyticsService.getReadiness', () => {
  const D = '2026-10-07';

  function ready() {
    const t = trained();
    t.daily('daily_summary', '2026-09-01', TODAY, (d) => ({ resting_hr: d === D ? 56 : 50, avg_stress: 30, body_battery_high: 80 }));
    t.daily('sleep', '2026-09-01', TODAY, () => ({ score: 80, duration_s: 8 * 3600 }));
    t.daily('hrv', '2026-09-01', TODAY, () => ({ last_night_avg: 60, weekly_avg: 60, status: 'BALANCED', baseline_low: 55, baseline_high: 70 }));
    t.daily(
      'training_status',
      '2026-09-01',
      TODAY,
      () => ({ readiness_score: 70 }),
      (d) => ({ status: null, readiness: [{ score: 70, level: 'HIGH', inputContext: 'AFTER_WAKEUP_RESET', timestamp: `${d}T05:30:00.0`, recoveryTime: 600 }] }),
    );
    return t;
  }

  it('decides from the cached rows of [D - 28, D] and the load model', async () => {
    const { analytics } = ready();
    const res = await analytics.getReadiness({ date: D });
    fits(readinessOutput, res);
    expect(readinessOutput.safeParse(res).success).toBe(true);
    expect(res.meta).toEqual({ source: 'cache' });
    // One red (resting HR) without its pair: MODIFY under the default decision_rule pairs.
    expect(res.data).toMatchObject({ date: D, decision: 'MODIFY', counts: { red: 1, yellow: 0, ok: 3, info: 3 }, partial: false });
    expect(res.data.recommendation?.[0]).toBe('MODIFY: 1 red (rhr) without a red pair (decision_rule pairs).');
    expect(res.data.signals.find((s) => s.name === 'rhr')).toMatchObject({ rating: 'red', value: { bpm: 56 }, reference: { mean28_bpm: 50 } });
    expect(res.data.signals.find((s) => s.name === 'load')).toMatchObject({ rating: 'ok', value: { acwr: 1, date: D } });
    expect(res.data.signals.find((s) => s.name === 'training_readiness')).toMatchObject({ rating: 'info', value: { score: 70, level: 'HIGH', recovery_h: 10 } });
  });

  it('uses own rules over the defaults and reports ignored keys', async () => {
    const { analytics } = ready();
    const res = await analytics.getReadiness({ date: D, rules: { rhr_red_delta: 10, bogus: 1, readiness_red: 90, bb_yellow: 85 } });
    expect(res.data).toMatchObject({ decision: 'GO', counts: { red: 0, yellow: 1 }, rules_used: { rhr_red_delta: 10, rhr_yellow_delta: 3 } });
    expect(res.data.rules_used).not.toHaveProperty('readiness_red');
    expect(res.data.rules_used).not.toHaveProperty('bb_yellow');
    expect(res.meta.note).toMatch(/Ignored rules .*: bogus, readiness_red, bb_yellow;/);
  });

  it('takes decision_rule count from the rules and ignores an unknown decision_rule', async () => {
    const { analytics } = ready();
    const count = await analytics.getReadiness({ date: D, rules: { decision_rule: 'count' } });
    expect(count.data).toMatchObject({ decision: 'REST', rules_used: { decision_rule: 'count' } });
    expect(count.meta.note).toBeUndefined();
    const bad = await analytics.getReadiness({ date: D, rules: { decision_rule: 'all' } });
    expect(bad.data).toMatchObject({ decision: 'MODIFY', rules_used: { decision_rule: 'pairs' } });
    expect(bad.meta.note).toMatch(/Ignored rules .*: decision_rule;/);
  });

  it('hints a sync of the whole window when the cache lacks it', async () => {
    const { analytics } = setup();
    const res = await analytics.getReadiness();
    expect(readinessOutput.safeParse(res).success).toBe(true);
    expect(res.meta.sync_hint).toEqual({ scope: 'all', from: '2026-09-10', to: TODAY });
    expect(res.data).toMatchObject({ date: TODAY, partial: true, counts: { unknown: 7 } });
  });

  it('rejects a future date', async () => {
    const { analytics } = setup();
    await expect(analytics.getReadiness({ date: '2026-10-09' })).rejects.toThrow(/in the future/);
  });
});

describe('AnalyticsService thresholds', () => {
  it('records changed Garmin profile thresholds before a read', async () => {
    const { analytics, store } = trained();
    store.setProfile(profile(168), Date.parse('2026-10-01T08:00:00Z'));
    const res = await analytics.getThresholds({ date: TODAY });
    fits(thresholdsOutput, res);
    expect(thresholdsOutput.safeParse(res).success).toBe(true);
    expect(res.meta).toEqual({ source: 'cache' });
    expect(res.data.effective).toMatchObject({
      lthr_run: { value: 168, since: '2026-10-01', source: 'garmin-auto' },
      hrmax: { value: 192, since: '2026-10-01', source: 'garmin-auto' },
      vo2max_run: { value: 52 },
    });
    expect(res.data.rhr_28d).toEqual({ value: 50, samples: 28 });
    expect(res.data.hrmax).toEqual({ value: 192 });
    // No lthr_bike or lthr_swim row: both use the running LTHR, LT1 is 0.90 x 168 (bike 7 lower).
    expect(res.data.by_sport).toEqual({
      run: { lthr: 168, lt1: 151, lt1_note: expect.stringMatching(/LT1 approximated/) },
      bike: { lthr: 168, lt1: 144, lthr_note: expect.stringMatching(/No lthr_bike/), lt1_note: expect.stringMatching(/LT1 approximated/) },
      swim: { lthr: 168, lt1: 151, lthr_note: expect.stringMatching(/No lthr_swim/), lt1_note: expect.stringMatching(/LT1 approximated/) },
    });
    // The profile did not change: a second read adds nothing.
    await analytics.getThresholds();
    expect(store.listThresholds().filter((r) => r.source === 'garmin-auto')).toHaveLength(4);
  });

  it('resolves by_sport from own bike LTHR and a tested LT1, filtered by param or not', async () => {
    const { analytics, store } = trained();
    store.addThreshold({ date: '2026-08-01', param: 'lthr_bike', value: 160, source: 'test', created_at: NOW });
    store.addThreshold({ date: '2026-08-01', param: 'lt1_hr', value: 150, source: 'test', created_at: NOW });
    store.addThreshold({ date: '2026-08-01', param: 'hrmax', value: 190, source: 'manual', created_at: NOW });
    const res = await analytics.getThresholds({ date: TODAY, param: 'lthr_bike' });
    fits(thresholdsOutput, res);
    expect(thresholdsOutput.safeParse(res).success).toBe(true);
    expect(Object.keys(res.data.effective)).toEqual(['lthr_bike']);
    expect(res.data.by_sport).toEqual({
      run: { lthr: 170, lt1: 150 },
      // Cycling LT1 from its own LTHR (0.90 × 160), not from the running lt1_hr.
      bike: { lthr: 160, lt1: 144, lt1_note: expect.stringMatching(/cycling LTHR/) },
      swim: { lthr: 170, lt1: 150, lthr_note: expect.stringMatching(/No lthr_swim/) },
    });
    expect(res.data.hrmax).toEqual({ value: 190 });
    // Before the bike and LT1 tests the history carries them back: the first row applies.
    const early = await analytics.getThresholds({ date: '2026-07-01' });
    expect(early.data.by_sport.bike).toMatchObject({ lthr: 160, lt1: 144 });
  });

  it('set_threshold is visible in get_thresholds and in the load model', async () => {
    const { analytics, store } = trained();
    store.setProfile(profile(168), Date.parse('2026-10-01T08:00:00Z'));
    const set = await analytics.setThreshold({ date: '2026-10-05', param: 'lthr_run', value: 171, note: '30 min test' });
    fits(setThresholdOutput, set);
    expect(setThresholdOutput.safeParse(set).success).toBe(true);
    expect(set).toEqual({
      data: {
        added: true,
        row: { date: '2026-10-05', param: 'lthr_run', value: 171, source: 'test', note: '30 min test' },
        effective: { date: TODAY, param: 'lthr_run', value: 171, since: '2026-10-05', source: 'test', note: '30 min test' },
      },
      meta: { source: 'local' },
    });

    const now = await analytics.getThresholds({ param: 'lthr_run', history: true });
    expect(now.data.effective).toEqual({ lthr_run: { value: 171, since: '2026-10-05', source: 'test', note: '30 min test' } });
    expect(now.data.history?.map((r) => [r.date, r.source, r.value])).toEqual([
      ['2026-01-01', 'manual', 170],
      ['2026-10-01', 'garmin-auto', 168],
      ['2026-10-05', 'test', 171],
    ]);
    const before = await analytics.getThresholds({ date: '2026-10-02', param: 'lthr_run' });
    expect(before.data.effective.lthr_run).toMatchObject({ value: 168, source: 'garmin-auto' });

    const load = await analytics.getLoad({ from: '2026-10-04', include_activities: true });
    expect(load.data.activities?.map((a) => [a.date, a.lthr_used])).toEqual([
      ['2026-10-04', 168],
      ['2026-10-05', 171],
      ['2026-10-06', 171],
      ['2026-10-07', 171],
      ['2026-10-08', 171],
    ]);
  });

  it('keeps an existing row and says when a later row stays in effect', async () => {
    const { analytics, store } = trained();
    await analytics.setThreshold({ date: '2026-10-05', param: 'lthr_run', value: 171 });
    const dup = await analytics.setThreshold({ date: '2026-10-05', param: 'lthr_run', value: 175 });
    expect(dup.data).toMatchObject({ added: false, row: { value: 171 }, effective: { value: 171 } });
    expect(dup.data.note).toMatch(/already exists \(value 171\)/);
    const older = await analytics.setThreshold({ date: '2026-09-01', param: 'lthr_run', value: 165, source: 'manual' });
    expect(older.data).toMatchObject({ added: true, effective: { value: 171, since: '2026-10-05' } });
    expect(older.data.note).toMatch(/later row \(2026-10-05, test\).*2026-09-01\.\.2026-10-04/);
    expect(store.listThresholds('lthr_run').map((r) => r.value)).toEqual([170, 165, 171]);
  });

  it('rejects unknown params and sources, future dates and bad values', async () => {
    const { analytics, store } = setup();
    await expect(analytics.setThreshold({ date: '2026-10-01', param: 'ftp', value: 250 })).rejects.toThrow(/Unknown threshold param/);
    await expect(analytics.setThreshold({ date: '2026-10-01', param: 'ftp_w', value: 250, source: 'garmin-auto' })).rejects.toThrow(/Unknown threshold source/);
    await expect(analytics.setThreshold({ date: '2026-10-09', param: 'ftp_w', value: 250 })).rejects.toThrow(/in the future/);
    await expect(analytics.setThreshold({ date: '2026-10-01', param: 'ftp_w', value: -1 })).rejects.toThrow(/positive/);
    await expect(analytics.getThresholds({ param: 'ftp' })).rejects.toThrow(InputError);
    expect(store.listThresholds()).toEqual([]);
  });

  it('takes HRmax from the cached Garmin profile as garmin-auto', async () => {
    const { analytics, store, calls, daily } = setup();
    daily('daily_summary', '2026-09-10', '2026-10-07', () => ({ resting_hr: 50 }));
    store.setProfile(profile(168), Date.parse('2026-10-01T08:00:00Z'));
    store.markReferenceFetched('profile', Date.parse('2026-10-01T08:00:00Z'));
    const res = await analytics.getThresholds({ date: TODAY });
    expect(res.data.hrmax).toEqual({ value: 192 });
    expect(res.data.effective.hrmax).toEqual({ value: 192, since: '2026-10-01', source: 'garmin-auto' });
    expect(res.meta).toEqual({ source: 'cache' });
    expect(calls).toEqual([]);
  });

  it('lists the HR and power zones of the cached profile per sport, with its download date', async () => {
    const { analytics, store, calls, daily } = setup();
    daily('daily_summary', '2026-09-10', '2026-10-07', () => ({ resting_hr: 50 }));
    const fixture = (name: string): unknown =>
      JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../client/fixtures', `${name}.json`), 'utf8')) as unknown;
    const fetched = Date.parse('2026-10-01T08:00:00Z');
    store.setProfile({ ...profile(168), heartRateZones: fixture('heart-rate-zones'), powerZones: fixture('power-zones') }, fetched);
    store.markReferenceFetched('profile', fetched);
    const res = await analytics.getThresholds();
    fits(thresholdsOutput, res);
    expect(thresholdsOutput.safeParse(res).success).toBe(true);
    expect(res.meta).toEqual({ source: 'cache' });
    // The local date of the download; running has five power zones (6 and 7 are 0 in the profile).
    expect(res.data.zones).toEqual({
      fetched: '2026-10-01',
      hr: {
        default: { method: 'HR_MAX', floors: [94, 134, 154, 163, 174], hrmax: 185, rhr: 55, lthr: 168 },
        cycling: { method: 'HR_MAX', floors: [109, 133, 148, 159, 167], hrmax: 185, rhr: 55, lthr: 160 },
      },
      power: {
        cycling: { floors: [0, 128, 179, 209, 248, 277, 353], ftp: 235 },
        cross_country_skiing: { floors: [0, 74, 101, 121, 141, 161, 201], ftp: 134 },
        running: { floors: [260, 317, 361, 399, 458], ftp: 404 },
        rowing: { floors: [0, 118, 161, 193, 225, 257, 321], ftp: 214 },
      },
      note: expect.stringMatching(/as of its download date \(fetched\), not a history/),
    });
    expect(calls).toEqual([]);

    // A profile without zone floors: no zones field.
    store.setProfile(profile(168), fetched);
    const none = await analytics.getThresholds();
    expect(none.data.zones).toBeUndefined();
    expect(none.meta).toEqual({ source: 'cache' });
  });

  it('hints a reference sync when the profile was never fetched, without calling Garmin', async () => {
    const { analytics, calls, daily } = setup();
    daily('daily_summary', '2026-09-10', '2026-10-07', () => ({ resting_hr: 50 }));
    for (const read of [() => analytics.getThresholds(), () => analytics.getReadiness(), () => analytics.getLoad()]) {
      const res = await read();
      expect(res.meta.sync_hint).toMatchObject({ scope: expect.stringMatching(/^(reference|all)$/) });
      expect(res.meta.note).toMatch(/profile/);
    }
    const res = await analytics.getThresholds();
    expect(res.meta).toEqual({
      source: 'cache',
      sync_hint: { scope: 'reference' },
      note: expect.stringMatching(/^Not synced from Garmin yet: profile\..*--scope reference/),
    });
    expect(res.data.hrmax).toEqual({ note: expect.stringMatching(/No HRmax/) });
    expect(calls).toEqual([]);
  });

  it('hints the resting HR window and the profile when neither was synced', async () => {
    const { analytics } = setup();
    const res = await analytics.getThresholds();
    expect(res.meta.sync_hint).toEqual({ scope: 'all', from: '2026-09-10', to: '2026-10-07' });
    expect(res.meta.note).toMatch(/daily_summary.*The Garmin profile is missing too\. No Garmin profile in the cache, so zones are left out\.$/);
    expect(res.data.zones).toBeUndefined();
    expect(res.data.rhr_28d).toMatchObject({ value: 50, samples: 0, note: expect.stringMatching(/default 50/) });
    expect(res.data.by_sport.run).toEqual({
      lthr: 170,
      lt1: 153,
      lthr_note: expect.stringMatching(/default 170/),
      lt1_note: expect.stringMatching(/default 170 .*LT1 approximated/),
    });
    expect(res.data.by_sport.bike.lthr_note).toMatch(/default 170/);
    expect(res.data.hrmax).toEqual({ note: expect.stringMatching(/No HRmax/) });
  });
});
