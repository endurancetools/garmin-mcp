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
    expect(schemaVersion(store.db)).toBe(6);
    expect(store.getMeta('schema_version')).toBe('6');
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

  it('adds the analytics tables in migration 6 and keeps the cached data', () => {
    const db = new Database(':memory:');
    for (const sql of MIGRATIONS.slice(0, 5)) db.exec(sql);
    db.pragma('user_version = 5');
    db.prepare(`INSERT INTO devices (id, name, raw, settings, fetched_at) VALUES (7, 'FR965', '{"deviceId":7}', '{"deviceId":7}', ?)`).run(T);
    db.prepare(`INSERT INTO meta (key, value) VALUES ('ref:devices:fetched_at', ?)`).run(String(T));
    migrate(db);
    expect(schemaVersion(db)).toBe(6);
    const store = new Store(db);
    expect(store.getMeta('schema_version')).toBe('6');
    expect(store.getDevices()[0]?.settings).toEqual({ deviceId: 7 });
    expect(store.referenceFetchedAt('devices')).toBe(T);
    expect(store.listThresholds()).toEqual([]);
    expect(store.countImportedActivities()).toBe(0);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('thresholds', 'imported_activities') ORDER BY name").all();
    expect(indexes.map((r) => (r as { name: string }).name)).toEqual(
      expect.arrayContaining(['imported_activities_date', 'thresholds_param_date']),
    );
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
