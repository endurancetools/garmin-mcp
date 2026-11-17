import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GarminError } from 'garmin-mcp-config';
import { clearSignInPause, hrvColumns, sleepColumns, TTL } from 'garmin-mcp-store';
import { describe, expect, it, vi } from 'vitest';
import { fitWithPower } from './test-utils/fit.js';
import { makeZip } from './test-utils/zip.js';
import { fixture, NOW, setup, summary } from './test-utils/fake.js';
import * as output from './output.js';
import { compileWorkout } from './workouts/index.js';

describe('GarminService', () => {
  it('lists activities from cache with cursor paging', async () => {
    const { service, count } = setup({ activities: Array.from({ length: 5 }, (_, i) => summary(i + 1, `2026-10-0${i + 1}`)) });
    const p1 = await service.getActivities({ limit: 2 });
    expect(p1.meta.source).toBe('live');
    expect(p1.data.activities?.map((a) => a.id)).toEqual([5, 4]);
    expect(p1.data.activities?.[0]).toMatchObject({ distance_km: 10, duration: '50:00', avg_pace: '5:00 /km', type: 'running' });
    const p2 = await service.getActivities({ limit: 2, cursor: p1.data.next_cursor });
    expect(p2.meta.source).toBe('cache');
    expect(p2.data.activities?.map((a) => a.id)).toEqual([3, 2]);
    expect(count('listAllActivities')).toBe(1);
  });

  it('lists activities with cadence, GAP, NP, the Training Effect label and downloaded weather, filtered by duration, pace and name', async () => {
    const { service, store } = setup({
      activities: [
        summary(1, '2026-10-01', { activityName: 'Ślęża loop', averageRunningCadenceInStepsPerMinute: 171.4, avgGradeAdjustedSpeed: 3.4, normPower: 312.6, trainingEffectLabel: 'TEMPO' }),
        summary(2, '2026-10-02', { duration: 1800, distance: 5000 }),
        summary(3, '2026-10-03', { activityType: { typeId: 2, typeKey: 'road_biking' }, distance: 40_000, duration: 4800, averageBikingCadenceInRevPerMinute: 88 }),
      ],
    });
    store.putActivityDetail(1, 'weather', { temp: 59, dewPoint: 50 }, NOW);
    const all = await service.getActivities({ sort: 'asc' });
    expect(all.data.activities?.[0]).toMatchObject({
      id: 1,
      avg_pace: '5:00 /km',
      avg_gap_pace: '4:54 /km',
      cadence_spm: 171,
      normalized_power_w: 313,
      training_effect: { label: 'tempo' },
      temp_c: 15,
      dew_point_c: 10,
    });
    expect(all.data.activities?.[2]).toMatchObject({ id: 3, cadence_rpm: 88 });
    expect(all.data.activities?.[2]?.cadence_spm).toBeUndefined();
    const ids = async (q: Parameters<typeof service.getActivities>[0]) => (await service.getActivities({ sort: 'asc', ...q })).data.activities?.map((a) => a.id);
    expect(await ids({ min_duration_min: 45 })).toEqual([1, 3]);
    expect(await ids({ max_duration_min: 30 })).toEqual([2]);
    // 5:00 /km and 6:00 /km runs, the ride at 2:00 /km.
    expect(await ids({ pace: '5:30-4:45' })).toEqual([1]);
    expect(await ids({ pace: '5:45-6:15' })).toEqual([2]);
    expect(await ids({ name: 'ślęża' })).toEqual([1]);
    await expect(service.getActivities({ pace: '5:00' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(service.getActivities({ pace: '5-6' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('adds the timeline of one night from the cached sleep and HRV JSON, without requests', async () => {
    const { service, store, calls } = setup();
    const sleep = fixture('sleep') as Parameters<typeof sleepColumns>[0];
    const hrv = fixture('hrv') as Parameters<typeof hrvColumns>[0];
    store.putDaily('sleep', '2026-10-07', sleepColumns(sleep), sleep, NOW);
    store.putDaily('hrv', '2026-10-07', hrvColumns(hrv), hrv, NOW);
    const night = await service.getSleep({ date: '2026-10-07' });
    expect(calls).toEqual([]);
    expect(output.sleepOutput.safeParse(JSON.parse(JSON.stringify(night))).error).toBeUndefined();
    const t = (night.data as { timeline?: Record<string, unknown> }).timeline;
    // setup() runs in UTC; the fixture night starts at 21:13 GMT.
    expect(t).toMatchObject({ awakenings: { count: 1, at: ['03:47'] }, min_hr: { bpm: 54, at: '00:20' }, hrv: { min_ms: 17, max_ms: 62 }, body_battery: { start: 19, end: 64 } });
    expect((t?.stages as unknown[] | undefined)?.[0]).toEqual({ from: '21:13', to: '21:32', stage: 'light' });
    // A range keeps its per-night table without timelines.
    const range = await service.getSleep({ from: '2026-10-07', to: '2026-10-07' });
    expect(JSON.stringify(range.data)).not.toContain('timeline');
  });

  it('answers a 90-day health question from the cache after the first fetch', async () => {
    const { service, count } = setup();
    const first = await service.queryHealth(['steps', 'sleep', 'hrv'], '2026-07-11', '2026-10-08', 'week');
    expect(first.meta.source).toBe('live');
    expect(first.meta.coverage?.complete).toBe(true);
    const calls = count('getDailySummary');
    const started = performance.now();
    const second = await service.queryHealth(['steps', 'sleep', 'hrv'], '2026-07-11', '2026-10-08', 'week');
    expect(performance.now() - started).toBeLessThan(1000);
    expect(second.meta.source).toBe('cache');
    expect(count('getDailySummary')).toBe(calls);
    expect(second.data.rows?.length).toBe(14);
    expect(second.data.summary?.sleep?.avg).toBe(8);
  });

  it('returns the calories eaten next to the calories burned, absent on days without food entries', async () => {
    const { service } = setup();
    const res = await service.queryHealth(['calories'], '2026-10-06', '2026-10-07');
    expect(res.data.rows).toEqual([
      { date: '2026-10-06', calories_total_kcal: 2400, calories_active_kcal: 600 },
      { date: '2026-10-07', calories_total_kcal: 2400, calories_active_kcal: 600, calories_consumed_kcal: 2150 },
    ]);
    const week = await service.queryHealth(['calories'], '2026-10-05', '2026-10-08', 'week');
    expect(week.data.rows?.[0]).toMatchObject({ week: '2026-W41', days: 4, calories_total_kcal_avg: 2400, calories_consumed_kcal_avg: 2150 });
  });

  it('returns partial data with coverage when Garmin is slow', async () => {
    const { service } = setup({ budgetMs: 30, delayMs: 50 });
    const res = await service.queryHealth(['steps'], '2026-09-01', '2026-10-08');
    expect(res.meta.source).toBe('partial');
    expect(res.meta.coverage?.complete).toBe(false);
    expect(res.meta.note).toMatch(/background/);
  });

  describe('query_health per hour', () => {
    // The day after the recorded intraday day (2026-10-10), so that day is closed.
    const AFTER = Date.parse('2026-10-11T12:00:00Z');

    it('downloads the series of the asked day once and answers hours, events and the peak hour', async () => {
      const { service, calls, count } = setup({ now: AFTER });
      const first = await service.queryHealth(['stress', 'body_battery', 'sleep'], '2026-10-10', '2026-10-10', 'hour');
      expect(output.healthOutput.safeParse(JSON.parse(JSON.stringify(first))).error).toBeUndefined();
      expect(first.meta.source).toBe('live');
      expect(calls.map((c) => c.method).filter((m) => m !== 'getSleep' && m !== 'getDailySummary' && m !== 'getHrv').toSorted()).toEqual(['getBodyBattery', 'getStress']);
      const data = first.data as unknown as { granularity: string; rows: Record<string, unknown>[]; daily?: Record<string, unknown>[]; events?: { type: string }[]; summary: Record<string, Record<string, unknown>>; note?: string };
      expect(data.granularity).toBe('hour');
      // setup() runs in UTC: the recorded day covers 00:00-21:59 of the 10th.
      expect(data.rows).toHaveLength(22);
      expect(data.rows[0]).toMatchObject({ date: '2026-10-10', hour: '00:00', body_battery_start: 40 });
      expect(data.summary.stress).toMatchObject({ max_at: '2026-10-10 06:00', hours_with_data: 15 });
      expect(data.events?.map((e) => e.type)).toEqual(['sleep', 'activity']);
      // Sleep has no hourly values: one daily row and its daily summary.
      expect(data.daily).toEqual([{ date: '2026-10-10', sleep_h: 8, sleep_score: 81 }]);
      expect(data.summary.sleep).toMatchObject({ days_with_data: 1 });
      expect(data.note).toMatch(/^sleep has no hourly values/);

      const before = calls.length;
      const second = await service.queryHealth(['stress', 'body_battery'], '2026-10-10', '2026-10-10', 'hour');
      expect(calls.length).toBe(before);
      expect(second.meta.source).toBe('cache');
      expect(count('getHeartRate')).toBe(0);
    });

    it('rejects more than 3 days and points to "day"', async () => {
      const { service, calls } = setup({ now: AFTER });
      await expect(service.queryHealth(['stress'], '2026-10-07', '2026-10-10', 'hour')).rejects.toMatchObject({ code: 'INVALID_INPUT', hint: expect.stringContaining('"day"') });
      expect(calls).toEqual([]);
      const three = await service.queryHealth(['steps'], '2026-10-08', '2026-10-10', 'hour');
      expect(three.data.rows?.length).toBeGreaterThan(0);
    });

    it('defaults to today and leaves future days alone', async () => {
      const { service, count } = setup({ now: AFTER });
      const res = await service.queryHealth(['resting_hr'], undefined, undefined, 'hour');
      expect(res.data).toMatchObject({ from: '2026-10-11', to: '2026-10-11' });
      expect(count('getHeartRate')).toBe(1);
      await service.queryHealth(['resting_hr'], '2026-10-11', '2026-10-12', 'hour');
      expect(count('getHeartRate')).toBe(1);
    });

    it('without auto fetch says what is missing instead of a sync hint garmin_sync could not fill', async () => {
      const { service, calls } = setup({ now: AFTER, autoFetch: false });
      const res = await service.queryHealth(['stress'], '2026-10-10', '2026-10-10', 'hour');
      expect(calls).toEqual([]);
      expect(res.data.rows).toBeUndefined();
      expect(res.meta.sync_hint).toBeUndefined();
      expect(res.meta.note).toMatch(/Hourly data of 2026-10-10 is not downloaded yet.*GARMIN_AUTO_FETCH/);
    });

    it('downloads with auto fetch (GARMIN_AUTO_FETCH) although reads do not fetch on their own', async () => {
      const { service, count } = setup({ now: AFTER, autoFetch: false, autoSync: true });
      const res = await service.queryHealth(['steps'], '2026-10-10', '2026-10-10', 'hour');
      expect(count('getSteps')).toBe(1);
      expect(res.meta.source).toBe('live');
      expect(res.data.summary?.steps).toMatchObject({ total: expect.any(Number) });
    });

    it('waits for a sync pause and says when the hourly data comes', async () => {
      const { service, store, calls } = setup({ now: AFTER });
      store.setMeta('sync:paused_until', String(AFTER + 3_600_000));
      const res = await service.queryHealth(['stress'], '2026-10-10', '2026-10-10', 'hour');
      expect(calls).toEqual([]);
      expect(res.meta.note).toContain('Syncing with Garmin is paused; hourly data that is missing or older than 15 min downloads after 2026-10-11T13:00:00.000Z');
    });

    it('returns partial data while Garmin is slow', async () => {
      const { service } = setup({ now: AFTER, budgetMs: 30, delayMs: 50 });
      const res = await service.queryHealth(['resting_hr'], '2026-10-10', '2026-10-10', 'hour');
      expect(res.meta.source).toBe('partial');
      expect(res.meta.note).toMatch(/background/);
    });
  });

  it('adds recovery, load focus, race predictions, scores, fitness age, records and acclimation to the training status', async () => {
    const { service, count } = setup({ activities: [summary(1, '2026-10-07')] });
    const res = await service.getTrainingStatus({});
    expect(res.data).toMatchObject({
      vo2max: { running: 53.9 },
      recovery: { remaining_h: 10, as_of: '2026-10-08T10:00:00.0' },
      load_focus: {
        feedback: 'aerobic high shortage',
        aerobic_low: { load: 610, target_min: 300, target_max: 600, status: 'above' },
        aerobic_high: { load: 150, status: 'below' },
        anaerobic: { load: 80, status: 'within' },
      },
      metrics: {
        as_of: '2026-10-08',
        race_predictions: { as_of: '2026-10-11', '5k': '19:30', '10k': '41:12', half_marathon: '1:31:49', marathon: '3:20:52' },
        endurance_score: { score: 6800, classification: 'well trained', weekly_avg: [{ week: '2026-09-14', avg: 6600 }, { week: '2026-09-21', avg: 6650 }] },
        hill_score: { score: 55, strength: 42, endurance: 60, as_of: '2026-10-08', max_4w: 60 },
        fitness_age: { fitness_age: 30.5, chronological_age: 36, achievable: 29 },
        acclimation: { heat_pct: 40, heat_trend: 'acclimatizing', altitude_m: 0, altitude_trend: 'no change' },
        personal_records: expect.arrayContaining([
          { record: 'fastest 5k', value: '19:32', date: '2026-05-31', activity_id: 11062161482 },
          { record: 'longest run', value: '113.12 km', date: '2026-07-03', activity_id: 89769414883 },
          { record: 'best 20 min power', value: '217 W', date: '2026-07-29', activity_id: 49973291233 },
          { record: 'fastest 400m pool swim', value: '7:10', date: '2026-07-21', activity_id: 87083760069 },
          { record: 'fastest 750m pool swim', value: '15:44', date: '2026-07-21', activity_id: 87083760069 },
          { record: 'fastest 1000m pool swim', value: '25:49', date: '2026-07-21', activity_id: 87083760069 },
          { record: 'fastest 1500m pool swim', value: '40:14', date: '2026-07-21', activity_id: 87083760069 },
        ]),
      },
    });
    // CTL/ATL/TSB from Garmin's training load go by one name, apart from the own model of get_load.
    expect(res.data.garmin_load_model).toMatchObject({ date: expect.any(String), ctl: expect.any(Number), atl: expect.any(Number), tsb: expect.any(Number), form: expect.any(String) });
    expect(res.data).not.toHaveProperty('computed_load');
    expect(res.data.note).toMatch(/^garmin_load_model uses .* the own model from power, pace and heart rate \(TSS\) is get_load/);
    expect(count('getEnduranceScore')).toBe(1);
    expect(count('getHillScore')).toBe(1);
    // A second question within the 1 h TTL is answered from the cache.
    const again = await service.getTrainingStatus({ from: '2026-09-01', to: '2026-10-08' });
    expect(again.data.metrics?.race_predictions?.['5k']).toBe('19:30');
    expect(count('getRacePredictions')).toBe(1);
    expect(count('getPersonalRecords')).toBe(1);
  });

  it('asks for a training sync when no training metrics are stored', async () => {
    const { service, calls } = setup({ autoFetch: false });
    const res = await service.getTrainingStatus({});
    expect(res.data.metrics).toBeUndefined();
    expect(res.meta.sync_hint).toMatchObject({ scope: 'training' });
    expect(calls).toEqual([]);
  });

  it('serves activity detail levels and caches them forever', async () => {
    const { service, count } = setup({ activities: [summary(1, '2026-10-07')] });
    const s = await service.getActivity(1, 'summary');
    expect(s.data).toMatchObject({ id: 1, description: 'desc', rpe: 6, moving_time: '49:10' });
    const z = await service.getActivity(1, 'hr_zones');
    expect(z.data.hr_zones).toEqual([
      { zone: 1, from_bpm: 100, time: '1:40', pct: 25 },
      { zone: 2, from_bpm: 120, time: '5:00', pct: 75 },
    ]);
    await service.getActivity(1, 'hr_zones');
    expect(count('getActivityHrZones')).toBe(1);

    const full = await service.getActivity(1, 'full');
    const stream = full.data.stream as { samples: unknown[]; total_samples: number };
    expect(stream.total_samples).toBe(3000);
    expect(Buffer.byteLength(JSON.stringify(full.data))).toBeLessThan(50 * 1024);
    expect(full.data.next_cursor).toBeDefined();
    const next = await service.getActivity(1, 'full', full.data.next_cursor as string);
    expect((next.data.stream as { offset: number }).offset).toBe(stream.samples.length);
  });

  it('removes an activity deleted in Garmin Connect when get_activity finds it gone', async () => {
    const gone = new Set<number>();
    const { service, store } = setup({ activities: [summary(1, '2026-10-07')], gone });
    await service.getActivity(1, 'summary');
    gone.add(1);
    await expect(service.getActivity(1, 'splits')).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('no longer exists in Garmin Connect') });
    expect(store.getActivity(1)).toBeUndefined();
    expect(store.getActivityDetail(1, 'summary')).toBeUndefined();
    await expect(service.getActivity(1, 'summary')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('adds typed splits and their totals per type to the laps, cached for good', async () => {
    const { service, store, count } = setup({ activities: [summary(1, '2026-10-07'), summary(2, '2026-10-07')] });
    const res = await service.getActivity(1, 'splits');
    // ClimbPro climb sections are left out; the rest follows the start time.
    expect(res.data.typed_splits?.map((t) => [t.type, t.start])).toEqual([
      ['interval_active', '09:00:03'],
      ['stand', '09:00:03'],
      ['climb', '09:00:07'],
      ['run', '09:00:10'],
      ['walk', '09:13:02'],
      ['run', '09:15:41'],
      ['walk', '09:15:52'],
      ['run', '09:18:07'],
      ['walk', '09:18:18'],
      ['climb', '09:40:28'],
      ['climb', '10:01:13'],
      ['stand', '10:44:54'],
      ['stand', '12:18:54'],
    ]);
    expect(res.data.typed_splits?.[2]).toEqual({
      type: 'climb',
      start: '09:00:07',
      duration: '21:02',
      distance_km: 3,
      avg_pace: '7:01 /km',
      avg_gap_pace: '5:17 /km',
      avg_hr_bpm: 163,
      max_hr_bpm: 176,
      elevation_gain_m: 210,
      elevation_loss_m: 2,
      avg_grade_pct: 7,
      max_grade_pct: 30.9,
    });
    // Standing has no pace.
    expect(res.data.typed_splits?.[1]).toEqual({ type: 'stand', start: '09:00:03', duration: '0:07', distance_km: 0.01, avg_hr_bpm: 89, max_hr_bpm: 93, elevation_gain_m: 0, elevation_loss_m: 0 });
    expect(res.data.split_summaries?.map((t) => [t.type, t.count])).toEqual([
      ['stand', 22],
      ['run', 115],
      ['walk', 128],
      ['interval_active', 1],
    ]);
    expect(res.data.split_summaries?.[1]).toEqual({
      type: 'run',
      count: 115,
      duration: '4:20:56',
      distance_km: 44.7,
      avg_pace: '5:50 /km',
      avg_gap_pace: '5:42 /km',
      avg_hr_bpm: 159,
      max_hr_bpm: 175,
      elevation_gain_m: 780,
      elevation_loss_m: 1663,
    });
    expect(() => output.activityOutput.parse(res)).not.toThrow();

    // `full` carries them too and nothing is asked twice; the summary level does not fetch them.
    const full = await service.getActivity(1, 'full');
    expect(full.data).toMatchObject({ typed_splits: res.data.typed_splits, split_summaries: res.data.split_summaries });
    expect((await service.getActivity(1, 'summary')).data.typed_splits).toBeUndefined();
    expect(count('getActivityTypedSplits')).toBe(1);
    expect(count('getActivitySplitSummaries')).toBe(1);

    // A 404 means "no typed splits": cached as empty, the arrays are left out, no note.
    const none = await service.getActivity(2, 'splits');
    expect(none.data.typed_splits).toBeUndefined();
    expect(none.data.split_summaries).toBeUndefined();
    expect(none.meta.note).toBeUndefined();
    expect(store.getActivityDetail(2, 'typed_splits')?.raw).toBeNull();
    expect(store.getActivityDetail(2, 'split_summaries')?.raw).toBeNull();
    await service.getActivity(2, 'splits');
    expect(count('getActivityTypedSplits')).toBe(2);
    expect(count('getActivitySplitSummaries')).toBe(2);
  });

  it('serves power zones, weather and strength sets as detail levels and in full', async () => {
    const { service, store, count } = setup({ activities: [summary(1, '2026-10-07'), summary(2, '2026-10-07')] });
    const p = await service.getActivity(1, 'power_zones');
    expect(p.data.power_zones).toEqual([
      { zone: 1, from_w: 0, time: '10:00', pct: 25 },
      { zone: 2, from_w: 138, time: '30:00', pct: 75 },
    ]);
    expect(p.data.hr_zones).toBeUndefined();

    const w = await service.getActivity(1, 'weather');
    expect(w.data.weather).toEqual({
      temp_c: 15,
      feels_like_c: 13.9,
      dew_point_c: 8.9,
      humidity_pct: 67,
      wind_kmh: 11,
      wind_gust_kmh: 20,
      wind_from: 'NW',
      wind_dir_deg: 315,
      conditions: 'partly cloudy',
      station: 'Warsaw Chopin',
      observed_at: '2026-10-07T07:00:00.000+0000',
    });

    const e = await service.getActivity(1, 'exercise_sets');
    expect(e.data.exercise_sets).toEqual({
      sets: [
        { set: 1, exercise: 'barbell_back_squat', reps: 8, weight_kg: 80, duration: '0:43', rest_after: '2:00' },
        { set: 2, exercise: 'barbell_back_squat', reps: 6, weight_kg: 90, duration: '0:38', rest_after: '2:30' },
        { set: 3, exercise: 'pull_up', reps: 10, duration: '0:30' },
      ],
      total_sets: 3,
      total_reps: 24,
      volume_kg: 1180,
    });

    // `full` carries every section and reuses the cache; nothing is asked twice.
    const full = await service.getActivity(1, 'full');
    expect(full.data).toMatchObject({ power_zones: p.data.power_zones, weather: w.data.weather, exercise_sets: e.data.exercise_sets });
    expect(count('getActivityPowerZones')).toBe(1);
    expect(count('getActivityWeather')).toBe(1);
    expect(count('getActivityExerciseSets')).toBe(1);
    for (const kind of ['power_zones', 'weather', 'exercise_sets'] as const) expect(store.getActivityDetail(1, kind)).toBeDefined();

    // A 404 means "no such data": cached as empty and explained, not an error.
    const none = await service.getActivity(2, 'weather');
    expect(none.data.weather).toBeUndefined();
    expect(none.meta.note).toMatch(/no weather/);
    expect(store.getActivityDetail(2, 'weather')?.raw).toBeNull();
    await service.getActivity(2, 'weather');
    expect(count('getActivityWeather')).toBe(2);
    const sets = await service.getActivity(2, 'exercise_sets');
    expect(sets.meta.note).toMatch(/no exercise sets/);
    const full2 = await service.getActivity(2, 'full');
    expect(full2.data.power_zones).toBeUndefined();
    expect(full2.meta.note).toBeUndefined();
  });

  it('adds running dynamics, respiration, stamina, run/walk time and the heart rate source to a run and its laps', async () => {
    const { service, store, count } = setup({ activities: [summary(1, '2026-10-07')] });
    await service.getActivities({});
    store.putActivityDetail(
      1,
      'summary',
      {
        activityId: 1,
        activityName: 'Run',
        activityTypeDTO: { typeKey: 'running' },
        summaryDTO: {
          averageHR: 150,
          averageRunCadence: 165.2,
          groundContactTime: 276.3,
          groundContactBalanceLeft: 49.48,
          verticalOscillation: 8.6,
          verticalRatio: 8.87,
          strideLength: 96.91,
          avgGradeAdjustedSpeed: 3.2,
          avgRespirationRate: 34.75,
          beginPotentialStamina: 100,
          endPotentialStamina: 87,
          minAvailableStamina: 87,
          trainingEffectLabel: 'AEROBIC_BASE',
          aerobicTrainingEffectMessage: 'IMPROVING_AEROBIC_BASE_8',
        },
        splitSummaries: [
          { splitType: 'RWD_RUN', duration: 2940 },
          { splitType: 'RWD_WALK', duration: 60 },
        ],
        metadataDTO: { associatedWorkoutId: 532427119, sensors: [{ serialNumber: 1, sourceType: 'BLUETOOTH_LOW_ENERGY', bleDeviceType: 'HEART_RATE', batteryLevel: 45 }] },
      },
      NOW,
    );
    store.putActivityDetail(
      1,
      'splits',
      {
        lapDTOs: [
          { lapIndex: 1, intensityType: 'ACTIVE', wktStepIndex: 1, distance: 1000, duration: 300, movingDuration: 298, averageHR: 140, averageRunCadence: 166, groundContactTime: 272.3, verticalOscillation: 8.62, verticalRatio: 8.76, strideLength: 98.41, avgGradeAdjustedSpeed: 3.4, avgRespirationRate: 30.1, elevationLoss: 1, normalizedPower: 327.4 },
        ],
      },
      NOW,
    );
    const s = await service.getActivity(1, 'summary');
    expect(s.data).toMatchObject({
      avg_gap_pace: '5:13 /km',
      training_effect: { label: 'aerobic_base', aerobic_message: 'improving_aerobic_base' },
      running_dynamics: { cadence_spm: 165, gct_ms: 276, gct_balance_left_pct: 49.5, vertical_oscillation_cm: 8.6, vertical_ratio_pct: 8.9, stride_m: 0.97 },
      respiration: { avg_brpm: 34.8 },
      stamina: { start_pct: 100, end_pct: 87, min_available_pct: 87 },
      motion: { run: '49:00', run_pct: 98, walk: '1:00', walk_pct: 2 },
      hr_source: 'external_sensor',
      hr_sensor: { connection: 'ble', battery_pct: 45 },
      workout_id: 532427119,
    });
    const laps = await service.getActivity(1, 'splits');
    expect(laps.data.splits).toEqual([
      {
        lap: 1,
        intensity: 'active',
        wkt_step_index: 1,
        wkt_step: '2. Other 2 km - anon-description',
        distance_km: 1,
        duration: '5:00',
        moving_time: '4:58',
        avg_pace: '5:00 /km',
        avg_gap_pace: '4:54 /km',
        avg_hr_bpm: 140,
        normalized_power_w: 327,
        cadence_spm: 166,
        gct_ms: 272,
        vertical_oscillation_cm: 8.6,
        vertical_ratio_pct: 8.8,
        stride_m: 0.98,
        avg_respiration_brpm: 30.1,
        elevation_loss_m: 1,
      },
    ]);
    // The stored activity carries the totals per split type, so they are not fetched.
    expect(laps.data.split_summaries).toEqual([
      { type: 'run', duration: '49:00' },
      { type: 'walk', duration: '1:00' },
    ]);
    expect(count('getActivity')).toBe(0);
    expect(count('getActivitySplits')).toBe(0);
    expect(count('getActivitySplitSummaries')).toBe(0);
  });

  it('names the workout step of each lap, a repeat numbered after its steps, with its compliance', async () => {
    const { service, store, count } = setup({ activities: [summary(1, '2026-10-07')] });
    const workout = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../fixtures/workouts/sample-garmin-get-workout.json'), 'utf8')) as { workoutId: number };
    store.upsertWorkout(workout, NOW);
    const run = (startTimeGMT: string, workoutId = 1234567890) =>
      store.putActivityDetail(1, 'summary', { activityId: 1, summaryDTO: { startTimeGMT, directWorkoutComplianceScore: 91.4 }, metadataDTO: { associatedWorkoutId: workoutId } }, NOW);
    run('2026-10-07T16:00:00.0');
    const lap = (lapIndex: number, intensityType: string, wktStepIndex: number | null, directWorkoutComplianceScore?: number) => ({ lapIndex, intensityType, wktStepIndex, directWorkoutComplianceScore, distance: 1000, duration: 300 });
    store.putActivityDetail(
      1,
      'splits',
      { lapDTOs: [lap(1, 'WARMUP', 0, 98), lap(2, 'INTERVAL', 1, 88.6), lap(3, 'RECOVERY', 2), lap(4, 'INTERVAL', 1, 93), lap(5, 'COOLDOWN', 4), lap(6, 'COOLDOWN', null)] },
      NOW,
    );
    const res = await service.getActivity(1, 'splits');
    expect(res.data).toMatchObject({ workout_id: 1234567890, workout_compliance_pct: 91 });
    expect(res.data.splits?.map((l) => [l.lap, l.wkt_step_index, l.wkt_step, l.compliance_pct])).toEqual([
      [1, 0, '1. Warmup 15:00 @ HR Z2', 98],
      [2, 1, '2.1. Interval 8:00 @ pace 4:40-4:50 /km - Comfortably hard', 89],
      [3, 2, '2.2. Recovery 400 m', undefined],
      [4, 1, '2.1. Interval 8:00 @ pace 4:40-4:50 /km - Comfortably hard', 93],
      [5, 4, '3. Cooldown until lap button @ HR 120-140 bpm', undefined],
      [6, undefined, undefined, undefined],
    ]);
    expect(res.meta.note).toBeUndefined();
    expect(count('getWorkout')).toBe(0);

    // Changed after the run: still named, with a note.
    run('2026-09-30T06:00:00.0');
    expect((await service.getActivity(1, 'splits')).meta.note).toContain('changed after this activity');
    // A workout that cannot be read leaves the bare index.
    run('2026-10-07T16:00:00.0', 666);
    const gone = await service.getActivity(1, 'splits');
    expect(gone.data.splits?.[0]).toMatchObject({ wkt_step_index: 0 });
    expect(gone.data.splits?.[0]?.wkt_step).toBeUndefined();
    expect(gone.meta.note).toContain('wkt_step_index only');
    expect(count('getWorkout')).toBe(1);
  });

  it('redacts personal data and GPS from the raw output unless redaction is off', async () => {
    const full = async (redact?: boolean) => {
      const { service, store } = setup({ activities: [summary(1, '2026-10-07')], redact });
      store.putActivityDetail(1, 'summary', { activityId: 1, userProfileId: 7, summaryDTO: { startLatitude: 51.1 }, metadataDTO: { userInfoDto: { fullname: 'Jan Kowalski' } } }, NOW);
      store.putActivityDetail(
        1,
        'details',
        {
          metricDescriptors: [
            { metricsIndex: 0, key: 'directHeartRate' },
            { metricsIndex: 1, key: 'directLatitude' },
            { metricsIndex: 2, key: 'directLongitude' },
          ],
          activityDetailMetrics: [{ metrics: [120, 51.1, 17.1] }],
        },
        NOW,
      );
      const { data } = await service.getActivity(1, 'full');
      return { raw: data.raw_summary, stream: data.stream as { metrics: string[]; samples: unknown[] } };
    };
    const redacted = await full();
    expect(JSON.stringify(redacted.raw)).not.toMatch(/Kowalski|userProfileId|Latitude/);
    expect(redacted.stream).toMatchObject({ metrics: ['directHeartRate'], samples: [{ directHeartRate: 120 }] });
    const raw = await full(false);
    expect(raw.raw).toMatchObject({ userProfileId: 7, summaryDTO: { startLatitude: 51.1 } });
    expect(raw.stream.samples).toEqual([{ directHeartRate: 120, directLatitude: 51.1, directLongitude: 17.1 }]);
  });

  it('aggregates the stream per bucket and filters the raw stream by metrics and spacing', async () => {
    const { service, store, count } = setup({ activities: [summary(1, '2026-10-07')] });
    // The fake stream: 3000 samples 1 s apart with timestamp and heart rate, no distance.
    const halves = await service.getActivity(1, 'stream_summary', undefined, { bucket: 'halves' });
    expect(halves.data.stream_summary).toMatchObject({ bucket: 'halves', samples: 3000, buckets: [{ n: 1, from: '0:00', to: '24:59' }, { n: 2, from: '24:59', to: '49:59' }] });
    expect(halves.data.stream).toBeUndefined();
    expect(halves.data.raw_summary).toBeUndefined();
    const kms = await service.getActivity(1, 'stream_summary');
    expect(kms.data.stream_summary).toBeUndefined();
    expect(kms.meta.note).toBe('Garmin has no a usable stream with distance for this activity.');
    expect(count('getActivityDetails')).toBe(1);

    const thin = await service.getActivity(1, 'full', undefined, { metrics: ['directHeartRate', 'directLatitude'], downsample_s: 60 });
    expect(thin.data.stream).toMatchObject({ metrics: ['directTimestamp', 'directHeartRate'], total_samples: 50 });
    expect(thin.meta.note).toBe('This stream has no directLatitude; its metrics are directTimestamp, directHeartRate.');

    store.putActivityDetail(
      1,
      'details',
      { metricDescriptors: [{ metricsIndex: 0, key: 'directHeartRate' }, { metricsIndex: 1, key: 'directLatitude' }], activityDetailMetrics: [{ metrics: [120, 51.1] }] },
      NOW,
    );
    const gps = await service.getActivity(1, 'full', undefined, { metrics: ['directLatitude'] });
    expect(gps.data.stream).toEqual({ total_samples: 1, offset: 0 });
    expect(gps.meta.note).toBe('directLatitude left out: GPS is removed while GARMIN_REDACT is on.');
  });

  it('lists climbs from the stream with W/kg from the latest weigh-in, else the profile', async () => {
    const { service, store, count } = setup({ activities: [summary(1, '2026-10-07', { activityType: { typeId: 2, typeKey: 'road_biking' } })] });
    // 2 km flat, 1.5 km at 6 % at 4 m/s and 280 W, 2 km flat; a sample every 5 s.
    const rows: (number | null)[][] = [];
    for (let d = 0, t = 0; d <= 5500; t += 5) {
      const climbing = d >= 2000 && d < 3500;
      rows.push([t, d, 100 + Math.min(90, Math.max(0, (d - 2000) * 0.06)), climbing ? 280 : 150]);
      d += climbing ? 20 : 50;
    }
    const keys = ['sumDuration', 'sumDistance', 'directElevation', 'directPower'];
    store.putActivityDetail(1, 'details', { metricDescriptors: keys.map((key, metricsIndex) => ({ metricsIndex, key })), activityDetailMetrics: rows.map((metrics) => ({ metrics })) }, NOW);
    store.setProfile({ social: {}, settings: { userData: { weight: 80_000 } }, heartRateZones: [], powerZones: [] }, NOW);
    const climbs = async () => service.getActivity(1, 'stream_summary', undefined, { bucket: 'climbs' });

    const fromProfile = await climbs();
    expect(fromProfile.data.stream_summary).toMatchObject({ bucket: 'climbs', buckets: [{ n: 1, elevation_gain_m: 90, max_grade_pct: 6 }] });
    const power = fromProfile.data.stream_summary?.buckets[0]?.avg_power_w ?? 0;
    expect(fromProfile.data.stream_summary?.buckets[0]?.w_per_kg).toBeCloseTo(power / 80, 1);
    expect(fromProfile.meta.note).toBe('W/kg with 80 kg (profile).');
    expect(() => output.activityOutput.parse(fromProfile)).not.toThrow();

    // A weigh-in within 30 days before the ride wins; one after it or 31 days before does not count.
    store.upsertWeighIns(
      [
        { samplePk: 1, calendarDate: '2026-09-06', timestampGMT: Date.parse('2026-09-06T06:00:00Z'), weight: 60_000 },
        { samplePk: 2, calendarDate: '2026-09-20', timestampGMT: Date.parse('2026-09-20T06:00:00Z'), weight: 70_000 },
        { samplePk: 3, calendarDate: '2026-10-08', timestampGMT: Date.parse('2026-10-08T06:00:00Z'), weight: 90_000 },
      ],
      NOW,
    );
    const fromWeighIn = await climbs();
    expect(fromWeighIn.data.stream_summary?.buckets[0]?.w_per_kg).toBeCloseTo(power / 70, 1);
    expect(fromWeighIn.meta.note).toBe('W/kg with 70 kg (weigh-in 2026-09-20).');
    expect(count('getActivityDetails')).toBe(0);

    // A flat stream: an empty list and why; the fake stream without distance: nothing to read.
    store.putActivityDetail(1, 'details', { metricDescriptors: keys.map((key, metricsIndex) => ({ metricsIndex, key })), activityDetailMetrics: rows.map(([t, d]) => ({ metrics: [t ?? 0, d ?? 0, 100, 150] })) }, NOW);
    const flat = await climbs();
    expect(flat.data.stream_summary).toMatchObject({ bucket: 'climbs', buckets: [] });
    expect(flat.meta.note).toBe('No climbs: a climb is at least 500 m long, 3 % steep on average and 30 m high.');
    const { service: bare } = setup({ activities: [summary(2, '2026-10-07')] });
    const none = await bare.getActivity(2, 'stream_summary', undefined, { bucket: 'climbs' });
    expect(none.meta.note).toBe('Garmin has no a usable stream with distance and elevation for this activity.');
  });

  it('builds the power curve from the FIT file once, with W/kg, and downloads nothing without power', async () => {
    const start = Date.parse('2026-10-07T05:00:00Z') / 1000;
    // 10 min at 200 W, 5 min at 320 W with 1 s at 700 W, 10 min at 180 W.
    const watts = [...Array<number>(600).fill(200), ...Array<number>(150).fill(320), 700, ...Array<number>(149).fill(320), ...Array<number>(600).fill(180)];
    const { service, store, count } = setup({
      activities: [summary(1, '2026-10-07', { activityType: { typeId: 2, typeKey: 'road_biking' }, avgPower: 220 }), summary(2, '2026-10-07')],
      zip: makeZip('1_ACTIVITY.fit', fitWithPower(start, watts)),
    });
    store.setProfile({ social: {}, settings: { userData: { weight: 80_000 } }, heartRateZones: [], powerZones: [] }, NOW);

    const first = await service.getActivity(1, 'power_curve');
    expect(first.meta.source).toBe('live');
    const best = first.data.power_curve?.best ?? [];
    expect(best.map((b) => b.duration)).toEqual(['1s', '5s', '15s', '30s', '1min', '2min', '5min', '10min', '20min']);
    expect(best[0]).toEqual({ duration: '1s', power_w: 700, w_per_kg: 8.75, at: '12:30' });
    expect(best.find((b) => b.duration === '5min')).toEqual({ duration: '5min', power_w: 321, w_per_kg: 4.02, at: '10:00' });
    expect(first.meta.note).toBe('W/kg with 80 kg (profile).');
    expect(() => output.activityOutput.parse(first)).not.toThrow();

    // Kept in the cache without the file; `full` does not download it.
    const again = await service.getActivity(1, 'power_curve');
    expect(again.meta.source).toBe('cache');
    expect(again.data.power_curve).toEqual(first.data.power_curve);
    expect(store.getActivityDetail(1, 'power_curve')?.raw).toMatchObject({ gear_changes: [] });
    await service.getActivity(1, 'full');
    expect(count('downloadActivity')).toBe(1);

    // No power in the activity list: null with a note, no download.
    const none = await service.getActivity(2, 'power_curve');
    expect(none.data.power_curve).toBeNull();
    expect(none.meta.note).toBe('This activity has no power data, so it has no power curve; no file was downloaded.');
    expect(() => output.activityOutput.parse(none)).not.toThrow();
    expect(count('downloadActivity')).toBe(1);
  });

  it('keeps a FIT file without power as null, waits out a sync pause and does not keep an unreadable file', async () => {
    const start = Date.parse('2026-10-07T05:00:00Z') / 1000;
    const { service, store, count } = setup({
      activities: [summary(3, '2026-10-07', { avgPower: 200 })],
      zip: makeZip('3_ACTIVITY.fit', fitWithPower(start, Array<null>(120).fill(null))),
    });
    store.setMeta('sync:paused_until', String(NOW + 60_000));
    const paused = await service.getActivity(3, 'power_curve');
    expect(paused.data.power_curve).toBeUndefined();
    expect(paused.meta.note).toMatch(/^Syncing with Garmin is paused; the FIT file for the power curve downloads after .+ when asked again\.$/);
    expect(count('downloadActivity')).toBe(0);

    store.setMeta('sync:paused_until', '0');
    const empty = await service.getActivity(3, 'power_curve');
    expect(empty.data.power_curve).toBeNull();
    expect(empty.meta.note).toBe('The FIT file of this activity has no power data, so it has no power curve.');
    await service.getActivity(3, 'power_curve');
    expect(count('downloadActivity')).toBe(1);

    const { service: broken, store: brokenStore } = setup({ activities: [summary(4, '2026-10-07', { avgPower: 200 })] });
    const bad = await broken.getActivity(4, 'power_curve');
    expect(bad.data.power_curve).toBeUndefined();
    expect(bad.meta.note).toMatch(/^The FIT file of this activity could not be read \(.+\), so there is no power curve\.$/);
    expect(brokenStore.getActivityDetail(4, 'power_curve')).toBeUndefined();
  });

  it('answers a FIT file whose records span more than MAX_SPAN_S with a note, without keeping it', async () => {
    // One record an hour for eight days: readFit refuses it instead of laying out 700 000 seconds.
    const start = Date.parse('2026-10-07T05:00:00Z') / 1000;
    const { service, store, count } = setup({
      activities: [summary(5, '2026-10-07', { avgPower: 200 })],
      zip: makeZip('5_ACTIVITY.fit', fitWithPower(start, Array<number>(8 * 24 + 1).fill(200), 3600)),
    });
    const long = await service.getActivity(5, 'power_curve');
    expect(long.data.power_curve).toBeUndefined();
    expect(long.meta.note).toMatch(/^The FIT file of this activity could not be read \(The records of this FIT file span 8 days, more than the 7 days .+\), so there is no power curve\.$/);
    expect(() => output.activityOutput.parse(long)).not.toThrow();
    expect(store.getActivityDetail(5, 'power_curve')).toBeUndefined();
    expect(count('downloadActivity')).toBe(1);
  });

  it('converts weather wind from mph for statute_us accounts', async () => {
    const { service, store } = setup({ activities: [summary(1, '2026-10-07')] });
    store.setProfile({ social: {}, settings: { userData: { measurementSystem: 'statute_us' } }, heartRateZones: [], powerZones: [] }, NOW);
    const w = await service.getActivity(1, 'weather');
    expect(w.data.weather).toMatchObject({ temp_c: 15, wind_kmh: 18, wind_gust_kmh: 32 });
  });

  it('writes edits through and updates the cache immediately', async () => {
    const { service, store } = setup({ activities: [summary(1, '2026-10-07')] });
    await service.getActivities({});
    const res = await service.updateActivity(1, { name: 'Tempo' });
    expect(res.data.activity).toMatchObject({ name: 'Tempo' });
    expect(store.getActivity(1)?.name).toBe('Tempo');
    await expect(service.updateActivity(1, {})).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('sets the privacy of an activity and reads it back', async () => {
    const { service, calls, store } = setup({ activities: [summary(1, '2026-10-07')] });
    await service.getActivities({});
    const res = await service.updateActivity(1, { privacy: 'followers' });
    expect(calls.find((c) => c.method === 'updateActivity')?.args[1]).toMatchObject({ privacy: 'followers' });
    // Garmin's "subscribers" is the tool's "followers".
    expect(res.data.privacy).toBe('followers');
    expect(store.getActivity(1)?.raw.privacy).toEqual({ typeId: 3, typeKey: 'subscribers' });
    expect((await service.updateActivity(1, { privacy: 'private' })).data.privacy).toBe('private');
  });

  it('corrects the exercise of recorded sets, keeping the times the watch recorded', async () => {
    const { service, calls, count, store } = setup({ activities: [summary(1, '2026-10-07')] });
    await service.getActivity(1, 'exercise_sets');
    const res = await service.updateActivity(1, {
      exercise_sets: [{ exercise: { category: 'squat', name: 'barbell front-squat' } }, { reps: 7 }, { exercise: { category: 'PULL_UP', name: 'CLOSE_GRIP_CHIN_UP' }, weight_kg: 10 }],
      keep_timing: true,
    });
    const [id, body] = (calls.find((c) => c.method === 'updateActivityExerciseSets')?.args ?? []) as [number, Record<string, unknown>[]];
    expect(id).toBe(1);
    // Rest sets, starts and durations stay; a field left out keeps the recorded value.
    expect(body.map((s) => [s.setType, s.startTime, s.duration])).toEqual([
      ['ACTIVE', '2026-10-07T05:02:00.0', 42.5],
      ['REST', '2026-10-07T05:02:42.5', 120],
      ['ACTIVE', '2026-10-07T05:04:42.5', 38],
      ['REST', '2026-10-07T05:05:20.5', 150],
      ['ACTIVE', '2026-10-07T05:07:50.5', 30],
    ]);
    expect(body[0]).toMatchObject({ exercises: [{ category: 'SQUAT', name: 'BARBELL_FRONT_SQUAT', probability: 100 }], repetitionCount: 8, weight: 80_000 });
    expect(body[2]).toMatchObject({ exercises: [{ category: 'SQUAT', name: 'BARBELL_BACK_SQUAT', probability: 99 }], repetitionCount: 7, weight: 90_000 });
    expect(body[4]).toMatchObject({ exercises: [{ category: 'PULL_UP', name: 'CLOSE_GRIP_CHIN_UP', probability: 100 }], repetitionCount: 10, weight: 10_000 });
    // The sets before the write, in the shape the tool takes, so they can be written back.
    expect(res.data.previous_exercise_sets).toEqual([
      { exercise: { category: 'SQUAT', name: 'BARBELL_BACK_SQUAT' }, reps: 8, weight_kg: 80, duration_s: 42.5, rest_s: 120 },
      { exercise: { category: 'SQUAT', name: 'BARBELL_BACK_SQUAT' }, reps: 6, weight_kg: 90, duration_s: 38, rest_s: 150 },
      { exercise: { category: 'PULL_UP' }, reps: 10, duration_s: 30 },
    ]);
    expect(res.data.exercise_sets?.sets.map((s) => [s.exercise, s.reps, s.weight_kg])).toEqual([
      ['barbell_front_squat', 8, 80],
      ['barbell_back_squat', 7, 90],
      ['close_grip_chin_up', 10, 10],
    ]);
    // The current sets are read live before the write and once after it; the cache holds the new ones.
    expect(count('getActivityExerciseSets')).toBe(3);
    expect(count('updateActivity')).toBe(0);
    expect((await service.getActivity(1, 'exercise_sets')).data.exercise_sets).toEqual(res.data.exercise_sets);
    expect(count('getActivityExerciseSets')).toBe(3);
    expect(store.getActivityDetail(1, 'exercise_sets')?.raw).toMatchObject({ exerciseSets: body });
  });

  it('refuses exercise sets it cannot write before writing anything', async () => {
    const { service, count } = setup({ activities: [summary(1, '2026-10-07')] });
    const refused = (patch: Parameters<typeof service.updateActivity>[1], message: RegExp) =>
      expect(service.updateActivity(1, { name: 'Legs', ...patch })).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(message) });
    await refused({ exercise_sets: [{ reps: 8 }], keep_timing: true }, /^exercise_sets: 1 set given, the activity has 3; keep_timing/);
    await refused({ exercise_sets: [{ exercise: { category: 'LEGS' }, duration_s: 40 }] }, /^exercise_sets\[0\]\.exercise\.category: unknown exercise category "LEGS"/);
    await refused({ exercise_sets: [{ duration_s: 40 }, { exercise: { category: 'SQUAT', name: 'SUMO_SQUATTT' }, duration_s: 40 }] }, /^exercise_sets\[1\]\.exercise\.name: unknown exercise "SUMO_SQUATTT" in category SQUAT/);
    await refused({ exercise_sets: [{ reps: 8, duration_s: 40 }], keep_timing: true }, /^exercise_sets\[0\]\.duration_s: keep_timing keeps/);
    await refused({ exercise_sets: [{ reps: 8 }] }, /^exercise_sets\[0\]\.duration_s is required without keep_timing/);
    await refused({ keep_timing: true }, /^keep_timing goes with exercise_sets/);
    await refused({ exercise_sets: [] }, /^exercise_sets is empty/);
    await refused({ exercise_sets: [{ duration_s: 40, weight_kg: -5 }] }, /^exercise_sets\[0\]\.weight_kg must be at least 0/);
    await refused({ exercise_sets: [{ duration_s: 0 }] }, /^exercise_sets\[0\]\.duration_s must be above 0/);
    await refused({ exercise_sets: [{ duration_s: 40, rest_s: -1 }] }, /^exercise_sets\[0\]\.rest_s must be at least 0/);
    await refused({ exercise_sets: [{ exercise: { category: 'SQUAT', name: ' ' }, duration_s: 40 }] }, /^exercise_sets\[0\]\.exercise\.name is empty/);
    expect(count('updateActivity')).toBe(0);
    expect(count('updateActivityExerciseSets')).toBe(0);
    // The hint offers the catalogue's names close to the unknown one.
    await expect(service.updateActivity(1, { exercise_sets: [{ exercise: { category: 'SQUAT', name: 'SUMO_SQUATTT' }, duration_s: 40 }] })).rejects.toMatchObject({
      hint: expect.stringMatching(/^Exercises of SQUAT with a similar name: .*SUMO_SQUAT/),
    });
  });

  it('writes new sets from the start of an activity without recorded sets', async () => {
    const { service, calls } = setup({ activities: [summary(2, '2026-10-06')] });
    await service.getActivities({});
    const res = await service.updateActivity(2, {
      exercise_sets: [
        { exercise: { category: 'SQUAT', name: 'BARBELL_BACK_SQUAT' }, reps: 5, weight_kg: 100, duration_s: 30, rest_s: 90 },
        { exercise: { category: 'PLANK' }, duration_s: 60 },
      ],
    });
    const body = calls.find((c) => c.method === 'updateActivityExerciseSets')?.args[1];
    expect(body).toEqual([
      { setType: 'ACTIVE', exercises: [{ category: 'SQUAT', name: 'BARBELL_BACK_SQUAT', probability: 100 }], repetitionCount: 5, weight: 100_000, duration: 30, startTime: '2026-10-06T05:00:00.0', wktStepIndex: null, messageIndex: 0 },
      { setType: 'REST', exercises: [], repetitionCount: null, weight: null, duration: 90, startTime: '2026-10-06T05:00:30.0', wktStepIndex: null, messageIndex: 1 },
      { setType: 'ACTIVE', exercises: [{ category: 'PLANK', name: null, probability: 100 }], repetitionCount: null, weight: null, duration: 60, startTime: '2026-10-06T05:02:00.0', wktStepIndex: null, messageIndex: 2 },
    ]);
    // Activity 2 had no sets (404), so there is nothing to return as previous.
    expect(res.data).not.toHaveProperty('previous_exercise_sets');
  });

  it('creates workouts from a typed definition', async () => {
    const { service, calls, store } = setup();
    const res = await service.createWorkout({
      definition: {
        name: 'Intervals',
        sport: 'running',
        steps: [
          { kind: 'warmup', duration: { type: 'time', seconds: 600 } },
          { kind: 'repeat', count: 4, steps: [{ kind: 'interval', duration: { type: 'distance', meters: 1000 }, target: { type: 'pace', min_per_km_fast: '4:00', min_per_km_slow: '4:10' } }] },
          { kind: 'cooldown', duration: { type: 'lap_button' } },
        ],
      },
    });
    expect(res.data).toMatchObject({ workout_id: 4242, name: 'Intervals' });
    const payload = calls.find((c) => c.method === 'createWorkout')?.args[0] as { workoutSegments: unknown[] };
    expect(payload.workoutSegments).toHaveLength(1);
    expect(store.getWorkouts()[0]?.id).toBe(4242);
    await expect(service.createWorkout({})).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('overwrites a saved workout in place when given its id', async () => {
    const { service, calls, store } = setup();
    const res = await service.createWorkout({ preset: { name: 'easy_z2', params: { duration_min: 40 } } }, 3353306163);
    expect(res.data).toEqual({ workout_id: 3353306163, name: 'Easy running 40 min', sport: 'running', updated: true });
    expect(calls.map((c) => c.method).filter((m) => m.endsWith('Workout'))).toEqual(['getWorkout', 'updateWorkout', 'getWorkout']);
    const body = calls.find((c) => c.method === 'updateWorkout')?.args[1] as Record<string, unknown>;
    expect(body).toMatchObject({ workoutName: 'Easy running 40 min', createdDate: '2026-10-07T13:58:40.0' });
    expect(body).not.toHaveProperty('estimatedDistanceInMeters');
    expect((body.workoutSegments as { workoutSteps: unknown[] }[])[0]?.workoutSteps).toHaveLength(1);
    expect(store.getWorkouts()[0]).toMatchObject({ id: 3353306163, name: 'Easy running 40 min' });
    await expect(service.createWorkout({ preset: { name: 'easy_z2', params: { duration_min: 40 } } }, 666)).rejects.toThrow('Workout not found');
    expect(calls.filter((c) => c.method === 'updateWorkout' || c.method === 'createWorkout')).toHaveLength(1);
  });

  it('creates workouts from a preset and accepts exactly one input form', async () => {
    const { service, calls } = setup();
    const res = await service.createWorkout({ preset: { name: 'easy_z2', params: { duration_min: 40 } } });
    expect(res.data).toMatchObject({ workout_id: 4242, name: 'Easy running 40 min', sport: 'running' });
    const payload = calls.find((c) => c.method === 'createWorkout')?.args[0] as { workoutSegments: { workoutSteps: unknown[] }[] };
    expect(payload.workoutSegments[0]?.workoutSteps).toEqual([
      expect.objectContaining({ endConditionValue: 2400, targetType: { workoutTargetTypeId: 4, workoutTargetTypeKey: 'heart.rate.zone' }, zoneNumber: 2 }),
    ]);
    const definition = { name: 'x', sport: 'running' as const, steps: [{ kind: 'warmup' as const }] };
    await expect(service.createWorkout({ definition, preset: { name: 'easy_z2', params: { duration_min: 40 } } })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: 'Pass only one of definition, preset',
    });
    await expect(service.createWorkout({ garmin_json: { name: 'not a workout' } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      service.createWorkout({ preset: { name: 'run_intervals', params: { repeats: 3, work_seconds: 60, work_target: { type: 'hr_range', min: 170, max: 160 } } } }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(/^steps\[1\]\.steps\[0\]\.target: /), hint: expect.any(String) });
    expect(calls.filter((c) => c.method === 'createWorkout')).toHaveLength(1);
  });

  it('reads a workout from the cache within the reference TTL and from Garmin after it', async () => {
    const { service, store, count } = setup();
    const first = await service.getWorkout(3353306163);
    expect(first.meta).toEqual({ source: 'live', fetched_at: new Date(NOW).toISOString() });
    const second = await service.getWorkout(3353306163);
    expect(count('getWorkout')).toBe(1);
    expect(second).toEqual({ data: first.data, meta: { source: 'cache', fetched_at: new Date(NOW).toISOString() } });
    // A copy as old as the TTL is stale: fetched again and stored with the new time.
    store.upsertWorkout(store.getWorkout(3353306163)!.raw, NOW - TTL.reference);
    const third = await service.getWorkout(3353306163);
    expect(count('getWorkout')).toBe(2);
    expect(third.meta.source).toBe('live');
    expect(store.getWorkout(3353306163)?.fetched_at).toBe(NOW);
  });

  it('fetches a workout known only from the list, which has no steps', async () => {
    const { service, store, count } = setup();
    await service.listWorkouts({});
    expect(store.getWorkout(700001)).toBeDefined();
    const res = await service.getWorkout(700001);
    expect(count('getWorkout')).toBe(1);
    expect(res.meta.source).toBe('live');
    expect((await service.getWorkout(700001)).meta.source).toBe('cache');
    expect(count('getWorkout')).toBe(1);
  });

  it('previews a workout without calling Garmin', async () => {
    const { service, calls, store } = setup();
    const res = await service.previewWorkout({
      definition: {
        name: 'Intervals',
        sport: 'running',
        steps: [
          { kind: 'warmup', duration: { type: 'time', seconds: 600 } },
          {
            kind: 'repeat',
            count: 4,
            steps: [
              { kind: 'interval', duration: { type: 'distance', meters: 1000 }, target: { type: 'pace', min_per_km_fast: '4:00', min_per_km_slow: '4:10' } },
              { kind: 'recovery', duration: { type: 'distance', meters: 200 } },
            ],
          },
          { kind: 'cooldown', duration: { type: 'lap_button' } },
        ],
      },
    });
    expect(res.data).toEqual({
      dry_run: true,
      name: 'Intervals',
      sport: 'running',
      step_count: 3,
      steps: ['1. Warmup 10:00', '2. Repeat 4x:', '  2.1. Interval 1 km @ pace 4:00-4:10 /km', '  2.2. Recovery 200 m', '3. Cooldown until lap button'],
      estimated_duration: '26:20',
      estimate_note: 'Steps 2.2, 3 have no time and no distance with a pace range, so the estimate leaves them out.',
      next: expect.stringContaining('call create_workout with the same input without dry_run'),
    });
    expect(res.meta).toEqual({ source: 'local', note: expect.stringContaining('no request was sent to Garmin') });
    expect(calls.filter((c) => c.method === 'createWorkout')).toHaveLength(0);
    expect(store.getWorkouts()).toHaveLength(0);

    const preset = await service.previewWorkout({ preset: { name: 'easy_z2', params: { duration_min: 40 } } });
    expect(preset.data).toMatchObject({ name: 'Easy running 40 min', estimated_duration: '40:00' });
    expect(preset.data).not.toHaveProperty('estimate_note');
    const copy = compileWorkout({
      name: 'Copy',
      sport: 'running',
      steps: [
        { kind: 'interval', duration: { type: 'distance', meters: 2000 }, target: { type: 'pace', min_per_km_fast: '4:50', min_per_km_slow: '5:10' } },
        { kind: 'cooldown', duration: { type: 'lap_button' } },
      ],
    });
    // Without its own estimate the copied JSON is estimated like a definition: 2 km at 5:00 /km.
    const { estimatedDurationInSecs: _, ...bare } = copy;
    const json = await service.previewWorkout({ garmin_json: bare as unknown as Record<string, unknown> });
    expect(json.data).toMatchObject({
      name: 'Copy',
      steps: ['1. Interval 2 km @ pace 4:50-5:10 /km', '2. Cooldown until lap button'],
      estimated_duration: '10:00',
      estimate_note: 'Step 2 has no time and no distance with a pace range, so the estimate leaves it out.',
    });
    const own = await service.previewWorkout({ garmin_json: { ...bare, estimatedDurationInSecs: 900 } });
    expect(own.data).toMatchObject({ estimated_duration: '15:00', estimate_note: 'estimated_duration is the one given in garmin_json.' });
    await expect(service.previewWorkout({})).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(calls.filter((c) => c.method === 'createWorkout')).toHaveLength(0);
  });

  it('lists races and events from the calendar it already fetches for the schedule', async () => {
    const { service, calls } = setup();
    const res = await service.listWorkouts({});
    expect(calls.map((c) => c.method).toSorted()).toEqual(['getCalendar', 'getCalendar', 'getCalendar', 'listWorkouts']);
    expect(res.data.upcoming_schedule).toEqual([{ date: '2026-10-08', workout_id: 3318316454, title: 'anon-title', schedule_id: 3153502322, source: 'library' }]);
    // No training plan on the calendar: no plan request, no plan block.
    expect(res.data.plan).toBeUndefined();
    expect(res.data.upcoming_events).toEqual([
      {
        id: 30000003,
        date: '2026-10-25',
        title: 'City Half Marathon',
        race: true,
        primary: true,
        distance_km: 21.1,
        start_time: '09:00',
        time_zone: 'Europe/Warsaw',
        location: 'anon-location',
        url: 'https://example.com/half',
      },
    ]);
  });

  it('lists the workouts of a Garmin Coach plan with a line from the plan week and the plan block', async () => {
    const now = Date.parse('2026-11-17T12:00:00Z');
    const { service, calls, count } = setup({ plan: true, now });
    const res = await service.listWorkouts({ from: '2026-11-16', to: '2026-11-30' });
    expect(calls.filter((c) => c.method === 'getAdaptiveTrainingPlan').map((c) => c.args)).toEqual([[32869447]]);
    expect(count('getTrainingPlan')).toBe(0);
    const plan = { source: 'plan', plan_name: 'anon-name', sport: 'running', title: 'anon-title' };
    expect(res.data.upcoming_schedule).toEqual([
      { date: '2026-11-17', schedule_id: 9887721846739, ...plan, description: '30 min, 5.5 km, aerobic base' },
      { date: '2026-11-18', schedule_id: 7708016743965, ...plan, description: '59 min, 10.8 km, aerobic base' },
      { date: '2026-11-19', schedule_id: 4029156030163, ...plan, description: '30 min, 5.5 km, aerobic base' },
      { date: '2026-11-21', schedule_id: 8323686352597, ...plan, description: '40 min, 7.3 km, aerobic base' },
      { date: '2026-11-22', schedule_id: 9173447710960, ...plan, description: '50 min, 9.7 km, tempo, key workout' },
    ]);
    // The plan start (itemType "trainingPlan") is not a workout.
    expect(res.data.upcoming_schedule?.map((s) => s.schedule_id)).not.toContain(32869447);
    expect(res.data.plan).toEqual({
      name: 'anon-name',
      kind: 'adaptive',
      sport: 'running',
      from: '2026-11-17',
      to: '2027-03-09',
      phase: { name: 'base', from: '2026-11-17', to: '2026-12-27' },
      target_event: { date: '2027-03-09' },
    });
    expect(output.listWorkoutsOutput.safeParse(JSON.parse(JSON.stringify(res))).error).toBeUndefined();
    // Within the reference TTL the plan comes from the cache; a day beyond the plan week has no line.
    const later = await service.listWorkouts({ from: '2026-11-16', to: '2026-12-31' });
    expect(count('getAdaptiveTrainingPlan')).toBe(1);
    expect(later.data.plan?.name).toBe('anon-name');
  });

  it('lists plan workouts without the plan details when Garmin does not give the plan, and asks again only after the TTL', async () => {
    const now = Date.parse('2026-11-17T12:00:00Z');
    const { service, count } = setup({ plan: true, now });
    const spy = vi.spyOn(service.client, 'getAdaptiveTrainingPlan').mockRejectedValue(new GarminError('NOT_FOUND', 'Garmin returned 404'));
    const res = await service.listWorkouts({ from: '2026-11-17', to: '2026-11-17' });
    expect(res.data.upcoming_schedule).toEqual([{ date: '2026-11-17', title: 'anon-title', schedule_id: 9887721846739, source: 'plan', sport: 'running' }]);
    expect(res.data.plan).toBeUndefined();
    expect(res.meta.note).toMatch(/training plan could not be downloaded \(NOT_FOUND\)/);
    await service.listWorkouts({ from: '2026-11-17', to: '2026-11-17' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(count('getAdaptiveTrainingPlan')).toBe(0);
  });

  it('refuses to unschedule a plan workout and leaves the plan alone', async () => {
    const now = Date.parse('2026-11-17T12:00:00Z');
    const { service, store, calls } = setup({ plan: true, now });
    await service.listWorkouts({ from: '2026-11-17', to: '2026-11-30' });
    const res = await service.scheduleWorkouts([], [9887721846739]);
    expect(res.data).toMatchObject({ unscheduled: 0, failed: 1 });
    expect(res.data.unschedule_results).toEqual([
      { schedule_id: 9887721846739, ok: false, error: expect.stringMatching(/^This is a workout of the training plan "anon-name" \(2026-11-17\), not one scheduled from the library; the plan is not changed here\./) },
    ]);
    expect(calls.filter((c) => c.method === 'deleteWorkoutSchedule')).toEqual([]);
    expect(store.getSchedule('2026-11-17', '2026-11-17')).toHaveLength(1);
  });

  it('reads the calendar in any date range and hints a reference sync for months not synced', async () => {
    const { service, calls } = setup({ autoFetch: false });
    const never = await service.listWorkouts({ from: '2027-03-01', to: '2027-04-15' });
    expect(never.data).toMatchObject({ from: '2027-03-01', to: '2027-04-15' });
    expect(never.meta.sync_hint).toEqual({ scope: 'reference', from: '2027-03-01', to: '2027-04-15' });
    expect(calls).toEqual([]);
    await service.jobs.run({ scope: 'reference', from: '2026-10-01', to: '2026-10-07' });
    const partly = await service.listWorkouts({ from: '2026-08-10', to: '2027-01-31' });
    expect(partly.meta.sync_hint).toEqual({ scope: 'reference', from: '2026-08-10', to: '2027-01-31' });
    expect(partly.meta.note).toMatch(/calendar 2026-08-10\.\.2027-01-31/);
    const later = await service.listWorkouts({ from: '2026-10-01', to: '2027-01-31' });
    expect(later.meta.sync_hint).toEqual({ scope: 'reference', from: '2027-01-01', to: '2027-01-31' });
    const fallback = await service.listWorkouts({});
    expect(fallback.data).toMatchObject({ from: '2026-10-08', to: '2026-12-07' });
    expect(fallback.meta.sync_hint).toBeUndefined();
    expect(fallback.data.upcoming_events?.map((e) => e.date)).toEqual(['2026-10-25']);
    const narrow = await service.listWorkouts({ from: '2026-10-11', to: '2026-10-31' });
    expect(narrow.data.upcoming_schedule).toBeUndefined();
    expect(narrow.data.upcoming_events?.map((e) => e.date)).toEqual(['2026-10-25']);
  });

  it('fetches calendar months of a range on demand and validates the range', async () => {
    const { service, calls } = setup();
    const res = await service.listWorkouts({ from: '2026-08-01', to: '2026-08-31' });
    expect(calls.filter((c) => c.method === 'getCalendar').map((c) => c.args)).toEqual([[2026, 10], [2026, 11], [2026, 12], [2026, 8]]);
    expect(res.meta.sync_hint).toBeUndefined();
    expect(res.data.upcoming_events).toBeUndefined();
    expect((await service.listWorkouts({ to: '2026-09-30' })).data).toMatchObject({ from: '2026-08-01', to: '2026-09-30' });
    expect((await service.listWorkouts({ from: '2026-11-01' })).data).toMatchObject({ from: '2026-11-01', to: '2026-12-31' });
    await expect(service.listWorkouts({ from: '2026-11-01', to: '2026-10-01' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('schedules workouts and reports per item', async () => {
    const { service, store } = setup();
    const res = await service.scheduleWorkouts([
      { date: '2026-10-10', workout_id: 1 },
      { date: '2026-10-11', workout_id: 666 },
    ]);
    expect(res.data).toMatchObject({ scheduled: 1, failed: 1 });
    expect(res.data.results[1]).toMatchObject({ ok: false, error: 'Workout not found' });
    expect(store.getSchedule('2026-10-10', '2026-10-10')).toHaveLength(1);
    expect(res.data.unschedule_results).toBeUndefined();
  });

  it('unschedules before scheduling, so a workout moves in one call', async () => {
    const { service, store, calls } = setup();
    await service.scheduleWorkouts([{ date: '2026-10-10', workout_id: 1 }]);
    const res = await service.scheduleWorkouts([{ date: '2026-10-12', workout_id: 1 }], [77, 666]);
    expect(calls.filter((c) => c.method === 'deleteWorkoutSchedule' || c.method === 'scheduleWorkout').map((c) => c.method).slice(1)).toEqual([
      'deleteWorkoutSchedule',
      'deleteWorkoutSchedule',
      'scheduleWorkout',
    ]);
    expect(res.data).toMatchObject({ scheduled: 1, unscheduled: 1, failed: 1 });
    expect(res.data.unschedule_results).toEqual([
      { schedule_id: 77, ok: true },
      { schedule_id: 666, ok: false, error: 'Schedule not found' },
    ]);
    expect(store.getSchedule('2026-10-10', '2026-10-10')).toHaveLength(0);
    expect(store.getSchedule('2026-10-12', '2026-10-12')).toHaveLength(1);
    await expect(service.scheduleWorkouts([])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('downloads FIT files and unpacks the zip', async () => {
    const { service } = setup({ zip: makeZip('1_ACTIVITY.fit', new Uint8Array([14, 16, 1, 2])) });
    const res = await service.downloadActivityFile(1, 'fit');
    expect(res.data.path.endsWith('1.fit')).toBe(true);
    expect([...fs.readFileSync(res.data.path)]).toEqual([14, 16, 1, 2]);
  });

  it('writes downloads only inside the download directory', async () => {
    const { service, downloadDir, calls } = setup({ zip: makeZip('1_ACTIVITY.fit', new Uint8Array([14, 16])) });
    const nested = await service.downloadActivityFile(1, 'fit', 'races/2026');
    expect(nested.data.path).toBe(path.join(downloadDir, 'races', '2026', '1.fit'));
    expect((await service.downloadActivityFile(1, 'fit', path.join(downloadDir, 'abs'))).data.path).toBe(path.join(downloadDir, 'abs', '1.fit'));

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'garmin-outside-'));
    fs.symlinkSync(outside, path.join(downloadDir, 'link'));
    const before = calls.length;
    for (const dir of ['../escape', outside, 'races/../../escape', 'link/new']) {
      await expect(service.downloadActivityFile(1, 'fit', dir)).rejects.toMatchObject({ code: 'INVALID_INPUT', hint: expect.stringContaining('GARMIN_FIT_DOWNLOAD_DIR') });
    }
    expect(fs.existsSync(path.join(outside, 'new'))).toBe(false);
    expect(fs.existsSync(path.join(downloadDir, '..', 'escape'))).toBe(false);
    // Rejected before anything is downloaded.
    expect(calls.length).toBe(before);
  });

  it('lists devices with their settings from the reference sync', async () => {
    const { service, count } = setup();
    const res = await service.getDevices();
    expect(count('getDeviceSettings')).toBe(5);
    expect(res.data.devices).toHaveLength(5);
    // Every paired device says `primary: true`; only the main watch is the activity tracker.
    expect(res.data.devices.filter((d) => d.primary)).toHaveLength(1);
    expect(res.data.devices[0]).toEqual({
      id: 2730757515,
      name: 'anon-displayName',
      model: 'fenix 8 - 47mm, Solar',
      firmware: '23.39',
      primary: true,
      last_sync_utc: '2026-10-11T17:48:39Z',
      settings: { time_format: 'time_twenty_four_hr', date_format: 'date_day_month', units: 'metric', alarms: 0, alarms_on: 0 },
    });
    await service.getDevices();
    expect(count('getDeviceSettings')).toBe(5);
  });

  it('lists activity type keys with their parent from the reference sync', async () => {
    const { service, count } = setup();
    const res = await service.getActivityTypes();
    expect(res.data.activity_types).toHaveLength(154);
    expect(res.data.activity_types).toEqual(
      expect.arrayContaining([{ key: 'all' }, { key: 'running', parent: 'all' }, { key: 'trail_running', parent: 'running' }]),
    );
    expect(res.meta.sync_hint).toBeUndefined();
    await service.getActivityTypes();
    expect(count('getActivityTypes')).toBe(1);
  });

  it('auto sync downloads what a read reports missing through the sync job and reads again', async () => {
    const { service, count } = setup({ autoFetch: false, autoSync: true, activities: [summary(1, '2026-09-10')] });
    const res = await service.withAutoSync(() => service.getPeriodSummary('month', { anchor_date: '2026-09-15' }));
    expect(res.meta).toMatchObject({ source: 'live' });
    expect(res.meta.sync_hint).toBeUndefined();
    expect(res.data).toMatchObject({ complete: true, training: { sessions: 1 } });
    expect(count('getDailySummary')).toBe(30);
    // The job counts its requests toward the daily cap.
    expect(service.jobs.limits().requests_today).toBeGreaterThan(30);
    // Stored now, so the next read neither syncs nor hints.
    const again = await service.withAutoSync(() => service.getPeriodSummary('month', { anchor_date: '2026-09-15' }));
    expect(again.meta.source).toBe('cache');
    expect(count('getDailySummary')).toBe(30);
  });

  it('auto sync answers with what it has when the job outlasts the budget', async () => {
    const { service } = setup({ autoFetch: false, autoSync: true, budgetMs: 30, delayMs: 20 });
    const res = await service.withAutoSync(() => service.queryHealth(['steps'], '2026-08-01', '2026-09-30'));
    expect(res.meta).toMatchObject({ source: 'partial', note: expect.stringMatching(/background/) });
    expect(res.meta.sync_hint).toBeUndefined();
    await vi.waitFor(() => expect(service.jobs.current()).toBeUndefined(), { timeout: 10_000 });
  });

  it('reports a sync that found nobody signed in as a pause, or throws the auth error when asked to', async () => {
    const { service, store } = setup({ autoFetch: false, autoSync: true });
    const client = service.client as unknown as Record<string, () => Promise<never>>;
    client.getDailySummary = client.getSleep = client.getHrv = async () => {
      throw new GarminError('AUTH_EXPIRED', 'The Garmin refresh token is no longer valid');
    };
    const read = () => service.queryHealth(['steps'], '2026-10-01', '2026-10-07');
    const quiet = await service.withAutoSync(read);
    expect(quiet.meta).toMatchObject({ source: 'partial', note: expect.stringMatching(/paused \(AUTH_EXPIRED: The Garmin refresh token is no longer valid\)/) });
    // The pause now answers every sync; a caller that can start a sign-in gets the error itself.
    await expect(service.withAutoSync(read, { throwWhenSignedOut: true })).rejects.toMatchObject({ code: 'AUTH_EXPIRED', message: 'The Garmin refresh token is no longer valid' });
    await expect(service.sync('health', '2026-10-01', '2026-10-07', false, { throwWhenSignedOut: true })).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
    expect((await service.sync('health', '2026-10-01', '2026-10-07')).data).toMatchObject({ status: 'paused' });
    expect(clearSignInPause(store, NOW)).toBe(true);
    expect(service.jobs.limits().paused_until).toBeUndefined();
    expect(clearSignInPause(store, NOW)).toBe(false);
  });

  it('leaves the sync hint to the user when auto sync is off, and does not report empty training for unsynced activities', async () => {
    const { service, calls } = setup({ autoFetch: false });
    const res = await service.withAutoSync(() => service.getPeriodSummary('month', { anchor_date: '2026-09-15' }));
    expect(calls).toEqual([]);
    expect(res.meta.sync_hint).toEqual({ scope: 'all', from: '2026-09-01', to: '2026-09-30' });
    expect(res.data.complete).toBe(false);
    expect(res.data).not.toHaveProperty('training');
  });

  it('reports cache coverage like the reads do: a sync hint for a gap, nothing once covered', async () => {
    const { service, calls } = setup({ autoFetch: false, activities: [summary(1, '2026-09-10')] });
    const gap = service.coverage('period', '2026-09-01', '2026-09-30');
    expect(calls).toEqual([]);
    expect(gap.sync_hint).toEqual({ scope: 'all', from: '2026-09-01', to: '2026-09-30' });
    const summaryMeta = (await service.getPeriodSummary('month', { anchor_date: '2026-09-15' })).meta;
    expect(gap).toEqual({ note: summaryMeta.note, sync_hint: summaryMeta.sync_hint });
    expect(service.coverage('daily', '2026-09-01', '2026-09-30', ['training_status']).sync_hint).toEqual({ scope: 'training', from: '2026-09-01', to: '2026-09-30' });
    await service.sync('all', '2026-09-01', '2026-09-30');
    expect(service.coverage('period', '2026-09-01', '2026-09-30')).toEqual({});
    expect(service.coverage('daily', '2026-09-01', '2026-09-30')).toEqual({});
    expect(service.coverage('activities', '2026-09-01', '2026-09-30')).toEqual({});
  });

  it('resolves the activity type of an edit from the cached type list', async () => {
    const { service, calls, count } = setup({ activities: [summary(1, '2026-10-07')] });
    await service.getActivityTypes();
    await service.updateActivity(1, { type: 'trail_running' });
    expect(count('getActivityTypes')).toBe(1);
    const patch = calls.find((c) => c.method === 'updateActivity')?.args[1];
    expect(patch).toMatchObject({ typeKey: 'trail_running', activityType: { typeId: 6, typeKey: 'trail_running', parentTypeId: 1 } });
    await expect(service.updateActivity(1, { type: 'trail_runing' })).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(/Unknown activity type "trail_runing"/) });
    expect(count('updateActivity')).toBe(1);
  });

  it('leaves the type lookup of an edit to the client when no type list is stored', async () => {
    const { service, calls } = setup({ autoFetch: false });
    await service.updateActivity(1, { type: 'trail_running' });
    expect(calls.filter((c) => c.method === 'getActivityTypes')).toEqual([]);
    expect(calls.find((c) => c.method === 'updateActivity')?.args[1]).toMatchObject({ typeKey: 'trail_running', activityType: undefined });
  });

  it('adds a manual activity, private by default, and caches it without a sync', async () => {
    const { service, calls, count, store } = setup({ activities: [summary(1, '2026-10-07')] });
    await service.getActivities({});
    const before = calls.length;
    const res = await service.addActivity({ type: 'yoga', start: '2026-10-07T18:30', duration_min: 45 });
    expect(calls.find((c) => c.method === 'createManualActivity')?.args[0]).toEqual({
      typeKey: 'yoga',
      activityType: expect.objectContaining({ typeId: 163, typeKey: 'yoga', parentTypeId: 29 }),
      name: 'Yoga',
      startLocal: '2026-10-07T18:30:00',
      timeZone: 'UTC',
      durationS: 2700,
      distanceM: undefined,
      privacy: 'private',
    });
    // No notes, effort or feel: no edit after the add.
    expect(count('updateActivity')).toBe(0);
    expect(res.data).toMatchObject({ created: true, privacy: 'private', activity: { id: 90_001, name: 'Yoga', type: 'yoga', date: '2026-10-07' } });
    expect(res.meta.source).toBe('live');
    // In the cache at once: the list shows it and nothing else is downloaded for it.
    expect(store.getActivity(90_001)).toMatchObject({ name: 'Yoga', type: 'yoga', duration_s: 2700 });
    const list = await service.getActivities({ from: '2026-10-07', to: '2026-10-07' });
    expect(list.data.activities.map((a) => a.id)).toEqual(expect.arrayContaining([1, 90_001]));
    expect(calls.slice(before).map((c) => c.method).filter((m) => m !== 'getActivityTypes')).toEqual(['createManualActivity', 'getActivity']);
  });

  it('writes notes, effort and feel of a new activity with the regular edit', async () => {
    const { service, calls } = setup();
    const res = await service.addActivity({ type: 'running', start: '2026-10-08T06:15:30', duration_min: 30.5, distance_km: 5.25, name: 'Easy run', description: 'legs ok', rpe: 4, feel: 75, privacy: 'followers' });
    const created = calls.find((c) => c.method === 'createManualActivity')?.args[0];
    expect(created).toMatchObject({ name: 'Easy run', startLocal: '2026-10-08T06:15:30', durationS: 1830, distanceM: 5250, privacy: 'followers' });
    expect(calls.find((c) => c.method === 'updateActivity')?.args).toEqual([90_001, { description: 'legs ok', rpe: 4, feel: 75 }]);
    expect(res.data.privacy).toBe('followers');
  });

  it('refuses fields of the other mode and incomplete new activities before writing', async () => {
    const { service, count } = setup({ activities: [summary(1, '2026-10-07')] });
    const invalid = { code: 'INVALID_INPUT' };
    await expect(service.updateActivity(1, { name: 'Tempo', start: '2026-10-07T07:00', duration_min: 50 })).rejects.toMatchObject({
      ...invalid,
      message: 'start, duration_min only go with a new activity, which is added without id',
      hint: expect.stringMatching(/leave out id/),
    });
    await expect(service.addActivity({ type: 'running', start: '2026-10-07T07:00', duration_min: 50, add_gear: 'shoes', event_type: 'race' })).rejects.toMatchObject({
      ...invalid,
      message: 'event_type, add_gear only go with an existing activity: pass its id',
    });
    await expect(service.addActivity({ type: 'yoga', start: '2026-10-07T07:00' })).rejects.toMatchObject({ ...invalid, message: 'A new activity needs duration_min' });
    await expect(service.addActivity({ name: 'Tempo' })).rejects.toMatchObject({ ...invalid, message: 'A new activity needs type, start, duration_min', hint: expect.stringMatching(/pass its id/) });
    await expect(service.addActivity({ type: 'yoga', start: 'yesterday 7pm', duration_min: 45 })).rejects.toMatchObject({ ...invalid, message: expect.stringMatching(/^start must be a local time/) });
    await expect(service.addActivity({ type: 'yoga', start: '2026-02-30T07:00', duration_min: 45 })).rejects.toMatchObject(invalid);
    // NOW is 2026-10-08 12:00 UTC.
    await expect(service.addActivity({ type: 'yoga', start: '2026-10-08T12:01', duration_min: 45 })).rejects.toMatchObject({ ...invalid, message: expect.stringMatching(/is in the future \(now 2026-10-08T12:00 in UTC\)/) });
    await expect(service.addActivity({ type: 'yoga', start: '2026-10-08T07:00', duration_min: 0 })).rejects.toMatchObject(invalid);
    await expect(service.addActivity({ type: 'yoga', start: '2026-10-08T07:00', duration_min: 45, distance_km: -1 })).rejects.toMatchObject(invalid);
    await expect(service.addActivity({ type: 'yogga', start: '2026-10-08T07:00', duration_min: 45 })).rejects.toMatchObject({ ...invalid, message: expect.stringMatching(/Unknown activity type "yogga"/) });
    expect(count('createManualActivity')).toBe(0);
    expect(count('updateActivity')).toBe(0);
  });

  it('tags an activity with an event type and lists activities by it', async () => {
    const { service, calls, count, store } = setup({ activities: [summary(1, '2026-10-07'), summary(2, '2026-10-06', { eventType: { typeId: 9, typeKey: 'uncategorized' } })] });
    await service.getActivities({});
    const res = await service.updateActivity(1, { event_type: 'Race' });
    expect(calls.find((c) => c.method === 'updateActivity')?.args[1]).toMatchObject({ eventType: { typeId: 1, typeKey: 'race' } });
    expect(res.data.activity).toMatchObject({ id: 1, event_type: 'race' });
    expect(store.getActivity(1)?.raw.eventType).toMatchObject({ typeKey: 'race' });
    const races = await service.getActivities({ event_type: 'race' });
    expect(races.data.activities?.map((a) => [a.id, a.event_type])).toEqual([[1, 'race']]);
    // "uncategorized" is what every activity starts as, so the list leaves it out.
    expect((await service.getActivities({})).data.activities?.find((a) => a.id === 2)).not.toHaveProperty('event_type');
    // The list is fetched once and kept; separators and case do not matter.
    await service.updateActivity(1, { event_type: 'special_event' });
    expect(count('getEventTypes')).toBe(1);
    expect(calls.findLast((c) => c.method === 'updateActivity')?.args[1]).toMatchObject({ eventType: { typeKey: 'specialEvent' } });
    expect((await service.getActivities({ event_type: 'Special Event' })).data.activities?.map((a) => a.id)).toEqual([1]);
    await expect(service.updateActivity(1, { event_type: 'marathon' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: 'Unknown event type "marathon". Valid keys: race, recreation, specialEvent, training, transportation, touring, geocaching, fitness, uncategorized',
    });
    expect(count('updateActivity')).toBe(2);
  });

  it('puts gear on an activity and takes it off, by name or uuid, without touching the activity itself', async () => {
    const { service, calls, count, store } = setup({ activities: [summary(1, '2026-10-07')] });
    await service.getActivities({});
    const shoe = (uuid: string, name: string, status = 'active') => ({ gear: { uuid, displayName: name, gearStatusName: status }, stats: { uuid, totalDistance: 1000, totalActivities: 1 } });
    const OLD = 'fd9c450c67ba25e422229c359e4b315a';
    const NEW = '253d02241e47cccd4899a0c5fa86238d';
    store.replaceGear([shoe(OLD, 'Trail Shoe 2', 'retired'), shoe(NEW, 'Trail Shoe 2 new'), shoe('3d5b2fe936d68c9f4f566bfe08b268bb', 'Light Trainer v4')], NOW);
    store.setActivityGear([1], OLD);

    const res = await service.updateActivity(1, { remove_gear: OLD, add_gear: 'speedgoat' });
    expect(calls.filter((c) => c.method.endsWith('Gear')).map((c) => [c.method, ...c.args])).toEqual([
      ['unlinkGear', OLD, 1],
      ['linkGear', NEW, 1],
    ]);
    expect(count('updateActivity')).toBe(0);
    expect(res.data.gear).toEqual({ removed: { uuid: OLD, name: 'Trail Shoe 2' }, added: { uuid: NEW, name: 'Trail Shoe 2 new' } });
    expect(res.data.activity).toMatchObject({ id: 1, gear_uuid: NEW });
    // The totals of both items are read again, so get_gear shows the change.
    expect(count('getGearStats')).toBe(2);
    expect(store.getGear().find((g) => g.uuid === NEW)?.total_distance_m).toBe(133_456);

    // The full name wins over a part of another name; a part shared by active items is refused before any write.
    await service.updateActivity(1, { add_gear: 'trail shoe 2 new' });
    await expect(service.updateActivity(1, { name: 'Trail', add_gear: 'e' })).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(/matches several gear items/) });
    await expect(service.updateActivity(1, { add_gear: 'Altra' })).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(/^No gear matches "Altra"\. Gear: /) });
    expect(count('updateActivity')).toBe(0);
    // A uuid the stored list does not have yet goes to Garmin as it is.
    await service.updateActivity(1, { add_gear: '0123456789abcdef0123456789abcdef' });
    expect(calls.findLast((c) => c.method === 'linkGear')?.args).toEqual(['0123456789abcdef0123456789abcdef', 1]);
  });

  it('explains an empty activity type filter: unknown key, keys not stored, or no such activities', async () => {
    const { service } = setup({ activities: [summary(1, '2026-10-07')] });
    const unstored = await service.getActivities({ type: 'trial_running' });
    expect(unstored.data.activities ?? []).toEqual([]);
    expect(unstored.meta.note).toBe('No activities match type "trial_running" and activity type keys are not stored yet; sync reference data to list them (garmin://activity-types).');
    await service.getActivityTypes();
    const unknown = await service.getActivities({ type: 'trial_running' });
    expect(unknown.meta.note).toBe('No activity type matches "trial_running"; valid keys are in garmin://activity-types, e.g. running, trail_running, cycling.');
    const none = await service.getActivities({ type: 'TRAIL', from: '2026-10-01', to: '2026-10-08' });
    expect(none.meta.note).toBe('"TRAIL" is a valid activity type, but there are no such activities between 2026-10-01 and 2026-10-08.');
    const found = await service.getActivities({ type: 'run' });
    expect(found.data.activities).toHaveLength(1);
    expect(found.meta.note).toBeUndefined();
  });

  it('explains an empty workout sport filter', async () => {
    const { service } = setup();
    const unknown = await service.listWorkouts({ sport: 'run' });
    expect(unknown.data.workouts ?? []).toEqual([]);
    expect(unknown.meta.note).toMatch(/^No workout sport matches "run"; valid sports are running, cycling, .*hiking\.$/);
    const none = await service.listWorkouts({ sport: 'cycling' });
    expect(none.meta.note).toBe('The workout library has no cycling workouts.');
    const found = await service.listWorkouts({ sport: 'running' });
    expect(found.data.workouts).toHaveLength(1);
    expect(found.meta.note).toBeUndefined();
  });

  it('hints a reference sync when activity types were never synced', async () => {
    const { service, calls } = setup({ autoFetch: false });
    const res = await service.getActivityTypes();
    expect(calls).toEqual([]);
    expect(res.data.activity_types).toEqual([]);
    expect(res.meta.sync_hint).toEqual({ scope: 'reference' });
    expect(res.meta.note).toMatch(/activity types/);
  });

  it('builds a weekly summary', async () => {
    const { service } = setup({ activities: [summary(1, '2026-10-05'), summary(2, '2026-10-07', { activityType: { typeKey: 'cycling' }, duration: 7200 })] });
    const res = await service.getPeriodSummary('week', { anchor_date: '2026-10-07' });
    expect(res.data).toMatchObject({ period: 'week', from: '2026-10-05', to: '2026-10-11', complete: false });
    expect(res.data.training).toMatchObject({ sessions: 2, active_days: 2 });
    expect(res.data.health?.sleep).toMatchObject({ avg: 8 });
  });

  it('summarises an arbitrary range like a week', async () => {
    const { service } = setup({ activities: [summary(1, '2026-09-27'), summary(2, '2026-10-05'), summary(3, '2026-10-07', { activityType: { typeKey: 'cycling' }, duration: 7200 })] });
    const res = await service.getPeriodSummary('range', { from: '2026-09-28', to: '2026-10-07' });
    expect(res.data).toMatchObject({ period: 'range', from: '2026-09-28', to: '2026-10-07' });
    expect(res.data.training).toMatchObject({ from: '2026-09-28', to: '2026-10-07', sessions: 2, active_days: 2, rest_days: 8 });
    expect(res.data.garmin_load_model).toBeDefined();
    expect(res.data).not.toHaveProperty('load_at_end');
    expect(res.data.health?.sleep).toMatchObject({ avg: 8 });
    expect(res.data.energy).toBeDefined();
    const clipped = await service.getPeriodSummary('range', { from: '2026-10-01', to: '2026-10-20' });
    expect(clipped.data).toMatchObject({ to: '2026-10-20', complete: false });
    expect(clipped.data.training).toMatchObject({ to: '2026-10-08' });
  });

  it('rejects a range in the future or with wrong bounds', async () => {
    const { service } = setup();
    await expect(service.getPeriodSummary('range', { from: '2026-10-10', to: '2026-10-20' })).rejects.toThrow(/future/);
    await expect(service.getPeriodSummary('range', { from: '2026-10-01' })).rejects.toThrow(/needs both from and to/);
    await expect(service.getPeriodSummary('range', { from: '2026-10-05', to: '2026-10-01' })).rejects.toThrow(/after to/);
    await expect(service.getPeriodSummary('range', { from: '2025-09-30', to: '2026-10-01' })).rejects.toThrow(/at most 366 days/);
    await expect(service.getPeriodSummary('range', { from: '2025-10-03', to: '2026-10-03', anchor_date: '2026-10-01' })).rejects.toThrow(/anchor_date/);
    await expect(service.getPeriodSummary('week', { from: '2026-10-01', to: '2026-10-07' })).rejects.toThrow(/only to period "range"/);
    await expect(service.getPeriodSummary('range', { from: '2025-10-03', to: '2026-10-03' })).resolves.toMatchObject({ data: { period: 'range' } });
  });

  it('reads only the cache by default and says what to sync', async () => {
    const { service, calls } = setup({ autoFetch: false, activities: [summary(1, '2026-10-07')] });
    const health = await service.queryHealth(['steps', 'sleep'], '2026-09-01', '2026-09-30');
    expect(calls).toEqual([]);
    expect(health.meta).toMatchObject({ source: 'cache', coverage: { complete: false }, sync_hint: { scope: 'health', from: '2026-09-01', to: '2026-09-30' } });
    expect(health.meta.note).toMatch(/garmin sync --scope health --from 2026-09-01 --to 2026-09-30/);
    const acts = await service.getActivities({ from: '2026-10-01' });
    expect(acts.meta.sync_hint).toEqual({ scope: 'activities', from: '2026-10-01', to: '2026-10-08' });
  });

  it('syncs an explicit range on request, then answers from the cache', async () => {
    const { service, count } = setup({ autoFetch: false, activities: [summary(1, '2026-09-10')] });
    const res = await service.sync('health', '2026-09-01', '2026-09-30');
    expect(res.data).toMatchObject({ status: 'done', chunks: '5/5' });
    expect(count('getSleep')).toBe(30);
    const health = await service.queryHealth(['sleep'], '2026-09-01', '2026-09-30');
    expect(health.meta.source).toBe('cache');
    expect(health.meta.sync_hint).toBeUndefined();
    expect((await service.sync('health', '2026-09-01', '2026-09-30')).data).toMatchObject({ status: 'done', requests: 0 });
    expect(count('getSleep')).toBe(30);
  });

  it('returns results that fit the MCP output schemas', async () => {
    const { service } = setup({ activities: [summary(1, '2026-10-05'), summary(2, '2026-10-07', { activityType: { typeKey: 'cycling' }, duration: 7200 })] });
    // What the client receives: the JSON text, parsed. Loose objects accept extra fields, so this checks types and required fields.
    const fits = async (schema: { safeParse(v: unknown): { error?: unknown } }, result: Promise<unknown>) =>
      expect(schema.safeParse(JSON.parse(JSON.stringify(await result))).error).toBeUndefined();
    await fits(output.syncOutput, service.sync('health', '2026-10-01', '2026-10-08'));
    await fits(output.activitiesOutput, service.getActivities({}));
    await fits(output.activityOutput, service.getActivity(1, 'full'));
    await fits(output.activityOutput, service.getActivity(1, 'splits'));
    await fits(output.updateActivityOutput, service.updateActivity(1, { name: 'Tempo' }));
    await fits(output.updateActivityOutput, service.updateActivity(1, { privacy: 'private', exercise_sets: [{ reps: 9 }, {}, {}], keep_timing: true }));
    await fits(output.updateActivityOutput, service.addActivity({ type: 'yoga', start: '2026-10-07T18:30', duration_min: 45, description: 'flow' }));
    await fits(output.healthOutput, service.queryHealth(['steps', 'sleep', 'hrv', 'resting_hr', 'calories'], '2026-09-01', '2026-10-08', 'week'));
    await fits(output.healthOutput, service.queryHealth(['calories'], '2026-10-01', '2026-10-08'));
    await fits(output.sleepOutput, service.getSleep({ date: '2026-10-07' }));
    await fits(output.sleepOutput, service.getSleep({ from: '2026-10-01', to: '2026-10-07' }));
    await fits(output.trainingStatusOutput, service.getTrainingStatus({ include_series: true }));
    await fits(output.bodyCompositionOutput, service.getBodyComposition());
    await fits(output.periodSummaryOutput, service.getPeriodSummary('week', { anchor_date: '2026-10-07' }));
    await fits(output.periodSummaryOutput, service.getPeriodSummary('range', { from: '2026-09-28', to: '2026-10-07' }));
    await fits(output.listWorkoutsOutput, service.listWorkouts({}));
    await fits(output.workoutOutput, service.getWorkout(1));
    const preset = { name: 'easy_z2' as const, params: { duration_min: 30 } };
    await fits(output.createWorkoutOutput, service.previewWorkout({ preset }));
    await fits(output.createWorkoutOutput, service.createWorkout({ preset }));
    await fits(output.scheduleOutput, service.scheduleWorkouts([{ date: '2026-10-10', workout_id: 1 }]));
    await fits(output.gearOutput, service.getGear(true));
    await fits(output.devicesOutput, service.getDevices());
  });

  it('validates ranges', async () => {
    const { service } = setup();
    await expect(service.queryHealth(['steps'], '2026-10-08', '2026-10-01')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(service.queryHealth(['steps'], 'yesterday', undefined)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
