/**
 * MCP `outputSchema` of every tool: the `{ data, meta }` envelope that `GarminService`
 * returns, with `data` described down to the fields of its nested objects and list items.
 * Deeper levels and raw Garmin JSON stay any JSON. Every object is loose (extra fields are
 * allowed) and nearly every field optional, because `compact` drops empty values and a
 * result that fails its schema reaches the client as an error. The MCP server checks at
 * compile time that each service method's return type fits its schema.
 */
import { z } from 'zod';
import { responseMetaSchema } from './service.js';

const str = z.string().optional();
const num = z.number().optional();
const bool = z.boolean().optional();
/** Deeper than two levels, or raw Garmin JSON: any JSON value. */
const any = z.unknown().optional();
const list = <T extends z.ZodType>(item: T) => z.array(item).optional();
const obj = <S extends z.core.$ZodLooseShape>(shape: S) => z.looseObject(shape).optional();
const raw = z.record(z.string(), z.unknown()).optional();

function envelope<S extends z.core.$ZodLooseShape>(data: S) {
  return z.looseObject({ data: z.looseObject(data), meta: responseMetaSchema });
}

const activityBrief = {
  id: z.number(),
  date: str,
  start_local: str,
  type: str,
  name: str,
  duration: str,
  distance_km: num,
  avg_pace: str,
  avg_speed_kmh: num,
  elevation_gain_m: num,
  avg_hr_bpm: num,
  max_hr_bpm: num,
  avg_power_w: num,
  training_load: num,
  training_effect: any,
  calories_kcal: num,
};

const zoneTime = z.looseObject({ zone: num, from_bpm: num, from_w: num, time: str, pct: num });

const activityDetail = {
  ...activityBrief,
  description: str,
  location: str,
  moving_time: str,
  elevation_loss_m: num,
  max_power_w: num,
  normalized_power_w: num,
  rpe: num,
  feel: num,
  gear_uuid: str,
  splits: list(
    z.looseObject({
      lap: num,
      distance_km: num,
      duration: str,
      avg_pace: str,
      avg_speed_kmh: num,
      avg_hr_bpm: num,
      max_hr_bpm: num,
      avg_power_w: num,
      cadence_spm: num,
      elevation_gain_m: num,
    }),
  ),
  hr_zones: list(zoneTime),
  power_zones: list(zoneTime),
  weather: obj({
    temp_c: num,
    feels_like_c: num,
    dew_point_c: num,
    humidity_pct: num,
    wind_kmh: num,
    wind_gust_kmh: num,
    wind_from: str,
    wind_dir_deg: num,
    conditions: str,
    station: str,
    observed_at: str,
  }),
  exercise_sets: obj({ sets: list(z.unknown()), total_sets: num, total_reps: num, volume_kg: num }),
  raw_summary: raw,
  stream: obj({ metrics: list(z.string()), total_samples: num, offset: num, samples: list(z.unknown()) }),
  next_cursor: str,
};

const trend = obj({
  latest: num,
  latest_date: str,
  avg_7d: num,
  avg_28d: num,
  change_7d_vs_28d: num,
  direction: str,
  deviation_from_baseline_sd: num,
  samples: num,
});

const loadPoint = { date: str, load: num, ctl: num, atl: num, tsb: num };

const readableWorkout = {
  name: str,
  sport: str,
  description: str,
  estimated_distance_m: num,
  step_count: num,
  steps: list(z.string()),
};

export const syncOutput = envelope({
  status: str,
  joined_running_job: obj({ scope: str, from: str, to: str, force: bool }),
  requests: num,
  chunks: str,
  fetched: z.record(z.string(), z.number()).optional(),
  remaining: obj({ from: str, to: str }),
  resume_at: str,
  reason: str,
  errors: list(z.string()),
  limits: obj({ requests_today: num, max_requests_per_day: num, paused_until: str, pause_reason: str }),
});

export const activitiesOutput = envelope({ activities: list(z.looseObject(activityBrief)), next_cursor: str });

export const activityOutput = envelope(activityDetail);

export const updateActivityOutput = envelope({ updated: bool, activity: obj(activityDetail) });

export const downloadOutput = envelope({ path: str, bytes: num, format: str });

export const healthOutput = envelope({
  from: str,
  to: str,
  granularity: str,
  rows: list(z.record(z.string(), z.union([z.string(), z.number()]))),
  summary: z.record(z.string(), z.looseObject({ avg: num, min: num, max: num, total: num, days_with_data: num, trend: any })).optional(),
});

/** One night (`date`), a night without sleep (`sleep: null`), or a range (`from`, `to`, `summary`, `nights`). */
export const sleepOutput = envelope({
  date: str,
  sleep: z.null().optional(),
  note: str,
  start_utc: str,
  end_utc: str,
  duration: str,
  duration_h: num,
  score: num,
  quality: str,
  stages_h: obj({ deep: num, light: num, rem: num, awake: num }),
  stages_pct: obj({ deep: num, light: num, rem: num }),
  avg_spo2_pct: num,
  avg_respiration_brpm: num,
  avg_overnight_hrv_ms: num,
  resting_hr_bpm: num,
  body_battery_change: num,
  from: str,
  to: str,
  summary: obj({
    nights: num,
    avg_duration_h: num,
    avg_score: num,
    avg_deep_h: num,
    avg_rem_h: num,
    best_night: any,
    worst_night: any,
    short_nights_under_6h: num,
    duration_trend: any,
    score_trend: any,
  }),
  nights: list(
    z.looseObject({
      date: str,
      duration: str,
      score: num,
      deep_h: num,
      rem_h: num,
      awake_h: num,
      avg_spo2_pct: num,
      avg_respiration_brpm: num,
      hrv_ms: num,
    }),
  ),
});

export const trainingStatusOutput = envelope({
  as_of: str,
  vo2max: obj({ running: num, cycling: num, running_trend: any }),
  readiness: obj({ score: num, level: str, feedback: str, trend: any }),
  garmin_status: str,
  garmin_load: obj({ acute: num, chronic: num, ratio: num, acwr_status: str }),
  recovery: obj({ remaining_h: num, as_of: str }),
  load_focus: obj({ feedback: str, aerobic_low: any, aerobic_high: any, anaerobic: any }),
  garmin_load_model: obj({ ...loadPoint, form: str }),
  load_series: list(z.looseObject(loadPoint)),
  metrics: obj({
    as_of: str,
    race_predictions: any,
    endurance_score: any,
    hill_score: any,
    fitness_age: any,
    acclimation: any,
    personal_records: list(z.unknown()),
  }),
  note: str,
});

export const bodyCompositionOutput = envelope({
  from: str,
  to: str,
  measurements: list(z.looseObject({ time_utc: str, date: str, sample_pk: num, weight_kg: num, body_fat_pct: num, muscle_mass_kg: num, bmi: num })),
  latest: obj({ date: str, weight_kg: num, body_fat_pct: num }),
  change_kg: num,
  weight_trend: trend,
  body_fat_trend: trend,
});

export const periodSummaryOutput = envelope({
  period: str,
  from: str,
  to: str,
  complete: bool,
  training: obj({
    from: str,
    to: str,
    sessions: num,
    total_duration: str,
    total_distance_km: num,
    total_training_load: num,
    by_sport: list(z.unknown()),
    hr_zones: list(z.unknown()),
    active_days: num,
    rest_days: num,
    longest: any,
    hardest: any,
  }),
  garmin_load_model: obj({ ...loadPoint, form: str }),
  health: z.record(z.string(), z.looseObject({ avg: num, min: num, max: num, total: num })).optional(),
  energy: obj({ avg_total_kcal: num, avg_resting_kcal: num, avg_active_kcal: num }),
});

export const listWorkoutsOutput = envelope({
  from: str,
  to: str,
  workouts: list(z.looseObject({ id: num, name: str, sport: str, updated: str, description: str, estimated_duration: str, estimated_distance_km: num })),
  upcoming_schedule: list(z.looseObject({ date: str, workout_id: num, title: str, schedule_id: num })),
  upcoming_events: list(
    z.looseObject({ id: num, date: str, title: str, race: bool, primary: bool, distance_km: num, start_time: str, time_zone: str, location: str, url: str }),
  ),
});

export const workoutOutput = envelope({ id: z.union([z.number(), z.string()]).optional(), ...readableWorkout, estimated_duration_s: num });

export const previewWorkoutOutput = envelope({ ...readableWorkout, estimated_duration: str, estimate_note: str, next: str });

export const createWorkoutOutput = envelope({ workout_id: num, name: str, sport: str, updated: bool });

export const scheduleOutput = envelope({
  results: list(z.looseObject({ date: str, workout_id: num, ok: bool, schedule_id: num, error: str })),
  unschedule_results: list(z.looseObject({ schedule_id: num, ok: bool, error: str })),
  scheduled: num,
  unscheduled: num,
  failed: num,
});

export const gearOutput = envelope({
  gear: list(
    z.looseObject({
      uuid: str,
      name: str,
      type: str,
      status: str,
      distance_km: num,
      activities: num,
      max_distance_km: num,
      in_use_since: str,
      retired: str,
      notes: str,
      recent_activities: list(z.unknown()),
    }),
  ),
});

export const devicesOutput = envelope({
  devices: list(z.looseObject({ id: num, name: str, model: str, firmware: str, primary: bool, last_sync_utc: str, settings: any })),
});

export const deleteActivityOutput = envelope({ deleted: bool, activity_id: num });
export const deleteWorkoutOutput = envelope({ deleted: bool, workout_id: num });
export const deleteWeighInOutput = envelope({ deleted: bool, sample_pk: num });
