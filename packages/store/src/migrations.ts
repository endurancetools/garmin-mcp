/**
 * Schema migrations, applied in order inside a transaction. Tables keep Garmin's raw
 * JSON in `raw` plus extracted columns for queries; a Garmin-side change
 * only ever needs new columns, never a data rewrite.
 */
export const MIGRATIONS: readonly string[] = [
  /* 1 */ `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);

  CREATE TABLE activities (
    id INTEGER PRIMARY KEY,
    start_time_utc TEXT,
    start_time_local TEXT,
    date TEXT GENERATED ALWAYS AS (substr(start_time_local, 1, 10)) STORED,
    type TEXT,
    name TEXT,
    duration_s REAL,
    distance_m REAL,
    avg_hr REAL,
    max_hr REAL,
    avg_power REAL,
    training_effect_aerobic REAL,
    training_effect_anaerobic REAL,
    training_load REAL,
    calories REAL,
    elevation_gain_m REAL,
    gear_uuid TEXT,
    raw TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );
  CREATE INDEX activities_start ON activities(start_time_local);
  CREATE INDEX activities_type_start ON activities(type, start_time_local);

  CREATE TABLE activity_details (
    activity_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('summary', 'splits', 'hr_zones', 'details')),
    raw TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (activity_id, kind)
  );

  CREATE TABLE daily_summary (
    date TEXT PRIMARY KEY,
    steps REAL,
    resting_hr REAL,
    avg_stress REAL,
    body_battery_high REAL,
    body_battery_low REAL,
    total_calories REAL,
    active_calories REAL,
    intensity_minutes REAL,
    avg_spo2 REAL,
    avg_respiration REAL,
    raw TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );

  CREATE TABLE sleep (
    date TEXT PRIMARY KEY,
    start_utc TEXT,
    end_utc TEXT,
    duration_s REAL,
    deep_s REAL,
    light_s REAL,
    rem_s REAL,
    awake_s REAL,
    score REAL,
    avg_spo2 REAL,
    avg_respiration REAL,
    raw TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );

  CREATE TABLE hrv (
    date TEXT PRIMARY KEY,
    last_night_avg REAL,
    weekly_avg REAL,
    status TEXT,
    baseline_low REAL,
    baseline_high REAL,
    raw TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );

  CREATE TABLE training_status (
    date TEXT PRIMARY KEY,
    vo2max_running REAL,
    vo2max_cycling REAL,
    status TEXT,
    acute_load REAL,
    chronic_load REAL,
    readiness_score REAL,
    raw TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );

  CREATE TABLE body_composition (
    sample_time_utc TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    sample_pk INTEGER,
    weight_kg REAL,
    body_fat_pct REAL,
    muscle_mass_kg REAL,
    bmi REAL,
    raw TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );
  CREATE INDEX body_composition_date ON body_composition(date);

  CREATE TABLE workouts (
    id INTEGER PRIMARY KEY,
    name TEXT,
    sport TEXT,
    updated_at TEXT,
    raw TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );

  CREATE TABLE workout_schedule (
    id INTEGER PRIMARY KEY,
    workout_id INTEGER,
    date TEXT,
    raw TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );
  CREATE INDEX workout_schedule_date ON workout_schedule(date);

  CREATE TABLE gear (
    uuid TEXT PRIMARY KEY,
    name TEXT,
    type TEXT,
    status TEXT,
    total_distance_m REAL,
    raw TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );

  CREATE TABLE devices (
    id INTEGER PRIMARY KEY,
    name TEXT,
    model TEXT,
    last_sync_utc TEXT,
    raw TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );

  CREATE TABLE profile (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    raw TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );

  CREATE TABLE sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL,
    mode TEXT NOT NULL,
    from_date TEXT,
    to_date TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    status TEXT NOT NULL,
    error TEXT,
    stats TEXT
  );
  `,
  /* 2 */ `
  -- Current-state training metrics (race predictions, endurance and hill score,
  -- fitness age, personal records, heat/altitude acclimation), one row per day
  -- on which a training sync fetched them.
  CREATE TABLE training_metrics (
    date TEXT PRIMARY KEY,
    raw TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );
  `,
  /* 3 */ `
  -- New activity detail kinds (weather, power zones, strength sets). SQLite cannot
  -- alter a CHECK constraint, so the table is rebuilt with its rows kept.
  CREATE TABLE activity_details_v3 (
    activity_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('summary', 'splits', 'hr_zones', 'details', 'weather', 'power_zones', 'exercise_sets')),
    raw TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (activity_id, kind)
  );
  INSERT INTO activity_details_v3 (activity_id, kind, raw, fetched_at) SELECT activity_id, kind, raw, fetched_at FROM activity_details;
  DROP TABLE activity_details;
  ALTER TABLE activity_details_v3 RENAME TO activity_details;
  `,
  /* 4 */ `
  -- Races and events from the Garmin Connect calendar (items of type "event"),
  -- kept from the same calendar-service responses as the workout schedule.
  CREATE TABLE calendar_events (
    id INTEGER PRIMARY KEY,
    date TEXT,
    raw TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );
  CREATE INDEX calendar_events_date ON calendar_events(date);
  `,
  /* 5 */ `
  -- Device settings (device-info/settings/{deviceId}), fetched with the device
  -- list. Devices stored before have none, so the next reference sync fetches
  -- them again instead of waiting for the device list to go stale.
  ALTER TABLE devices ADD COLUMN settings TEXT;
  DELETE FROM meta WHERE key = 'ref:devices:fetched_at';
  `,
  /* 6 */ `
  -- Own tables of the training analytics, not Garmin data (no raw JSON).
  -- Training thresholds with history: a value holds from its date until the next one.
  CREATE TABLE thresholds (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL,
    param TEXT NOT NULL,
    value REAL NOT NULL,
    source TEXT NOT NULL,
    note TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (date, param, source)
  );
  CREATE INDEX thresholds_param_date ON thresholds(param, date);

  -- Activities from a Garmin Connect CSV export, for dates the cache does not cover.
  CREATE TABLE imported_activities (
    id TEXT PRIMARY KEY,
    start_time_local TEXT NOT NULL,
    date TEXT GENERATED ALWAYS AS (substr(start_time_local, 1, 10)) STORED,
    type TEXT,
    name TEXT,
    duration_s REAL,
    moving_s REAL,
    distance_m REAL,
    elevation_gain_m REAL,
    elevation_loss_m REAL,
    avg_hr REAL,
    max_hr REAL,
    avg_power REAL,
    norm_power REAL,
    avg_cadence REAL,
    calories REAL,
    training_effect_aerobic REAL,
    training_effect_anaerobic REAL,
    source_file TEXT NOT NULL,
    imported_at INTEGER NOT NULL
  );
  CREATE INDEX imported_activities_date ON imported_activities(date);
  `,
  /* 7 */ `
  -- Races added from Garmin's event catalogue come in the calendar with id null and only a
  -- shareableEventUuid, so calendar events are keyed by text: the calendar id, else "uuid:<uuid>".
  CREATE TABLE calendar_events_new (
    key TEXT PRIMARY KEY,
    id INTEGER,
    date TEXT,
    raw TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );
  INSERT INTO calendar_events_new (key, id, date, raw, fetched_at)
    SELECT CAST(id AS TEXT), id, date, raw, fetched_at FROM calendar_events;
  DROP TABLE calendar_events;
  ALTER TABLE calendar_events_new RENAME TO calendar_events;
  CREATE INDEX calendar_events_date ON calendar_events(date);
  -- Months cached before skipped those races: the next read fetches them again.
  DELETE FROM meta WHERE key = 'calendar:months';
  `,
];
