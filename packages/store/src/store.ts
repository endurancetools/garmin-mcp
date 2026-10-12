import type {
  Activity,
  ActivitySummary,
  ActivityType,
  CalendarItem,
  Device,
  DeviceLastUsed,
  DeviceSettings,
  Gear,
  GearStats,
  WeightEntry,
  WorkoutSummary,
} from 'garmin-mcp-client';
import type { IsoDate } from 'garmin-mcp-config';
import { openDatabase, type Db } from './db.js';
import {
  activityColumns,
  activityColumnsFromDetail,
  bodyCompositionColumns,
  dailySummaryColumns,
  deviceColumns,
  gearColumns,
  hrvColumns,
  normalizeUtc,
  sleepColumns,
  trainingColumns,
  workoutColumns,
  type ActivityColumns,
} from './extract.js';

export type DailyKind = 'daily_summary' | 'sleep' | 'hrv' | 'training_status';
export const DAILY_KINDS: readonly DailyKind[] = ['daily_summary', 'sleep', 'hrv', 'training_status'];
export type DetailKind = 'summary' | 'splits' | 'hr_zones' | 'details' | 'weather' | 'power_zones' | 'exercise_sets';
export type ReferenceKind = 'profile' | 'gear' | 'devices' | 'workouts' | 'activity_types';

export interface ActivityRow extends ActivityColumns {
  date: string | null;
  gear_uuid: string | null;
  raw: ActivitySummary;
  fetched_at: number;
}

export interface DailyRows {
  daily_summary: { date: string; fetched_at: number; raw: unknown } & ReturnType<typeof dailySummaryColumns>;
  sleep: { date: string; fetched_at: number; raw: unknown } & ReturnType<typeof sleepColumns>;
  hrv: { date: string; fetched_at: number; raw: unknown } & ReturnType<typeof hrvColumns>;
  training_status: { date: string; fetched_at: number; raw: unknown } & ReturnType<typeof trainingColumns>;
}

export type BodyCompositionRow = ReturnType<typeof bodyCompositionColumns> & { raw: WeightEntry; fetched_at: number };

export interface WorkoutRow {
  id: number;
  name: string | null;
  sport: string | null;
  updated_at: string | null;
  raw: WorkoutSummary;
  fetched_at: number;
}

export interface ScheduleRow {
  id: number;
  workout_id: number | null;
  date: string | null;
  raw: CalendarItem;
  fetched_at: number;
}

export interface CalendarEventRow {
  id: number;
  date: string | null;
  raw: CalendarItem;
  fetched_at: number;
}

export interface GearRow {
  uuid: string;
  name: string | null;
  type: string | null;
  status: string | null;
  total_distance_m: number | null;
  raw: { gear: Gear; stats: GearStats | null };
  fetched_at: number;
}

export interface DeviceRow {
  id: number;
  name: string | null;
  model: string | null;
  last_sync_utc: string | null;
  raw: Device;
  /** `getDeviceSettings`; null when Garmin had none or they were never fetched. */
  settings: DeviceSettings | null;
  fetched_at: number;
}

/** Raw responses of one training-metrics fetch; `null` when Garmin had nothing. */
export interface TrainingMetricsData {
  race_predictions: unknown;
  fitness_age: unknown;
  personal_records: unknown;
  endurance_score: unknown;
  hill_score: unknown;
  /** maxmet for the day; carries `heatAltitudeAcclimation`. */
  max_metrics: unknown;
}

export interface TrainingMetricsRow {
  date: string;
  raw: TrainingMetricsData;
  fetched_at: number;
}

export interface ProfileData {
  social: unknown;
  settings: unknown;
  heartRateZones: unknown;
  powerZones: unknown;
}

export interface SyncLogRow {
  id: number;
  scope: string;
  mode: string;
  from_date: string | null;
  to_date: string | null;
  started_at: number;
  finished_at: number | null;
  status: 'running' | 'ok' | 'partial' | 'error';
  error: string | null;
  stats: Record<string, number> | null;
}

/** Threshold parameters kept in `thresholds` (heart rates in bpm, power in W, CSS in s/100 m, running threshold pace in s/km). */
export const THRESHOLD_PARAMS = [
  'hrmax',
  'rhr',
  'lthr_run',
  'lthr_bike',
  'lthr_swim',
  'lt1_hr',
  'ftp_w',
  'run_ftp_w',
  'vo2max_run',
  'css_s_per_100m',
  'run_threshold_pace_s_per_km',
] as const;
export type ThresholdParam = (typeof THRESHOLD_PARAMS)[number];
export const THRESHOLD_SOURCES = ['garmin-auto', 'test', 'manual', 'import'] as const;
export type ThresholdSource = (typeof THRESHOLD_SOURCES)[number];

/** One threshold value, effective from `date` (YYYY-MM-DD) until the next row of the same param. */
export interface ThresholdRow {
  id: number;
  date: string;
  param: ThresholdParam;
  value: number;
  source: ThresholdSource;
  note: string | null;
  /** epoch ms */
  created_at: number;
}

export type NewThreshold = Omit<ThresholdRow, 'id' | 'note'> & { note?: string | null };

/** An activity from a Garmin Connect CSV export; `id` is `csv-` plus a content hash, so re-imports deduplicate. */
export interface ImportedActivityInput {
  id: string;
  start_time_local: string;
  type?: string | null;
  name?: string | null;
  duration_s?: number | null;
  moving_s?: number | null;
  distance_m?: number | null;
  elevation_gain_m?: number | null;
  elevation_loss_m?: number | null;
  avg_hr?: number | null;
  max_hr?: number | null;
  avg_power?: number | null;
  norm_power?: number | null;
  avg_cadence?: number | null;
  calories?: number | null;
  training_effect_aerobic?: number | null;
  training_effect_anaerobic?: number | null;
  source_file: string;
  /** epoch ms */
  imported_at: number;
}

export type ImportedActivityRow = { [K in keyof ImportedActivityInput]-?: Exclude<ImportedActivityInput[K], undefined> } & {
  date: string;
};

const IMPORTED_ACTIVITY_COLUMNS = [
  'id',
  'start_time_local',
  'type',
  'name',
  'duration_s',
  'moving_s',
  'distance_m',
  'elevation_gain_m',
  'elevation_loss_m',
  'avg_hr',
  'max_hr',
  'avg_power',
  'norm_power',
  'avg_cadence',
  'calories',
  'training_effect_aerobic',
  'training_effect_anaerobic',
  'source_file',
  'imported_at',
] as const satisfies readonly (keyof ImportedActivityInput)[];

export interface ActivityQuery {
  from?: IsoDate;
  to?: IsoDate;
  type?: string;
  gearUuid?: string;
  limit?: number;
  offset?: number;
  sort?: 'asc' | 'desc';
}

type RawRow = { raw: string } & Record<string, unknown>;

function parseRow<T>(row: RawRow | undefined): T | undefined {
  if (!row) return undefined;
  return { ...row, raw: JSON.parse(row.raw) as unknown } as T;
}

const DAILY_COLUMNS: Record<DailyKind, string[]> = {
  daily_summary: Object.keys(dailySummaryColumns(null)),
  sleep: Object.keys(sleepColumns(null)),
  hrv: Object.keys(hrvColumns(null)),
  training_status: Object.keys(trainingColumns(null, null)),
};

/**
 * Typed access to the SQLite cache. Synchronous by design (better-sqlite3); all
 * multi-row writes run in one transaction.
 */
export class Store {
  readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  static open(file: string): Store {
    return new Store(openDatabase(file));
  }

  close(): void {
    this.db.close();
  }

  // ------------------------------------------------------------ meta

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  getMetaNumber(key: string): number | undefined {
    const v = this.getMeta(key);
    return v === undefined ? undefined : Number(v);
  }

  // ------------------------------------------------------------ activities

  upsertActivities(list: readonly ActivitySummary[], fetchedAt: number): void {
    const stmt = this.db.prepare(`
      INSERT INTO activities (id, start_time_utc, start_time_local, type, name, duration_s, distance_m, avg_hr, max_hr,
        avg_power, training_effect_aerobic, training_effect_anaerobic, training_load, calories, elevation_gain_m, raw, fetched_at)
      VALUES (@id, @start_time_utc, @start_time_local, @type, @name, @duration_s, @distance_m, @avg_hr, @max_hr,
        @avg_power, @training_effect_aerobic, @training_effect_anaerobic, @training_load, @calories, @elevation_gain_m, @raw, @fetched_at)
      ON CONFLICT(id) DO UPDATE SET start_time_utc = excluded.start_time_utc, start_time_local = excluded.start_time_local,
        type = excluded.type, name = excluded.name, duration_s = excluded.duration_s, distance_m = excluded.distance_m,
        avg_hr = excluded.avg_hr, max_hr = excluded.max_hr, avg_power = excluded.avg_power,
        training_effect_aerobic = excluded.training_effect_aerobic, training_effect_anaerobic = excluded.training_effect_anaerobic,
        training_load = excluded.training_load, calories = excluded.calories, elevation_gain_m = excluded.elevation_gain_m,
        raw = excluded.raw, fetched_at = excluded.fetched_at`);
    this.db.transaction(() => {
      for (const a of list) stmt.run({ ...activityColumns(a), raw: JSON.stringify(a), fetched_at: fetchedAt });
    })();
  }

  /** Apply the result of an edit made through our tools; marks the row fresh. */
  applyActivityEdit(activity: Activity, fetchedAt: number): void {
    const cols = activityColumnsFromDetail(activity);
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT raw FROM activities WHERE id = ?').get(cols.id) as { raw: string } | undefined;
      if (row) {
        const raw = JSON.parse(row.raw) as Record<string, unknown>;
        raw.activityName = activity.activityName;
        raw.description = activity.description;
        if (activity.activityTypeDTO) raw.activityType = activity.activityTypeDTO;
        this.db
          .prepare('UPDATE activities SET name = ?, type = COALESCE(?, type), raw = ?, fetched_at = ? WHERE id = ?')
          .run(cols.name ?? null, cols.type ?? null, JSON.stringify(raw), fetchedAt, cols.id);
      }
      this.putActivityDetail(cols.id, 'summary', activity, fetchedAt);
    })();
  }

  deleteActivity(id: number): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM activities WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM activity_details WHERE activity_id = ?').run(id);
    })();
  }

  queryActivities(q: ActivityQuery = {}): ActivityRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.from) {
      where.push('date >= ?');
      params.push(q.from);
    }
    if (q.to) {
      where.push('date <= ?');
      params.push(q.to);
    }
    if (q.gearUuid) {
      where.push('gear_uuid = ?');
      params.push(q.gearUuid);
    }
    if (q.type) {
      where.push('(type = ? OR type LIKE ?)');
      params.push(q.type, `%${q.type}%`);
    }
    const sql = `SELECT * FROM activities ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY start_time_local ${q.sort === 'asc' ? 'ASC' : 'DESC'}, id ${q.sort === 'asc' ? 'ASC' : 'DESC'}
      LIMIT ? OFFSET ?`;
    params.push(q.limit ?? -1, q.offset ?? 0);
    return (this.db.prepare(sql).all(...params) as RawRow[]).map((r) => parseRow<ActivityRow>(r) as ActivityRow);
  }

  countActivities(q: Omit<ActivityQuery, 'limit' | 'offset' | 'sort'> = {}): number {
    return this.queryActivities({ ...q, limit: -1 }).length;
  }

  getActivity(id: number): ActivityRow | undefined {
    return parseRow<ActivityRow>(this.db.prepare('SELECT * FROM activities WHERE id = ?').get(id) as RawRow | undefined);
  }

  latestActivityDate(): string | undefined {
    const row = this.db.prepare('SELECT max(date) AS d FROM activities').get() as { d: string | null };
    return row.d ?? undefined;
  }

  setActivityGear(activityIds: readonly number[], gearUuid: string): void {
    const stmt = this.db.prepare('UPDATE activities SET gear_uuid = ? WHERE id = ?');
    this.db.transaction(() => {
      for (const id of activityIds) stmt.run(gearUuid, id);
    })();
  }

  putActivityDetail(activityId: number, kind: DetailKind, raw: unknown, fetchedAt: number): void {
    this.db
      .prepare(
        `INSERT INTO activity_details (activity_id, kind, raw, fetched_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(activity_id, kind) DO UPDATE SET raw = excluded.raw, fetched_at = excluded.fetched_at`,
      )
      .run(activityId, kind, JSON.stringify(raw ?? null), fetchedAt);
  }

  getActivityDetail(activityId: number, kind: DetailKind): { raw: unknown; fetched_at: number } | undefined {
    return parseRow(
      this.db.prepare('SELECT raw, fetched_at FROM activity_details WHERE activity_id = ? AND kind = ?').get(activityId, kind) as
        | RawRow
        | undefined,
    );
  }

  // ------------------------------------------------------------ daily tables

  putDaily<K extends DailyKind>(kind: K, date: IsoDate, columns: Record<string, unknown>, raw: unknown, fetchedAt: number): void {
    const cols = DAILY_COLUMNS[kind];
    const names = ['date', ...cols, 'raw', 'fetched_at'];
    const sql = `INSERT INTO ${kind} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})
      ON CONFLICT(date) DO UPDATE SET ${[...cols, 'raw', 'fetched_at'].map((c) => `${c} = excluded.${c}`).join(', ')}`;
    this.db.prepare(sql).run(date, ...cols.map((c) => columns[c] ?? null), JSON.stringify(raw ?? null), fetchedAt);
  }

  getDaily<K extends DailyKind>(kind: K, from: IsoDate, to: IsoDate): DailyRows[K][] {
    return (this.db.prepare(`SELECT * FROM ${kind} WHERE date >= ? AND date <= ? ORDER BY date`).all(from, to) as RawRow[]).map(
      (r) => parseRow<DailyRows[K]>(r) as DailyRows[K],
    );
  }

  /** date → fetched_at for rows present in the range; used for coverage and TTL decisions. */
  dailyFetchedAt(kind: DailyKind, from: IsoDate, to: IsoDate): Map<string, number> {
    const rows = this.db
      .prepare(`SELECT date, fetched_at FROM ${kind} WHERE date >= ? AND date <= ?`)
      .all(from, to) as { date: string; fetched_at: number }[];
    return new Map(rows.map((r) => [r.date, r.fetched_at]));
  }

  // ------------------------------------------------------------ training metrics

  putTrainingMetrics(date: IsoDate, raw: TrainingMetricsData, fetchedAt: number): void {
    this.db
      .prepare(
        `INSERT INTO training_metrics (date, raw, fetched_at) VALUES (?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET raw = excluded.raw, fetched_at = excluded.fetched_at`,
      )
      .run(date, JSON.stringify(raw), fetchedAt);
  }

  /** The newest training-metrics row on or before `date`. */
  latestTrainingMetrics(date: IsoDate): TrainingMetricsRow | undefined {
    return parseRow<TrainingMetricsRow>(
      this.db.prepare('SELECT * FROM training_metrics WHERE date <= ? ORDER BY date DESC LIMIT 1').get(date) as RawRow | undefined,
    );
  }

  // ------------------------------------------------------------ body composition

  upsertWeighIns(entries: readonly WeightEntry[], fetchedAt: number): void {
    const stmt = this.db.prepare(`
      INSERT INTO body_composition (sample_time_utc, date, sample_pk, weight_kg, body_fat_pct, muscle_mass_kg, bmi, raw, fetched_at)
      VALUES (@sample_time_utc, @date, @sample_pk, @weight_kg, @body_fat_pct, @muscle_mass_kg, @bmi, @raw, @fetched_at)
      ON CONFLICT(sample_time_utc) DO UPDATE SET date = excluded.date, sample_pk = excluded.sample_pk,
        weight_kg = excluded.weight_kg, body_fat_pct = excluded.body_fat_pct, muscle_mass_kg = excluded.muscle_mass_kg,
        bmi = excluded.bmi, raw = excluded.raw, fetched_at = excluded.fetched_at`);
    this.db.transaction(() => {
      for (const e of entries) stmt.run({ ...bodyCompositionColumns(e), raw: JSON.stringify(e), fetched_at: fetchedAt });
    })();
  }

  /** Replace all samples in [from, to] with `entries` (handles deletions done in Garmin Connect). */
  replaceWeighIns(from: IsoDate, to: IsoDate, entries: readonly WeightEntry[], fetchedAt: number): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM body_composition WHERE date >= ? AND date <= ?').run(from, to);
      this.upsertWeighIns(entries, fetchedAt);
    })();
  }

  getBodyComposition(from: IsoDate, to: IsoDate): BodyCompositionRow[] {
    return (
      this.db.prepare('SELECT * FROM body_composition WHERE date >= ? AND date <= ? ORDER BY sample_time_utc').all(from, to) as RawRow[]
    ).map((r) => parseRow<BodyCompositionRow>(r) as BodyCompositionRow);
  }

  deleteWeighIn(samplePk: number): void {
    this.db.prepare('DELETE FROM body_composition WHERE sample_pk = ?').run(samplePk);
  }

  // ------------------------------------------------------------ reference data

  replaceWorkouts(list: readonly WorkoutSummary[], fetchedAt: number): void {
    const stmt = this.db.prepare(
      'INSERT INTO workouts (id, name, sport, updated_at, raw, fetched_at) VALUES (@id, @name, @sport, @updated_at, @raw, @fetched_at)',
    );
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM workouts').run();
      for (const w of list) stmt.run({ ...workoutColumns(w), raw: JSON.stringify(w), fetched_at: fetchedAt });
    })();
  }

  upsertWorkout(w: WorkoutSummary, fetchedAt: number): void {
    this.db
      .prepare(
        `INSERT INTO workouts (id, name, sport, updated_at, raw, fetched_at) VALUES (@id, @name, @sport, @updated_at, @raw, @fetched_at)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, sport = excluded.sport, updated_at = excluded.updated_at,
         raw = excluded.raw, fetched_at = excluded.fetched_at`,
      )
      .run({ ...workoutColumns(w), raw: JSON.stringify(w), fetched_at: fetchedAt });
  }

  deleteWorkout(id: number): void {
    this.db.prepare('DELETE FROM workouts WHERE id = ?').run(id);
  }

  /** One saved workout; `raw` has the steps only when it came from `getWorkout`/`createWorkout`, not from the list. */
  getWorkout(id: number): WorkoutRow | undefined {
    return parseRow<WorkoutRow>(this.db.prepare('SELECT * FROM workouts WHERE id = ?').get(id) as RawRow | undefined);
  }

  getWorkouts(opts: { sport?: string; limit?: number } = {}): WorkoutRow[] {
    const rows = opts.sport
      ? this.db.prepare('SELECT * FROM workouts WHERE sport = ? ORDER BY updated_at DESC LIMIT ?').all(opts.sport, opts.limit ?? -1)
      : this.db.prepare('SELECT * FROM workouts ORDER BY updated_at DESC LIMIT ?').all(opts.limit ?? -1);
    return (rows as RawRow[]).map((r) => parseRow<WorkoutRow>(r) as WorkoutRow);
  }

  /**
   * Replace the calendar in [from, to]: items of type "workout" go to `workout_schedule`,
   * races and events (type "event") to `calendar_events`. Other item types (activities,
   * weigh-ins, badges, …) duplicate other tables and are skipped, and so are items outside
   * [from, to]: a month's calendar also shows the last days of the previous month, which only
   * that month's own refresh may replace.
   */
  replaceSchedule(from: IsoDate, to: IsoDate, items: readonly CalendarItem[], fetchedAt: number): void {
    const workout = this.db.prepare(
      `INSERT INTO workout_schedule (id, workout_id, date, raw, fetched_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET workout_id = excluded.workout_id, date = excluded.date, raw = excluded.raw, fetched_at = excluded.fetched_at`,
    );
    const event = this.db.prepare(
      `INSERT INTO calendar_events (id, date, raw, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET date = excluded.date, raw = excluded.raw, fetched_at = excluded.fetched_at`,
    );
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM workout_schedule WHERE date >= ? AND date <= ?').run(from, to);
      this.db.prepare('DELETE FROM calendar_events WHERE date >= ? AND date <= ?').run(from, to);
      for (const it of items) {
        if (it.id == null || !it.date || it.date < from || it.date > to) continue;
        if (it.itemType === 'workout') workout.run(it.id, it.workoutId ?? null, it.date ?? null, JSON.stringify(it), fetchedAt);
        else if (it.itemType === 'event') event.run(it.id, it.date ?? null, JSON.stringify(it), fetchedAt);
      }
    })();
  }

  getCalendarEvents(from: IsoDate, to: IsoDate): CalendarEventRow[] {
    return (this.db.prepare('SELECT * FROM calendar_events WHERE date >= ? AND date <= ? ORDER BY date, id').all(from, to) as RawRow[]).map(
      (r) => parseRow<CalendarEventRow>(r) as CalendarEventRow,
    );
  }

  addSchedule(id: number, workoutId: number, date: IsoDate, raw: unknown, fetchedAt: number): void {
    this.db
      .prepare(
        `INSERT INTO workout_schedule (id, workout_id, date, raw, fetched_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET workout_id = excluded.workout_id, date = excluded.date, raw = excluded.raw, fetched_at = excluded.fetched_at`,
      )
      .run(id, workoutId, date, JSON.stringify(raw), fetchedAt);
  }

  deleteSchedule(id: number): void {
    this.db.prepare('DELETE FROM workout_schedule WHERE id = ?').run(id);
  }

  getSchedule(from: IsoDate, to: IsoDate): ScheduleRow[] {
    return (this.db.prepare('SELECT * FROM workout_schedule WHERE date >= ? AND date <= ? ORDER BY date').all(from, to) as RawRow[]).map(
      (r) => parseRow<ScheduleRow>(r) as ScheduleRow,
    );
  }

  replaceGear(items: readonly { gear: Gear; stats: GearStats | null }[], fetchedAt: number): void {
    const stmt = this.db.prepare(
      `INSERT INTO gear (uuid, name, type, status, total_distance_m, raw, fetched_at)
       VALUES (@uuid, @name, @type, @status, @total_distance_m, @raw, @fetched_at)`,
    );
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM gear').run();
      for (const it of items) stmt.run({ ...gearColumns(it.gear, it.stats), raw: JSON.stringify(it), fetched_at: fetchedAt });
    })();
  }

  getGear(): GearRow[] {
    return (this.db.prepare("SELECT * FROM gear ORDER BY status = 'active' DESC, name").all() as RawRow[]).map(
      (r) => parseRow<GearRow>(r) as GearRow,
    );
  }

  /** Replaces the device list; `settings` maps device id to its settings (missing id: none). */
  replaceDevices(
    devices: readonly Device[],
    lastUsed: DeviceLastUsed | null,
    fetchedAt: number,
    settings: ReadonlyMap<number, DeviceSettings | null> = new Map(),
  ): void {
    const stmt = this.db.prepare(
      'INSERT INTO devices (id, name, model, last_sync_utc, raw, settings, fetched_at) VALUES (@id, @name, @model, @last_sync_utc, @raw, @settings, @fetched_at)',
    );
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM devices').run();
      for (const d of devices) {
        const lastSync = lastUsed && lastUsed.userDeviceId === d.deviceId ? normalizeUtc(lastUsed.lastUsedDeviceUploadTime) : null;
        const s = settings.get(d.deviceId) ?? null;
        stmt.run({ ...deviceColumns(d, lastSync), raw: JSON.stringify(d), settings: s === null ? null : JSON.stringify(s), fetched_at: fetchedAt });
      }
    })();
  }

  getDevices(): DeviceRow[] {
    return (this.db.prepare('SELECT * FROM devices ORDER BY last_sync_utc DESC NULLS LAST, name').all() as (RawRow & { settings: string | null })[]).map(
      (r) => ({ ...(parseRow<DeviceRow>(r) as DeviceRow), settings: r.settings === null ? null : (JSON.parse(r.settings) as DeviceSettings) }),
    );
  }

  setProfile(data: ProfileData, fetchedAt: number): void {
    this.db
      .prepare(
        'INSERT INTO profile (id, raw, fetched_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET raw = excluded.raw, fetched_at = excluded.fetched_at',
      )
      .run(JSON.stringify(data), fetchedAt);
  }

  getProfile(): { raw: ProfileData; fetched_at: number } | undefined {
    return parseRow(this.db.prepare('SELECT raw, fetched_at FROM profile WHERE id = 1').get() as RawRow | undefined);
  }

  /** Garmin's activity type list, kept as one JSON value in `meta` (no table of its own). */
  setActivityTypes(types: readonly ActivityType[]): void {
    this.setMeta('activity_types', JSON.stringify(types));
  }

  getActivityTypes(): ActivityType[] {
    const v = this.getMeta('activity_types');
    return v === undefined ? [] : (JSON.parse(v) as ActivityType[]);
  }

  /** Last successful refresh of a reference kind (profile, gear, devices, workouts, activity types). */
  referenceFetchedAt(kind: ReferenceKind): number | undefined {
    return this.getMetaNumber(`ref:${kind}:fetched_at`);
  }

  markReferenceFetched(kind: ReferenceKind, at: number): void {
    this.setMeta(`ref:${kind}:fetched_at`, String(at));
  }

  // ------------------------------------------------------------ analytics: thresholds

  /** Threshold history, oldest first (same date: in insertion order); one param or all. */
  listThresholds(param?: ThresholdParam): ThresholdRow[] {
    const order = 'ORDER BY param, date, created_at, id';
    return (
      param
        ? this.db.prepare(`SELECT * FROM thresholds WHERE param = ? ${order}`).all(param)
        : this.db.prepare(`SELECT * FROM thresholds ${order}`).all()
    ) as ThresholdRow[];
  }

  /** Adds one row; a row with the same (date, param, source) already stored is left as it is. */
  addThreshold(row: NewThreshold): { added: boolean } {
    const res = this.db
      .prepare(
        `INSERT INTO thresholds (date, param, value, source, note, created_at) VALUES (@date, @param, @value, @source, @note, @created_at)
         ON CONFLICT(date, param, source) DO NOTHING`,
      )
      .run({ ...row, note: row.note ?? null });
    return { added: res.changes > 0 };
  }

  /**
   * Import: each row overwrites the value and note of the stored row with the same
   * (date, param, source) (its `created_at` stays), or is added. Rows with other keys stay;
   * identical rows count as skipped.
   */
  replaceThresholds(rows: readonly NewThreshold[]): { added: number; updated: number; skipped: number } {
    const find = this.db.prepare('SELECT value, note FROM thresholds WHERE date = ? AND param = ? AND source = ?');
    const insert = this.db.prepare(
      'INSERT INTO thresholds (date, param, value, source, note, created_at) VALUES (@date, @param, @value, @source, @note, @created_at)',
    );
    const update = this.db.prepare(
      'UPDATE thresholds SET value = @value, note = @note WHERE date = @date AND param = @param AND source = @source',
    );
    const out = { added: 0, updated: 0, skipped: 0 };
    this.db.transaction(() => {
      for (const r of rows) {
        const row = { ...r, note: r.note ?? null };
        const old = find.get(row.date, row.param, row.source) as { value: number; note: string | null } | undefined;
        if (!old) {
          insert.run(row);
          out.added++;
        } else if (old.value !== row.value || old.note !== row.note) {
          update.run(row);
          out.updated++;
        } else out.skipped++;
      }
    })();
    return out;
  }

  // ------------------------------------------------------------ analytics: imported activities

  /** Adds or overwrites activities by `id` (a re-import of the same export only updates). */
  upsertImportedActivities(rows: readonly ImportedActivityInput[]): { added: number; updated: number } {
    const cols = IMPORTED_ACTIVITY_COLUMNS;
    const stmt = this.db.prepare(
      `INSERT INTO imported_activities (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})
       ON CONFLICT(id) DO UPDATE SET ${cols
         .filter((c) => c !== 'id')
         .map((c) => `${c} = excluded.${c}`)
         .join(', ')}`,
    );
    const exists = this.db.prepare('SELECT 1 FROM imported_activities WHERE id = ?');
    const out = { added: 0, updated: 0 };
    this.db.transaction(() => {
      for (const r of rows) {
        if (exists.get(r.id)) out.updated++;
        else out.added++;
        stmt.run(Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
      }
    })();
    return out;
  }

  getImportedActivities(from: IsoDate, to: IsoDate): ImportedActivityRow[] {
    return this.db
      .prepare('SELECT * FROM imported_activities WHERE date >= ? AND date <= ? ORDER BY start_time_local, id')
      .all(from, to) as ImportedActivityRow[];
  }

  countImportedActivities(): number {
    return (this.db.prepare('SELECT count(*) AS n FROM imported_activities').get() as { n: number }).n;
  }

  // ------------------------------------------------------------ sync log

  startSync(scope: string, mode: string, from: string | undefined, to: string | undefined, at: number): number {
    const res = this.db
      .prepare("INSERT INTO sync_log (scope, mode, from_date, to_date, started_at, status) VALUES (?, ?, ?, ?, ?, 'running')")
      .run(scope, mode, from ?? null, to ?? null, at);
    return Number(res.lastInsertRowid);
  }

  finishSync(id: number, status: SyncLogRow['status'], at: number, stats: Record<string, number>, error?: string): void {
    this.db
      .prepare('UPDATE sync_log SET status = ?, finished_at = ?, stats = ?, error = ? WHERE id = ?')
      .run(status, at, JSON.stringify(stats), error ?? null, id);
  }

  recentSyncs(limit = 10): SyncLogRow[] {
    const rows = this.db.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT ?').all(limit) as (Omit<SyncLogRow, 'stats'> & {
      stats: string | null;
    })[];
    return rows.map((r) => ({ ...r, stats: r.stats ? (JSON.parse(r.stats) as Record<string, number>) : null }));
  }

  /** Mark syncs left "running" by a crashed process as errors. */
  abandonRunningSyncs(at: number): void {
    this.db.prepare("UPDATE sync_log SET status = 'error', finished_at = ?, error = 'interrupted' WHERE status = 'running'").run(at);
  }

  // ------------------------------------------------------------ stats

  tableStats(): { table: string; rows: number; from: string | null; to: string | null }[] {
    const dated: [string, string][] = [
      ['activities', 'date'],
      ['daily_summary', 'date'],
      ['sleep', 'date'],
      ['hrv', 'date'],
      ['training_status', 'date'],
      ['training_metrics', 'date'],
      ['body_composition', 'date'],
      ['workout_schedule', 'date'],
      ['calendar_events', 'date'],
      ['thresholds', 'date'],
      ['imported_activities', 'date'],
    ];
    const out = dated.map(([table, col]) => {
      const r = this.db.prepare(`SELECT count(*) AS n, min(${col}) AS a, max(${col}) AS b FROM ${table}`).get() as {
        n: number;
        a: string | null;
        b: string | null;
      };
      return { table, rows: r.n, from: r.a, to: r.b };
    });
    for (const table of ['activity_details', 'workouts', 'gear', 'devices', 'profile']) {
      const r = this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
      out.push({ table, rows: r.n, from: null, to: null });
    }
    return out;
  }
}
