import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TTL } from 'garmin-mcp-store';
import { describe, expect, it, vi } from 'vitest';
import { makeZip } from './test-utils/zip.js';
import { NOW, setup, summary } from './test-utils/fake.js';
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

  it('returns partial data with coverage when Garmin is slow', async () => {
    const { service } = setup({ budgetMs: 30, delayMs: 50 });
    const res = await service.queryHealth(['steps'], '2026-09-01', '2026-10-08');
    expect(res.meta.source).toBe('partial');
    expect(res.meta.coverage?.complete).toBe(false);
    expect(res.meta.note).toMatch(/background/);
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
        fitness_age: { fitness_age: 31.5, chronological_age: 39, achievable: 33.6 },
        acclimation: { heat_pct: 40, heat_trend: 'acclimatizing', altitude_m: 0, altitude_trend: 'no change' },
        personal_records: expect.arrayContaining([
          { record: 'fastest 5k', value: '19:32', date: '2026-05-31', activity_id: 23075207208 },
          { record: 'longest run', value: '113.12 km', date: '2026-07-03', activity_id: 23471659807 },
          { record: 'best 20 min power', value: '217 W', date: '2026-07-29', activity_id: 23780892293 },
          { record: 'fastest 400m pool swim', value: '7:10', date: '2026-07-21', activity_id: 23682525651 },
          { record: 'fastest 750m pool swim', value: '15:44', date: '2026-07-21', activity_id: 23682525651 },
          { record: 'fastest 1000m pool swim', value: '25:49', date: '2026-07-21', activity_id: 23682525651 },
          { record: 'fastest 1500m pool swim', value: '40:14', date: '2026-07-21', activity_id: 23682525651 },
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
    const res = await service.createWorkout({ preset: { name: 'easy_z2', params: { duration_min: 40 } } }, 1722598507);
    expect(res.data).toEqual({ workout_id: 1722598507, name: 'Easy running 40 min', sport: 'running', updated: true });
    expect(calls.map((c) => c.method).filter((m) => m.endsWith('Workout'))).toEqual(['getWorkout', 'updateWorkout', 'getWorkout']);
    const body = calls.find((c) => c.method === 'updateWorkout')?.args[1] as Record<string, unknown>;
    expect(body).toMatchObject({ workoutName: 'Easy running 40 min', createdDate: '2026-10-07T13:58:40.0' });
    expect(body).not.toHaveProperty('estimatedDistanceInMeters');
    expect((body.workoutSegments as { workoutSteps: unknown[] }[])[0]?.workoutSteps).toHaveLength(1);
    expect(store.getWorkouts()[0]).toMatchObject({ id: 1722598507, name: 'Easy running 40 min' });
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
    const first = await service.getWorkout(1722598507);
    expect(first.meta).toEqual({ source: 'live', fetched_at: new Date(NOW).toISOString() });
    const second = await service.getWorkout(1722598507);
    expect(count('getWorkout')).toBe(1);
    expect(second).toEqual({ data: first.data, meta: { source: 'cache', fetched_at: new Date(NOW).toISOString() } });
    // A copy as old as the TTL is stale: fetched again and stored with the new time.
    store.upsertWorkout(store.getWorkout(1722598507)!.raw, NOW - TTL.reference);
    const third = await service.getWorkout(1722598507);
    expect(count('getWorkout')).toBe(2);
    expect(third.meta.source).toBe('live');
    expect(store.getWorkout(1722598507)?.fetched_at).toBe(NOW);
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
    expect(res.data.upcoming_schedule).toEqual([{ date: '2026-10-08', workout_id: 1532201305, title: 'anon-title', schedule_id: 1801701038 }]);
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
      id: 3621149661,
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
    await fits(output.healthOutput, service.queryHealth(['steps', 'sleep', 'hrv', 'resting_hr'], '2026-09-01', '2026-10-08', 'week'));
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
