import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate, schemaVersion } from './db.js';
import type { DeviceSolar } from 'garmin-mcp-client';
import { dailySummaryColumns, solarDays } from './extract.js';
import { MIGRATIONS } from './migrations.js';
import { Store } from './store.js';
import { activity, fixture } from './test-utils/fake-client.js';

const T = 1_791_400_000_000;

describe('Store', () => {
  it('migrates a fresh database', () => {
    const store = Store.open(':memory:');
    expect(schemaVersion(store.db)).toBe(13);
    expect(store.getMeta('schema_version')).toBe('13');
  });

  it('keeps cached activity details when migration 3 widens the detail kinds', () => {
    const db = new Database(':memory:');
    db.exec(MIGRATIONS[0] ?? '');
    db.exec(MIGRATIONS[1] ?? '');
    db.pragma('user_version = 2');
    db.prepare(`INSERT INTO activity_details (activity_id, kind, raw, fetched_at) VALUES (1, 'splits', '{"lapDTOs":[]}', ?)`).run(T);
    expect(() => db.prepare(`INSERT INTO activity_details (activity_id, kind, raw, fetched_at) VALUES (1, 'weather', '{}', ?)`).run(T)).toThrow(/CHECK constraint/);
    migrate(db);
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    const store = new Store(db);
    expect(store.getActivityDetail(1, 'splits')).toEqual({ raw: { lapDTOs: [] }, fetched_at: T });
    for (const kind of ['weather', 'power_zones', 'exercise_sets'] as const) store.putActivityDetail(1, kind, null, T);
    expect(store.getActivityDetail(1, 'exercise_sets')).toEqual({ raw: null, fetched_at: T });
  });

  it('adds device settings in migration 5 and marks stored devices for a refetch', () => {
    const db = new Database(':memory:');
    for (const sql of MIGRATIONS.slice(0, 4)) db.exec(sql);
    db.pragma('user_version = 4');
    db.prepare(`INSERT INTO devices (id, name, raw, fetched_at) VALUES (7, 'FR965', '{"deviceId":7}', ?)`).run(T);
    db.prepare(`INSERT INTO meta (key, value) VALUES ('ref:devices:fetched_at', ?), ('ref:gear:fetched_at', ?)`).run(String(T), String(T));
    migrate(db);
    const store = new Store(db);
    expect(store.getDevices()).toEqual([{ id: 7, name: 'FR965', model: null, last_sync_utc: null, raw: { deviceId: 7 }, settings: null, solar: null, fetched_at: T }]);
    expect(store.referenceFetchedAt('devices')).toBeUndefined();
    expect(store.referenceFetchedAt('gear')).toBe(T);
  });

  it('stores device settings next to the device list', () => {
    const store = Store.open(':memory:');
    const settings = { deviceId: 7, timeFormat: 'time_twenty_four_hr' };
    store.replaceDevices([{ deviceId: 7 }, { deviceId: 8 }], null, T, new Map([[7, settings], [8, null]]));
    expect(Object.fromEntries(store.getDevices().map((d) => [d.id, d.settings]))).toEqual({ 7: settings, 8: null });
  });

  it('adds solar days in migration 13 and marks stored devices for a refetch', () => {
    const db = new Database(':memory:');
    for (const sql of MIGRATIONS.slice(0, 12)) db.exec(sql);
    db.pragma('user_version = 12');
    db.prepare(`INSERT INTO devices (id, name, raw, settings, fetched_at) VALUES (7, 'fenix', '{"deviceId":7}', '{"deviceId":7}', ?)`).run(T);
    db.prepare(`INSERT INTO meta (key, value) VALUES ('ref:devices:fetched_at', ?), ('ref:gear:fetched_at', ?)`).run(String(T), String(T));
    migrate(db);
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    const store = new Store(db);
    expect(store.getDevices()[0]).toMatchObject({ id: 7, settings: { deviceId: 7 }, solar: null });
    expect(store.referenceFetchedAt('devices')).toBeUndefined();
    expect(store.referenceFetchedAt('gear')).toBe(T);
  });

  it('stores solar days next to the device list', () => {
    const store = Store.open(':memory:');
    const days = [{ date: '2026-11-15', time_gained_ms: 3, solar_minutes: 163, peak_solar_utilization: 50.29 }];
    store.replaceDevices([{ deviceId: 7, solarChargeCapable: true }, { deviceId: 8 }], null, T, new Map(), new Map([[7, days]]));
    expect(Object.fromEntries(store.getDevices().map((d) => [d.id, d.solar]))).toEqual({ 7: days, 8: null });
  });

  it('sums solar days from the minute readings and keeps no readings', () => {
    expect(solarDays(fixture('device-solar') as DeviceSolar)).toEqual([
      { date: '2026-11-14', time_gained_ms: 0, solar_minutes: 5, peak_solar_utilization: 1.059999942779541 },
      { date: '2026-11-15', time_gained_ms: 3, solar_minutes: 8, peak_solar_utilization: 50.290000915527344 },
    ]);
    const day = (extra: object) => ({ deviceSolarInput: { solarDailyDataDTOs: [{ localConnectDate: '2026-11-16', ...extra }] } });
    expect(solarDays(day({ totalActivityTimeGainedMs: 0, solarInputReadings: [] }))).toEqual([
      { date: '2026-11-16', time_gained_ms: 0, solar_minutes: null, peak_solar_utilization: null },
    ]);
    expect(solarDays(day({ solarInputReadings: [{ solarUtilization: null }, { solarUtilization: 0 }] }))).toEqual([
      { date: '2026-11-16', time_gained_ms: null, solar_minutes: 0, peak_solar_utilization: 0 },
    ]);
    expect(solarDays({ deviceSolarInput: { solarDailyDataDTOs: [{ totalActivityTimeGainedMs: 1 }] } })).toEqual([]);
    expect(solarDays(null)).toEqual([]);
  });

  it('upserts and queries activities with filters, sort and paging', () => {
    const store = Store.open(':memory:');
    store.upsertActivities(
      [
        activity(1, '2026-10-01'),
        activity(2, '2026-10-03', { activityType: { typeKey: 'cycling' } }),
        activity(3, '2026-10-05', { activityType: { typeKey: 'trail_running' } }),
      ],
      T,
    );
    expect(store.queryActivities().map((a) => a.id)).toEqual([3, 2, 1]);
    expect(store.queryActivities({ sort: 'asc', limit: 2 }).map((a) => a.id)).toEqual([1, 2]);
    expect(store.queryActivities({ from: '2026-10-02', to: '2026-10-04' }).map((a) => a.id)).toEqual([2]);
    expect(store.queryActivities({ type: 'running' }).map((a) => a.id)).toEqual([3, 1]);
    // activity() is 10 km in 3000 s (5:00 /km); id 2 is renamed and shortened below.
    store.upsertActivities([activity(2, '2026-10-03', { activityType: { typeKey: 'cycling' }, activityName: 'Ślęża 100% loop', duration: 1500 })], T);
    expect(store.queryActivities({ minDurationS: 1800 }).map((a) => a.id)).toEqual([3, 1]);
    expect(store.queryActivities({ maxDurationS: 1500 }).map((a) => a.id)).toEqual([2]);
    expect(store.queryActivities({ minSpeedMps: 3, maxSpeedMps: 3.5 }).map((a) => a.id)).toEqual([3, 1]);
    expect(store.queryActivities({ minSpeedMps: 6 }).map((a) => a.id)).toEqual([2]);
    expect(store.queryActivities({ name: 'ŚLĘŻA' }).map((a) => a.id)).toEqual([2]);
    expect(store.queryActivities({ name: '100%' }).map((a) => a.id)).toEqual([2]);
    expect(store.queryActivities({ name: '_' }).map((a) => a.id)).toEqual([]);
    const row = store.getActivity(3);
    expect(row).toMatchObject({ date: '2026-10-05', start_time_utc: '2026-10-05T05:00:00Z', distance_m: 10_000, training_load: 100 });
    expect(row?.raw.activityId).toBe(3);

    store.upsertActivities([activity(1, '2026-10-01', { activityName: 'renamed' })], T + 1);
    expect(store.getActivity(1)?.name).toBe('renamed');
    expect(store.latestActivityDate()).toBe('2026-10-05');
  });

  it('applies edits made through our tools and marks them fresh', () => {
    const store = Store.open(':memory:');
    store.upsertActivities([activity(1, '2026-10-01')], T);
    store.applyActivityEdit({ activityId: 1, activityName: 'Tempo', description: 'good', activityTypeDTO: { typeKey: 'trail_running' } }, T + 5);
    expect(store.getActivity(1)).toMatchObject({ name: 'Tempo', type: 'trail_running', fetched_at: T + 5 });
    expect(store.getActivityDetail(1, 'summary')?.raw).toMatchObject({ description: 'good' });
    store.applyActivityEdit({ activityId: 1, activityName: 'Tempo', accessControlRuleDTO: { typeId: 2, typeKey: 'private' } }, T + 6);
    expect(store.getActivity(1)?.raw.privacy).toEqual({ typeId: 2, typeKey: 'private' });
  });

  it('stores daily rows with extracted columns', () => {
    const store = Store.open(':memory:');
    const raw = { totalSteps: 9000, averageStressLevel: -2, moderateIntensityMinutes: 10, vigorousIntensityMinutes: 15 };
    store.putDaily('daily_summary', '2026-10-01', dailySummaryColumns(raw), raw, T);
    const [row] = store.getDaily('daily_summary', '2026-10-01', '2026-10-01');
    expect(row).toMatchObject({ steps: 9000, avg_stress: null, intensity_minutes: 40 });
    expect(store.dailyFetchedAt('daily_summary', '2026-09-01', '2026-10-31').get('2026-10-01')).toBe(T);
  });

  it('converts weigh-ins from grams and replaces a range', () => {
    const store = Store.open(':memory:');
    const e = { samplePk: 1, calendarDate: '2026-10-01', timestampGMT: Date.parse('2026-10-01T06:00:00Z'), weight: 75_300, muscleMass: 36_000, bodyFat: 15 };
    store.replaceWeighIns('2026-10-01', '2026-10-01', [e], T);
    expect(store.getBodyComposition('2026-10-01', '2026-10-01')[0]).toMatchObject({ weight_kg: 75.3, muscle_mass_kg: 36, body_fat_pct: 15 });
    store.replaceWeighIns('2026-10-01', '2026-10-01', [], T);
    expect(store.getBodyComposition('2026-10-01', '2026-10-01')).toEqual([]);
  });

  it('keeps workouts and events from the calendar and replaces a range', () => {
    const store = Store.open(':memory:');
    const items = [
      { id: 1, itemType: 'workout', workoutId: 5, date: '2026-10-10', title: 'Z2' },
      { id: 2, itemType: 'event', date: '2026-10-25', title: 'Half', isRace: true },
      { id: 3, itemType: 'activity', date: '2026-10-07', title: 'run' },
      { id: 4, itemType: 'weight', date: '2026-10-07' },
      { id: null, itemType: 'nap', date: '2026-10-07' },
      // A race added from Garmin's event catalogue: no calendar id, only the event uuid.
      { id: null, itemType: 'event', date: '2026-10-18', title: 'Trail', isRace: true, shareableEventUuid: 'e-1' },
      { id: null, itemType: 'event', date: '2026-10-19', title: 'no key' },
      // October's calendar grid starts with the end of September.
      { id: 6, itemType: 'workout', workoutId: 5, date: '2026-09-28', title: 'Z2' },
    ];
    store.replaceSchedule('2026-10-01', '2026-10-31', items, T);
    expect(store.getSchedule('2026-10-01', '2026-10-31').map((r) => r.id)).toEqual([1]);
    expect(store.getSchedule('2026-09-01', '2026-09-30')).toEqual([]);
    expect(store.getCalendarEvents('2026-10-01', '2026-10-31')).toEqual([
      { key: 'uuid:e-1', id: null, date: '2026-10-18', raw: items[5], fetched_at: T },
      { key: '2', id: 2, date: '2026-10-25', raw: items[1], fetched_at: T },
    ]);
    expect(store.tableStats().find((t) => t.table === 'calendar_events')).toEqual({ table: 'calendar_events', rows: 2, from: '2026-10-18', to: '2026-10-25' });
    store.replaceSchedule('2026-10-01', '2026-10-31', [], T);
    expect(store.getCalendarEvents('2026-10-01', '2026-10-31')).toEqual([]);
  });

  it('keeps training plan workouts with source "plan" and finds the plan ahead', () => {
    const store = Store.open(':memory:');
    const items = [
      { id: 1, itemType: 'workout', workoutId: 5, trainingPlanId: 0, date: '2026-11-16', title: 'Z2' },
      { id: 2, itemType: 'fbtAdaptiveWorkout', workoutId: null, trainingPlanId: 48, tpType: 'FBT_ADAPTIVE', date: '2026-11-17', title: 'Base' },
      // The start of a plan is not a workout.
      { id: 48, itemType: 'trainingPlan', trainingPlanId: 48, isStart: true, date: '2026-11-17', title: 'Plan' },
      // A workout of a phased plan (shape not recorded): a workout type carrying a plan id.
      { id: 3, itemType: 'workout', workoutId: 9, trainingPlanId: 77, date: '2026-11-20', title: 'Tempo' },
    ];
    store.replaceSchedule('2026-11-01', '2026-11-30', items, T);
    expect(store.getSchedule('2026-11-01', '2026-11-30').map((r) => [r.id, r.source, r.workout_id])).toEqual([
      [1, 'library', 5],
      [2, 'plan', null],
      [3, 'plan', 9],
    ]);
    expect(store.getScheduleItem(2)?.source).toBe('plan');
    expect(store.getScheduleItem(48)).toBeUndefined();
    expect(store.plansFrom('2026-11-17')).toEqual([
      { id: 48, adaptive: true },
      { id: 77, adaptive: false },
    ]);
    expect(store.plansFrom('2026-11-18')).toEqual([{ id: 77, adaptive: false }]);
    store.addSchedule(4, 5, '2026-11-18', { id: 4, title: 'Z2' }, T);
    expect(store.getScheduleItem(4)?.source).toBe('library');
    expect(store.getTrainingPlan()).toBeUndefined();
    store.setTrainingPlan(48, { name: 'Half' }, T);
    expect(store.getTrainingPlan()).toEqual({ id: 48, raw: { name: 'Half' }, fetched_at: T });
  });

  it('keeps earned badges and badge challenges apart', () => {
    const store = Store.open(':memory:');
    expect(store.getBadges('earned')).toBeUndefined();
    store.setBadges('earned', [{ badgeId: 1 }], T);
    store.setBadges('challenges', null, T + 1);
    expect(store.getBadges('earned')).toEqual({ raw: [{ badgeId: 1 }], fetched_at: T });
    expect(store.getBadges('challenges')).toEqual({ raw: null, fetched_at: T + 1 });
  });

  it('keeps the course list and single courses, and forgets the list', () => {
    const store = Store.open(':memory:');
    expect(store.getCourse()).toBeUndefined();
    expect(store.courseIds()).toEqual([]);
    store.setCourse(undefined, [{ courseId: 7, courseName: 'A' }, { courseId: 'x' }, { courseId: 9 }], T);
    store.setCourse(7, { courseId: 7, geoPoints: [] }, T + 1);
    expect(store.getCourse()).toEqual({ raw: [{ courseId: 7, courseName: 'A' }, { courseId: 'x' }, { courseId: 9 }], fetched_at: T });
    expect(store.getCourse(7)).toEqual({ raw: { courseId: 7, geoPoints: [] }, fetched_at: T + 1 });
    expect(store.courseIds()).toEqual([7, 9]);
    expect(store.courseIds(1)).toEqual([7]);
    store.forgetCourses();
    expect(store.getCourse()).toBeUndefined();
    expect(store.getCourse(7)).toBeDefined();
  });

  it("keeps Garmin's threshold history as one value", () => {
    const store = Store.open(':memory:');
    expect(store.getThresholdHistory()).toBeUndefined();
    const value = { lthr_hr: [{ from: '2026-11-01', value: 170 }], lthr_speed: null, ftp: { functionalThresholdPower: 200 }, fetched_at: T };
    store.setThresholdHistory(value);
    expect(store.getThresholdHistory()).toEqual(value);
  });

  it('adds the analytics tables in migration 6 and keeps the cached data', () => {
    const db = new Database(':memory:');
    for (const sql of MIGRATIONS.slice(0, 5)) db.exec(sql);
    db.pragma('user_version = 5');
    db.prepare(`INSERT INTO devices (id, name, raw, settings, fetched_at) VALUES (7, 'FR965', '{"deviceId":7}', '{"deviceId":7}', ?)`).run(T);
    db.prepare(`INSERT INTO meta (key, value) VALUES ('ref:devices:fetched_at', ?), ('ref:gear:fetched_at', ?)`).run(String(T), String(T));
    migrate(db);
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    const store = new Store(db);
    expect(store.getMeta('schema_version')).toBe(String(MIGRATIONS.length));
    expect(store.getDevices()[0]?.settings).toEqual({ deviceId: 7 });
    // Migration 13 (solar days) asks for a fresh device list; nothing else is refetched.
    expect(store.referenceFetchedAt('devices')).toBeUndefined();
    expect(store.referenceFetchedAt('gear')).toBe(T);
    expect(store.listThresholds()).toEqual([]);
    expect(store.countImportedActivities()).toBe(0);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('thresholds', 'imported_activities') ORDER BY name").all();
    expect(indexes.map((r) => (r as { name: string }).name)).toEqual(
      expect.arrayContaining(['imported_activities_date', 'thresholds_param_date']),
    );
  });

  it('keys calendar events by text in migration 7 and refetches the cached months', () => {
    const db = new Database(':memory:');
    for (const sql of MIGRATIONS.slice(0, 6)) db.exec(sql);
    db.pragma('user_version = 6');
    db.prepare(`INSERT INTO calendar_events (id, date, raw, fetched_at) VALUES (2, '2026-10-25', '{"id":2}', ?)`).run(T);
    db.prepare(`INSERT INTO meta (key, value) VALUES ('calendar:months', '{"2026-10":1}')`).run();
    migrate(db);
    const store = new Store(db);
    expect(store.getCalendarEvents('2026-10-01', '2026-10-31')).toEqual([{ key: '2', id: 2, date: '2026-10-25', raw: { id: 2 }, fetched_at: T }]);
    expect(store.getMeta('calendar:months')).toBeUndefined();
  });

  it('adds the intraday table in migration 8 and keeps the cached data', () => {
    const db = new Database(':memory:');
    for (const sql of MIGRATIONS.slice(0, 7)) db.exec(sql);
    db.pragma('user_version = 7');
    db.prepare(`INSERT INTO daily_summary (date, steps, raw, fetched_at) VALUES ('2026-10-07', 9000, '{}', ?)`).run(T);
    db.prepare(`INSERT INTO meta (key, value) VALUES ('sync:requests:2026-10-08', '12')`).run();
    migrate(db);
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    const store = new Store(db);
    expect(store.getDaily('daily_summary', '2026-10-07', '2026-10-07')[0]?.steps).toBe(9000);
    expect(store.getMeta('sync:requests:2026-10-08')).toBe('12');
    expect(store.getIntraday('2026-10-07')).toEqual([]);
    expect(store.tableStats().find((t) => t.table === 'intraday')).toEqual({ table: 'intraday', rows: 0, from: null, to: null });
  });

  it('marks cached calendar workouts as library ones in migration 10 and refetches the cached months', () => {
    const db = new Database(':memory:');
    for (const sql of MIGRATIONS.slice(0, 9)) db.exec(sql);
    db.pragma('user_version = 9');
    db.prepare(`INSERT INTO workout_schedule (id, workout_id, date, raw, fetched_at) VALUES (1, 5, '2026-10-10', '{"id":1}', ?)`).run(T);
    db.prepare(`INSERT INTO meta (key, value) VALUES ('calendar:months', '{"2026-10":1}')`).run();
    migrate(db);
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    const store = new Store(db);
    expect(store.getSchedule('2026-10-01', '2026-10-31')).toEqual([{ id: 1, workout_id: 5, date: '2026-10-10', source: 'library', raw: { id: 1 }, fetched_at: T }]);
    expect(store.getMeta('calendar:months')).toBeUndefined();
    expect(() => db.prepare(`UPDATE workout_schedule SET source = 'other' WHERE id = 1`).run()).toThrow(/CHECK constraint/);
  });

  it('keeps cached activity details when migration 9 adds the power curve kind', () => {
    const db = new Database(':memory:');
    for (const sql of MIGRATIONS.slice(0, 8)) db.exec(sql);
    db.pragma('user_version = 8');
    db.prepare(`INSERT INTO activity_details (activity_id, kind, raw, fetched_at) VALUES (1, 'power_zones', 'null', ?)`).run(T);
    expect(() => db.prepare(`INSERT INTO activity_details (activity_id, kind, raw, fetched_at) VALUES (1, 'power_curve', '{}', ?)`).run(T)).toThrow(/CHECK constraint/);
    migrate(db);
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    const store = new Store(db);
    expect(store.getActivityDetail(1, 'power_zones')).toEqual({ raw: null, fetched_at: T });
    store.putActivityDetail(1, 'power_curve', { best: [] }, T);
    expect(store.getActivityDetail(1, 'power_curve')).toEqual({ raw: { best: [] }, fetched_at: T });
    store.deleteActivity(1);
    expect(store.getActivityDetail(1, 'power_curve')).toBeUndefined();
  });

  it('keeps cached activity details when migration 11 adds the typed split kinds', () => {
    const db = new Database(':memory:');
    for (const sql of MIGRATIONS.slice(0, 10)) db.exec(sql);
    db.pragma('user_version = 10');
    db.prepare(`INSERT INTO activity_details (activity_id, kind, raw, fetched_at) VALUES (1, 'power_curve', '{"best":[]}', ?)`).run(T);
    expect(() => db.prepare(`INSERT INTO activity_details (activity_id, kind, raw, fetched_at) VALUES (1, 'typed_splits', '{}', ?)`).run(T)).toThrow(/CHECK constraint/);
    migrate(db);
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    const store = new Store(db);
    expect(store.getActivityDetail(1, 'power_curve')).toEqual({ raw: { best: [] }, fetched_at: T });
    store.putActivityDetail(1, 'typed_splits', { splits: [] }, T);
    store.putActivityDetail(1, 'split_summaries', null, T);
    expect(store.getActivityDetail(1, 'typed_splits')).toEqual({ raw: { splits: [] }, fetched_at: T });
    expect(store.getActivityDetail(1, 'split_summaries')).toEqual({ raw: null, fetched_at: T });
    store.deleteActivity(1);
    expect(store.getActivityDetail(1, 'typed_splits')).toBeUndefined();
  });

  it('keeps cached intraday series when migration 12 adds the hydration kind', () => {
    const db = new Database(':memory:');
    for (const sql of MIGRATIONS.slice(0, 11)) db.exec(sql);
    db.pragma('user_version = 11');
    db.prepare(`INSERT INTO intraday (date, kind, raw, fetched_at) VALUES ('2026-10-07', 'steps', '[]', ?)`).run(T);
    expect(() => db.prepare(`INSERT INTO intraday (date, kind, raw, fetched_at) VALUES ('2026-10-07', 'hydration', '{}', ?)`).run(T)).toThrow(/CHECK constraint/);
    migrate(db);
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    const store = new Store(db);
    expect(store.getIntraday('2026-10-07')).toEqual([{ kind: 'steps', raw: [], fetched_at: T }]);
    store.putIntraday('2026-10-07', 'hydration', { valueInML: 1500 }, T + 1);
    store.putIntraday('2026-10-09', 'hydration', null, T + 2);
    store.putIntraday('2026-10-12', 'hydration', { valueInML: 900 }, T + 3);
    expect(store.getIntradayRange('hydration', '2026-10-07', '2026-10-11')).toEqual([
      { date: '2026-10-07', kind: 'hydration', raw: { valueInML: 1500 }, fetched_at: T + 1 },
      { date: '2026-10-09', kind: 'hydration', raw: null, fetched_at: T + 2 },
    ]);
  });

  it('keeps one intraday series per day and kind', () => {
    const store = Store.open(':memory:');
    store.putIntraday('2026-10-07', 'heart_rate', { heartRateValues: [[1, 50]] }, T);
    store.putIntraday('2026-10-07', 'spo2', null, T);
    store.putIntraday('2026-10-07', 'heart_rate', { heartRateValues: [[1, 52]] }, T + 1);
    store.putIntraday('2026-10-09', 'steps', [], T + 2);
    expect(store.getIntraday('2026-10-07')).toEqual([
      { kind: 'heart_rate', raw: { heartRateValues: [[1, 52]] }, fetched_at: T + 1 },
      { kind: 'spo2', raw: null, fetched_at: T },
    ]);
    expect(store.getIntraday('2026-10-07', ['spo2', 'stress'])).toEqual([{ kind: 'spo2', raw: null, fetched_at: T }]);
    expect(store.intradayFetchedAt('2026-10-07')).toEqual(new Map([['heart_rate', T + 1], ['spo2', T]]));
    expect(() => store.putIntraday('2026-10-07', 'calories' as never, {}, T)).toThrow(/CHECK constraint/);
    expect(store.tableStats().find((t) => t.table === 'intraday')).toEqual({ table: 'intraday', rows: 3, from: '2026-10-07', to: '2026-10-09' });
  });

  it('keeps threshold history and ignores a duplicate (date, param, source)', () => {
    const store = Store.open(':memory:');
    expect(store.addThreshold({ date: '2026-06-01', param: 'lthr_run', value: 168, source: 'garmin-auto', created_at: T })).toEqual({ added: true });
    expect(store.addThreshold({ date: '2026-09-10', param: 'lthr_run', value: 171, source: 'test', note: 'test 30 min', created_at: T + 1 })).toEqual({
      added: true,
    });
    expect(store.addThreshold({ date: '2026-09-10', param: 'lthr_run', value: 175, source: 'test', created_at: T + 2 })).toEqual({ added: false });
    // Same date and param from another source is a separate row.
    expect(store.addThreshold({ date: '2026-09-10', param: 'lthr_run', value: 170, source: 'manual', created_at: T + 3 })).toEqual({ added: true });
    store.addThreshold({ date: '2026-05-01', param: 'hrmax', value: 192, source: 'manual', created_at: T + 4 });

    expect(store.listThresholds('lthr_run').map((r) => [r.date, r.value, r.source, r.note])).toEqual([
      ['2026-06-01', 168, 'garmin-auto', null],
      ['2026-09-10', 171, 'test', 'test 30 min'],
      ['2026-09-10', 170, 'manual', null],
    ]);
    expect(store.listThresholds().map((r) => r.param)).toEqual(['hrmax', 'lthr_run', 'lthr_run', 'lthr_run']);
    expect(store.listThresholds('ftp_w')).toEqual([]);
    expect(store.listThresholds('hrmax')[0]).toEqual({
      id: expect.any(Number),
      date: '2026-05-01',
      param: 'hrmax',
      value: 192,
      source: 'manual',
      note: null,
      created_at: T + 4,
    });
  });

  it('imports thresholds: adds new keys, overwrites changed ones, keeps the rest', () => {
    const store = Store.open(':memory:');
    store.addThreshold({ date: '2026-06-01', param: 'lthr_run', value: 168, source: 'garmin-auto', created_at: T });
    store.addThreshold({ date: '2026-09-10', param: 'lthr_run', value: 171, source: 'test', note: 'old', created_at: T });
    store.addThreshold({ date: '2026-09-10', param: 'lt1_hr', value: 150, source: 'test', created_at: T });
    const res = store.replaceThresholds([
      { date: '2026-09-10', param: 'lthr_run', value: 172, source: 'test', note: 'retest', created_at: T + 9 },
      { date: '2026-09-10', param: 'lt1_hr', value: 150, source: 'test', created_at: T + 9 },
      { date: '2026-10-01', param: 'ftp_w', value: 260, source: 'import', created_at: T + 9 },
    ]);
    expect(res).toEqual({ added: 1, updated: 1, skipped: 1 });
    expect(store.listThresholds().map((r) => [r.date, r.param, r.value, r.source, r.note, r.created_at])).toEqual([
      ['2026-10-01', 'ftp_w', 260, 'import', null, T + 9],
      ['2026-09-10', 'lt1_hr', 150, 'test', null, T],
      ['2026-06-01', 'lthr_run', 168, 'garmin-auto', null, T],
      ['2026-09-10', 'lthr_run', 172, 'test', 'retest', T],
    ]);
    expect(store.replaceThresholds([])).toEqual({ added: 0, updated: 0, skipped: 0 });
    expect(store.tableStats().find((t) => t.table === 'thresholds')).toEqual({ table: 'thresholds', rows: 4, from: '2026-06-01', to: '2026-10-01' });
  });

  it('upserts imported activities by id and reads them by local date', () => {
    const store = Store.open(':memory:');
    const run = {
      id: 'csv-0123456789',
      start_time_local: '2024-03-02 07:15:00',
      type: 'running',
      name: 'Morning run',
      duration_s: 3600,
      distance_m: 10_000,
      avg_hr: 145,
      source_file: 'Activities.csv',
      imported_at: T,
    };
    const ride = { id: 'csv-abcdefabcd', start_time_local: '2024-03-04 17:00:00', type: 'cycling', source_file: 'Activities.csv', imported_at: T };
    expect(store.upsertImportedActivities([run, ride])).toEqual({ added: 2, updated: 0 });
    expect(store.upsertImportedActivities([{ ...run, name: 'Easy run', imported_at: T + 1 }])).toEqual({ added: 0, updated: 1 });
    expect(store.countImportedActivities()).toBe(2);

    const [row] = store.getImportedActivities('2024-03-01', '2024-03-02');
    expect(row).toEqual({
      ...run,
      name: 'Easy run',
      imported_at: T + 1,
      date: '2024-03-02',
      moving_s: null,
      elevation_gain_m: null,
      elevation_loss_m: null,
      max_hr: null,
      avg_power: null,
      norm_power: null,
      avg_cadence: null,
      calories: null,
      training_effect_aerobic: null,
      training_effect_anaerobic: null,
    });
    expect(store.getImportedActivities('2024-03-01', '2024-03-31').map((r) => r.id)).toEqual(['csv-0123456789', 'csv-abcdefabcd']);
    expect(store.getImportedActivities('2024-03-03', '2024-03-03')).toEqual([]);
    expect(store.tableStats().find((t) => t.table === 'imported_activities')).toEqual({
      table: 'imported_activities',
      rows: 2,
      from: '2024-03-02',
      to: '2024-03-04',
    });
  });

  it('records sync runs', () => {
    const store = Store.open(':memory:');
    const id = store.startSync('health', 'incremental', '2026-10-01', '2026-10-07', T);
    store.finishSync(id, 'ok', T + 10, { sleep: 7 });
    expect(store.recentSyncs(1)[0]).toMatchObject({ status: 'ok', stats: { sleep: 7 }, finished_at: T + 10 });
  });
});
