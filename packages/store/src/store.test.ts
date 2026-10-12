import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate, schemaVersion } from './db.js';
import { dailySummaryColumns } from './extract.js';
import { MIGRATIONS } from './migrations.js';
import { Store } from './store.js';
import { activity } from './test-utils/fake-client.js';

const T = 1_791_400_000_000;

describe('Store', () => {
  it('migrates a fresh database', () => {
    const store = Store.open(':memory:');
    expect(schemaVersion(store.db)).toBe(5);
    expect(store.getMeta('schema_version')).toBe('5');
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
    expect(store.getDevices()).toEqual([{ id: 7, name: 'FR965', model: null, last_sync_utc: null, raw: { deviceId: 7 }, settings: null, fetched_at: T }]);
    expect(store.referenceFetchedAt('devices')).toBeUndefined();
    expect(store.referenceFetchedAt('gear')).toBe(T);
  });

  it('stores device settings next to the device list', () => {
    const store = Store.open(':memory:');
    const settings = { deviceId: 7, timeFormat: 'time_twenty_four_hr' };
    store.replaceDevices([{ deviceId: 7 }, { deviceId: 8 }], null, T, new Map([[7, settings], [8, null]]));
    expect(Object.fromEntries(store.getDevices().map((d) => [d.id, d.settings]))).toEqual({ 7: settings, 8: null });
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
      // October's calendar grid starts with the end of September.
      { id: 6, itemType: 'workout', workoutId: 5, date: '2026-09-28', title: 'Z2' },
    ];
    store.replaceSchedule('2026-10-01', '2026-10-31', items, T);
    expect(store.getSchedule('2026-10-01', '2026-10-31').map((r) => r.id)).toEqual([1]);
    expect(store.getSchedule('2026-09-01', '2026-09-30')).toEqual([]);
    expect(store.getCalendarEvents('2026-10-01', '2026-10-31')).toEqual([{ id: 2, date: '2026-10-25', raw: items[1], fetched_at: T }]);
    expect(store.tableStats().find((t) => t.table === 'calendar_events')).toEqual({ table: 'calendar_events', rows: 1, from: '2026-10-25', to: '2026-10-25' });
    store.replaceSchedule('2026-10-01', '2026-10-31', [], T);
    expect(store.getCalendarEvents('2026-10-01', '2026-10-31')).toEqual([]);
  });

  it('records sync runs', () => {
    const store = Store.open(':memory:');
    const id = store.startSync('health', 'incremental', '2026-10-01', '2026-10-07', T);
    store.finishSync(id, 'ok', T + 10, { sleep: 7 });
    expect(store.recentSyncs(1)[0]).toMatchObject({ status: 'ok', stats: { sleep: 7 }, finished_at: T + 10 });
  });
});
