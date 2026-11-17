import type { ToolAnnotations } from '@modelcontextprotocol/server';
import {
  AnalyticsService,
  DEFAULT_LOAD_FLAGS,
  DEFAULT_READINESS_RULES,
  compareOutput,
  loadOutput,
  readinessOutput,
  SET_THRESHOLD_SOURCES,
  setThresholdOutput,
  thresholdsOutput,
} from 'garmin-mcp-analytics';
import {
  activitiesOutput,
  activityOutput,
  bodyCompositionOutput,
  createWorkoutOutput,
  deleteActivityOutput,
  deleteWeighInOutput,
  deleteWorkoutOutput,
  devicesOutput,
  downloadOutput,
  gearOutput,
  HEALTH_METRICS,
  healthOutput,
  listWorkoutsOutput,
  periodSummaryOutput,
  scheduleOutput,
  sleepOutput,
  syncOutput,
  trainingStatusOutput,
  updateActivityOutput,
  workoutDefinitionSchema,
  workoutOutput,
  workoutPresetSchema,
  type GarminService,
  type SyncProgressOptions,
} from 'garmin-mcp-domain';
import { SYNC_SCOPES, THRESHOLD_PARAMS } from 'garmin-mcp-store';
import { z } from 'zod';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const id = z.coerce.number().int().positive();

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  input: Record<string, z.ZodType>;
  /** `{ data, meta }` envelope of the result: MCP `outputSchema`, checked by the SDK against `structuredContent`. */
  output: z.ZodType;
  annotations: ToolAnnotations;
  destructive?: boolean;
  /** Opt-in part of an always-on tool: merged in by selectTools only with GARMIN_ENABLE_DESTRUCTIVE. */
  destructiveOption?: { input: Record<string, z.ZodType>; description: string; disabledError: string };
  /** Set by selectTools when the option is off: sending one of these fields fails with this error instead of being dropped. */
  rejectedFields?: { names: string[]; error: string };
  /** `ctx.onProgress` is set when the client asked for progress (`_meta.progressToken`). */
  run(service: GarminService, args: Record<string, unknown>, ctx: SyncProgressOptions): Promise<unknown>;
}

const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const DELETE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
/** Writes the local database only: nothing is sent to Garmin, nothing is overwritten. */
const LOCAL_WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

/** One `AnalyticsService` per `GarminService` (the runtime keeps one service per account). */
const analyticsServices = new WeakMap<GarminService, AnalyticsService>();
function analytics(service: GarminService): AnalyticsService {
  let a = analyticsServices.get(service);
  if (!a) analyticsServices.set(service, (a = new AnalyticsService(service)));
  return a;
}

/** `key default, ...` of a rule or flag object, for the one description of its input. */
const defaults = (values: object) =>
  Object.entries(values)
    .map(([k, v]) => `${k} ${Array.isArray(v) ? `[${v.join(', ')}]` : String(v)}`)
    .join(', ');

/** Workout input of create_workout. */
const WORKOUT_INPUT = {
  preset: workoutPresetSchema.optional(),
  definition: workoutDefinitionSchema.optional(),
  garmin_json: z.record(z.string(), z.unknown()).optional().describe('Raw Garmin workout JSON with workoutName, sportType and workoutSegments'),
};

/**
 * What a handler may return for an output schema: its fields without the open `[key]: unknown`
 * of loose objects (so service types need no index signature), and `null` in optional fields
 * and `undefined` in records, which `compact` drops before the result is sent.
 */
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

/** Shorthand for typed handlers: the compiler checks the service result against the output schema. */
function tool<S extends Record<string, z.ZodType>, O extends z.ZodType>(def: Omit<ToolDef, 'input' | 'output' | 'run'> & {
  input: S;
  output: O;
  run(service: GarminService, args: z.infer<z.ZodObject<S>>, ctx: SyncProgressOptions): Promise<Fits<z.output<O>>>;
}): ToolDef {
  return def as unknown as ToolDef;
}

/** The 21 coarse tools, plus opt-in destructive ones. */
export const TOOLS: ToolDef[] = [
  tool({
    name: 'garmin_sync',
    title: 'Sync Garmin data',
    description:
      'Download data from Garmin Connect into the local cache. ' +
      'Read tools already download missing data by themselves, so call this only when the user asks to sync/refresh or to pre-load a range, or when a tool returned meta.sync_hint (auto fetch turned off) and the user agreed; pass the hint\'s scope/from/to. ' +
      'Days already stored are skipped. Long ranges continue in the background: this waits at most 20 s and reports progress (also in garmin://sync-status).',
    input: {
      scope: z.enum(SYNC_SCOPES).default('all').describe('all | activities | health (daily summary, sleep, HRV, weight) | training (status, readiness, VO2max) | reference (profile, gear, devices, activity types, workouts, calendar months of from..to, also in the future)'),
      from: date.optional().describe('Start date; default: 7 days before `to`'),
      to: date.optional().describe('End date; default: today'),
      force: z.boolean().default(false).describe('Re-download days that are already stored'),
    },
    output: syncOutput,
    annotations: WRITE,
    run: (s, a, ctx) => s.sync(a.scope, a.from, a.to, a.force, ctx),
  }),
  tool({
    name: 'get_activities',
    title: 'List activities',
    description:
      'List workouts/activities (runs, rides, swims, strength...) as dense summaries: id, date, type, name, duration, distance, pace or speed, GAP, HR, power, NP, cadence, ' +
      'training load and Training Effect, temperature (if weather downloaded), event_type when tagged (e.g. race). ' +
      'Use for "what did I do last week", finding an activity id, or comparing sessions. For one activity in depth use get_activity; ' +
      'for weekly/monthly totals use get_period_summary.',
    input: {
      from: date.optional().describe('First day, inclusive; default no lower bound'),
      to: date.optional().describe('Last day, inclusive; default today'),
      type: z.string().optional().describe('Garmin type key, e.g. running, trail_running, cycling, lap_swimming, strength_training; partial match. All keys: resource garmin://activity-types'),
      event_type: z.string().optional().describe('Only activities tagged with this event type, e.g. race'),
      name: z.string().optional().describe('Part of the activity name, any case, e.g. a route'),
      min_duration_min: z.number().positive().optional().describe('At least this many minutes long'),
      max_duration_min: z.number().positive().optional().describe('At most this many minutes long'),
      pace: z.string().optional().describe('Average pace range per km, e.g. "4:45-5:30"'),
      limit: z.number().int().min(1).max(100).default(20).describe('Activities per page'),
      cursor: z.string().optional().describe('next_cursor from the previous page'),
      sort: z.enum(['desc', 'asc']).default('desc').describe('By start time: desc newest first, asc oldest first'),
    },
    output: activitiesOutput,
    annotations: READ,
    run: (s, a) => s.getActivities(a),
  }),
  tool({
    name: 'get_activity',
    title: 'Get one activity',
    description:
      'Details of one activity by id. detail="summary" (default) for the overview incl. description, RPE, feel, GAP, running dynamics (cadence, GCT, balance, VO, VR, stride), breathing rate, stamina, ' +
      'Training Effect label, run/walk/stand time, HR source (strap or watch) and workout_id (for get_workout); "splits" adds laps with the same dynamics, intensity (warmup, active, rest...) and, for a workout, the step as get_workout numbers it (wkt_step) and its compliance; ' +
      '"hr_zones" adds time in HR zones; ' +
      '"power_zones" adds time in power zones (power meter); "weather" adds temperature, wind and conditions during the activity; "exercise_sets" adds strength sets ' +
      '(exercise, reps, weight, rest); "stream_summary" aggregates the stream per `bucket` (pace, GAP, HR, power, dynamics, breathing, Performance Condition, elevation, stamina; ' +
      'compares halves or kilometres without raw samples); "full" adds all sections plus the raw stream (HR, pace, power...), 50 KB per page ' +
      '(narrow it with `metrics` and `downsample_s`) - only when the user needs raw samples.',
    input: {
      id: id.describe('Activity id from get_activities'),
      detail: z.enum(['summary', 'splits', 'hr_zones', 'power_zones', 'weather', 'exercise_sets', 'stream_summary', 'full']).default('summary'),
      bucket: z.enum(['km', '5min', 'halves', 'quarters']).default('km').describe('For detail="stream_summary"'),
      metrics: z.array(z.string()).optional().describe('For detail="full": stream keys to keep, e.g. ["directHeartRate","directPower"]'),
      downsample_s: z.number().int().positive().optional().describe('For detail="full": at most one sample per this many seconds'),
      cursor: z.string().optional().describe('For detail="full": next_cursor of the previous page (same metrics and downsample_s)'),
    },
    output: activityOutput,
    annotations: READ,
    run: (s, a) => s.getActivity(a.id, a.detail, a.cursor, { bucket: a.bucket, metrics: a.metrics, downsample_s: a.downsample_s }),
  }),
  tool({
    name: 'update_activity',
    title: 'Edit an activity',
    description:
      'Change an activity in Garmin Connect: name, type, event_type (e.g. race), description (notes), rpe, feel, ' +
      'or the gear used: add_gear puts shoes or a bike on it, remove_gear takes one off (swap: both in one call). ' +
      'Only call when the user asked for the change. Returns the activity after the edit.',
    input: {
      id: id.describe('Activity id from get_activities'),
      name: z.string().max(200).optional().describe('New activity name'),
      type: z.string().optional().describe('Garmin type key from garmin://activity-types, e.g. trail_running'),
      event_type: z.string().optional().describe('race, training, recreation, special_event, fitness, touring, transportation, geocaching or uncategorized'),
      description: z.string().max(2000).optional().describe('Notes; replaces the current ones'),
      rpe: z.number().min(0).max(10).optional().describe('Perceived effort 0-10'),
      feel: z.union([z.literal(0), z.literal(25), z.literal(50), z.literal(75), z.literal(100)]).optional().describe('0 very weak, 25 weak, 50 normal, 75 strong, 100 very strong'),
      add_gear: z.string().optional().describe('Gear name (or part of it) or uuid from get_gear'),
      remove_gear: z.string().optional().describe('Gear name or uuid from get_gear'),
    },
    output: updateActivityOutput,
    annotations: { ...WRITE, idempotentHint: true },
    run: (s, { id: activityId, ...patch }) => s.updateActivity(activityId, patch),
  }),
  tool({
    name: 'download_activity_file',
    title: 'Download activity file',
    description:
      'Download one activity from Garmin Connect and save it as a file on this machine (fit, gpx, tcx, kml or csv), returning its path and size. ' +
      'Use it when the user wants the file itself, e.g. to import into another app; to read an activity\'s numbers, laps or streams in the answer use get_activity instead. ' +
      'Prefer fit, the original recording, unless the destination needs another format. ' +
      'The file is named <id>.<format> and replaces an earlier download of the same activity and format; every call fetches it from Garmin again.',
    input: {
      id: id.describe('Activity id from get_activities'),
      format: z.enum(['fit', 'gpx', 'tcx', 'kml', 'csv']).default('fit').describe('fit: original device file; gpx, tcx, kml: track; csv: laps'),
      output_dir: z
        .string()
        .optional()
        .describe('Subdirectory of the download directory (GARMIN_FIT_DOWNLOAD_DIR or <data dir>/downloads), e.g. "races"; default the download directory itself. Paths outside it are rejected'),
    },
    output: downloadOutput,
    annotations: WRITE,
    run: (s, a) => s.downloadActivityFile(a.id, a.format, a.output_dir),
  }),
  tool({
    name: 'query_health',
    title: 'Query daily health metrics',
    description:
      'For "how did I sleep this week", "calories and intensity minutes this week", "steps yesterday" or any single health metric over days: ' +
      'a table per day or per ISO week plus summary with averages, totals, min/max and 7/28-day trend.' +
      ' steps also returns the daily distance in km, resting_hr the daily min/max HR, hrv the Garmin HRV status and baseline range, calories the kcal burned (total, active) and eaten (calories_consumed_kcal, absent without food log entries).' +
      ' Ask for several metrics in one call (e.g. calories and intensity_minutes together). ' +
      'Use get_sleep for sleep stages of particular nights. Example: {"metrics":["hrv","resting_hr","sleep"],"from":"2026-07-01","to":"2026-09-30","granularity":"week"}.',
    input: {
      metrics: z.array(z.enum(HEALTH_METRICS)).min(1),
      from: date.optional().describe('Default: 7 days before `to`'),
      to: date.optional().describe('Default: today'),
      granularity: z.enum(['day', 'week']).default('day').describe('"week" for ranges longer than ~3 weeks'),
    },
    output: healthOutput,
    annotations: READ,
    run: (s, a) => s.queryHealth(a.metrics, a.from, a.to, a.granularity),
  }),
  tool({
    name: 'get_sleep',
    title: 'Get sleep',
    description:
      'Sleep for one night with stages, score, SpO2, respiration, overnight HRV and a timeline (stage segments, awakenings, lowest HR, HRV and SpO2 with times), or for a range a per-night table with averages and trends. ' +
      'Use it for sleep stages and the detail of particular nights; for sleep hours next to other daily metrics, or months by week, use query_health. ' +
      'A night is named by the date of the morning it ended on: the night of 7 to 8 October is 2026-10-08. ' +
      'No arguments returns the last 7 nights; a range can span up to 3 years, one row per night. ' +
      'Nights not in the cache yet are downloaded from Garmin within the daily request limit, and a night without sleep data comes back as sleep null.',
    input: {
      date: date.optional().describe('One night, by the date of the morning; takes precedence over from/to'),
      from: date.optional().describe('Range start; default 6 days before `to`'),
      to: date.optional().describe('Range end; default today'),
    },
    output: sleepOutput,
    annotations: READ,
    run: (s, a) => s.getSleep(a),
  }),
  tool({
    name: 'get_training_status',
    title: 'Get training status',
    description:
      'Fitness and fatigue: VO2max (running/cycling) with trend, training readiness, remaining recovery time, Garmin training status (productive, maintaining, ...), ' +
      "Garmin acute/chronic load and load focus (aerobic low/high, anaerobic vs. targets), and `garmin_load_model`: CTL/ATL/TSB from Garmin's daily training load (EPOC); the own TSS model (power, pace, HR) is get_load. " +
      '`metrics` holds race predictions (5k to marathon), endurance and hill score, fitness age, personal records and heat/altitude acclimation ' +
      'as of the newest training sync on or before `to`. Set include_series for the daily load curve. ' +
      'Use it for "am I improving", VO2max, race predictions or Garmin\'s status; for a go/no-go today use get_readiness, for a week or month in numbers get_period_summary.',
    input: {
      from: date.optional().describe('Default: 28 days before `to`'),
      to: date.optional().describe('Day the status is read on; default today'),
      include_series: z.boolean().default(false).describe('true: add the daily Garmin load and CTL/ATL/TSB from `from` to `to`'),
    },
    output: trainingStatusOutput,
    annotations: READ,
    run: (s, a) => s.getTrainingStatus(a),
  }),
  tool({
    name: 'get_body_composition',
    title: 'Get body composition',
    description:
      'Weigh-ins (kg, body fat %, muscle mass, BMI) in a range, each with its time, plus change over the range and trend. ' +
      'Use it for weight and body composition questions; query_health and get_period_summary carry no weight. ' +
      'Days without a weigh-in are simply absent; an empty range returns no weigh-ins, not an error.',
    input: {
      from: date.optional().describe('First day, inclusive; default 89 days before `to`'),
      to: date.optional().describe('Last day, inclusive; default today'),
    },
    output: bodyCompositionOutput,
    annotations: READ,
    run: (s, a) => s.getBodyComposition(a.from, a.to),
  }),
  tool({
    name: 'get_period_summary',
    title: 'Summarise a week, month or range',
    description:
      'Training week or month at a glance: sessions and volume per sport, time in the Garmin HR zones 1-5 (for the 3-zone Z1/Z2/Z3 split against LT1/LTHR, e.g. time below LT1 or polarisation, use get_load), active vs rest days, longest and hardest session, ' +
      "`garmin_load_model` at the end (CTL/ATL/TSB from Garmin's daily training load (EPOC); the own TSS model is get_load), and only avg/min/max of sleep, HRV, resting HR, steps, stress and body battery plus average daily kcal. " +
      'Day-by-day values and other metrics (calorie totals, intensity minutes, floors, respiration, SpO2) come from query_health, weight from get_body_composition. Weeks run Monday-Sunday. ' +
      'Period "range" gives the same for any from..to up to 366 days, e.g. a training block: {"period":"range","from":"2026-08-04","to":"2026-09-28"}.',
    input: {
      period: z.enum(['week', 'month', 'range']).default('week'),
      anchor_date: date.optional().describe('week/month: any date inside the period; default today'),
      from: date.optional().describe('range only, required'),
      to: date.optional().describe('range only, required'),
    },
    output: periodSummaryOutput,
    annotations: READ,
    run: (s, a) => s.getPeriodSummary(a.period, { anchor_date: a.anchor_date, from: a.from, to: a.to }),
  }),
  tool({
    name: 'list_workouts',
    title: 'Workouts and calendar',
    description:
      'List the saved workout library (`workouts`), the scheduled workouts (`upcoming_schedule`) and the races or events the user added or subscribed to (`upcoming_events`). ' +
      'Use it for "my next race", "what is planned this week" or "which workouts do I have", and to find a workout id or schedule_id. ' +
      'For the steps of one workout use get_workout, to put a workout on the calendar or take it off schedule_workouts, for sessions already done get_activities. ' +
      '`sport` and `limit` narrow only the library; `from` and `to` set only the calendar window: today and the next 60 days by default, any range up to 3 years, past or future. ' +
      'Calendar months not in the cache yet are downloaded on the way. In events `primary` marks the goal race of an active training plan.',
    input: {
      limit: z.number().int().min(1).max(200).default(50).describe('Most saved workouts listed in `workouts`'),
      sport: z.string().optional().describe('Only library workouts of this sport, e.g. running, cycling, strength_training'),
      from: date.optional().describe('Calendar start; default today (or 60 days before `to` when `to` is in the past)'),
      to: date.optional().describe('Calendar end; default 60 days after `from`'),
    },
    output: listWorkoutsOutput,
    annotations: READ,
    run: (s, a) => s.listWorkouts(a),
  }),
  tool({
    name: 'get_workout',
    title: 'Get a planned workout',
    description:
      'Steps of one saved workout from the Garmin library in readable form: name, sport, description and one line per step (warm-up, repeats, ' +
      'duration or distance, target in pace/HR/power/cadence), plus estimated duration and distance. ' +
      'Use it to show what a planned session contains, or before changing it with create_workout; to find workouts or what is on the calendar use list_workouts. ' +
      'An id that no longer exists in Garmin Connect returns a NOT_FOUND error.',
    input: { id: id.describe('Workout id from list_workouts or workout_id from get_activity') },
    output: workoutOutput,
    annotations: READ,
    run: (s, a) => s.getWorkout(a.id),
  }),
  tool({
    name: 'create_workout',
    title: 'Create a workout',
    description:
      'Save a new structured workout to Garmin Connect (then use schedule_workouts to put it on the calendar so it syncs to the watch). ' +
      'Pass exactly one of: `preset` for a standard session from a few parameters (run_intervals, walk_run, easy_z2, strength_circuit); ' +
      '`definition` for anything else (typed steps with duration and target, nestable repeats); `garmin_json` only to copy an existing Garmin workout JSON. ' +
      'Errors name the bad field, e.g. steps[2].steps[0].target. ' +
      'Call with dry_run: true first, show the steps to the user and save only after they agree. ' +
      'dry_run saves nothing and does not contact Garmin: it returns the readable steps and the estimated duration.',
    input: {
      ...WORKOUT_INPUT,
      dry_run: z.boolean().default(false).describe('true: preview only, nothing is saved'),
    },
    output: createWorkoutOutput,
    annotations: WRITE,
    // Overwriting loses the old steps for good, so it sits behind the same switch as delete_workout.
    destructiveOption: {
      input: { workout_id: id.optional().describe('Saved workout to overwrite; omit to create a new one') },
      description:
        'With `workout_id` it overwrites that saved workout instead (same id, so its calendar entries stay; the old steps are lost): ' +
        'read the current steps with get_workout, show the full new version with dry_run: true and overwrite only after the user agreed.',
      disabledError: 'Overwriting a saved workout (workout_id) is turned off; it needs GARMIN_ENABLE_DESTRUCTIVE=true. Omit workout_id to save it as a new workout.',
    },
    run: (s, a) => {
      const { workout_id, dry_run, ...input } = a as typeof a & { workout_id?: number };
      return dry_run ? s.previewWorkout(input) : s.createWorkout(input, workout_id);
    },
  }),
  tool({
    name: 'schedule_workouts',
    title: 'Schedule workouts',
    description:
      'Put saved workouts on the Garmin calendar (they then sync to the watch), or take them off it. ' +
      '`unschedule` takes schedule_id values (from list_workouts upcoming_schedule or an earlier schedule_workouts result); ' +
      'the workout stays in the library, only the calendar entry goes. Unschedule only what the user asked to remove. ' +
      'Unscheduling runs first, so moving a workout is one call. Returns a result per item. ' +
      'Examples: {"items":[{"date":"2026-10-10","workout_id":123}]}, {"unschedule":[456]}.',
    input: {
      items: z.array(z.object({ date, workout_id: id })).max(60).default([]),
      unschedule: z.array(id).max(60).default([]).describe('schedule_id values of calendar entries to remove'),
    },
    output: scheduleOutput,
    annotations: { ...WRITE, destructiveHint: true },
    run: (s, a) => s.scheduleWorkouts(a.items, a.unschedule),
  }),
  tool({
    name: 'get_gear',
    title: 'Get gear',
    description:
      'List the shoes, bikes and other gear on the Garmin account, active first: uuid, name, type, status (active or retired), total distance and activity count, ' +
      'the distance limit set in Garmin, in use since, retired date and notes. Use it for "how many km on my shoes" or "which shoes to replace", ' +
      'not for watches and sensors (get_devices); name or uuid is what update_activity takes as add_gear/remove_gear. Returns every item, no paging; none recorded gives an empty list.',
    input: {
      include_activities: z.boolean().default(false).describe('true: add the last 10 activities per item (date, name, distance) to see what the gear was used for'),
    },
    output: gearOutput,
    annotations: READ,
    run: (s, a) => s.getGear(a.include_activities),
  }),
  tool({
    name: 'get_devices',
    title: 'Get devices',
    description:
      'Garmin devices on the account with model, firmware, last sync time and settings (units, tones, alerts, pulse ox during sleep, alarms). ' +
      'Use it for "is my watch up to date" or "when did it last sync"; shoes and bikes are get_gear. Read from the cache, refreshed from Garmin at most hourly; no devices gives an empty list.',
    input: {},
    output: devicesOutput,
    annotations: READ,
    run: (s) => s.getDevices(),
  }),
  // ---------------------------------------------------------------- analytics (garmin-mcp-analytics)
  tool({
    name: 'get_load',
    title: 'Get training load (own model)',
    description:
      'Training load from the server\'s own transparent model: TSS per activity from power, else pace, else heart rate, else session RPE, with the thresholds in effect on each date. ' +
      'Use it for fitness, fatigue and form trends, ramp rate, weekly volume and intensity distribution (time below LT1, % in Z1, polarisation). ' +
      "Not Garmin's EPOC load: Garmin's status and CTL/ATL/TSB from Garmin's load are get_training_status, a go/no-go for today get_readiness. " +
      'Returns CTL/ATL/TSB, ACWR, monotony and strain on `to` (`latest`), warning `flags`, ISO weeks per sport (sessions, hours, km, TSS, hrTSS, Garmin load, hours in Z1-2/Z3/Z4-5), ' +
      'the 3-zone split against LT1/LTHR of the last 28 days and the thresholds used; the include_* options add detail.',
    input: {
      from: date.optional().describe('Default: 27 days before `to`'),
      to: date.optional().describe('Default: today'),
      source: z.enum(['auto', 'hrtss', 'garmin_load']).default('auto').describe('auto: power, pace, HR, then RPE per activity; hrtss: HR only; garmin_load: Garmin activity training load'),
      include_series: z.boolean().default(false).describe('Add the daily TSS, CTL/ATL/TSB, ACWR, monotony and strain'),
      include_activities: z
        .boolean()
        .default(false)
        .describe(
          'Add per activity TSS, IF, load_source, EF, cadence, running dynamics and, for sessions of 60+ min below LTHR with downloaded laps, ' +
            'aerobic decoupling (% EF drop from first to second half)',
        ),
      include_efficiency: z.boolean().default(false).describe('Add the monthly EF trend with decoupling as in include_activities'),
      include_dynamics: z.boolean().default(false).describe('Add monthly cadence, GCT, VO, VR and stride of road runs, also at a reference pace (`_at_ref`)'),
      include_by_sport: z.boolean().default(false).describe('Add CTL/ATL/TSB/ACWR per sport group (`by_sport`, plus run_ctl… columns in the series); the total stays the default'),
      flags: z.looseObject({}).optional().describe(`Own flag thresholds, any of (default): ${defaults(DEFAULT_LOAD_FLAGS)}`),
    },
    output: loadOutput,
    annotations: READ,
    run: (s, a, ctx) => analytics(s).getLoad(a, ctx),
  }),
  tool({
    name: 'compare_activities',
    title: 'Compare activities',
    description:
      'Sessions side by side: pace, GAP, HR, power, EF, decoupling, IF, TSS, % Z4-5, cadence and running dynamics, temperature, dew point. `ids` compares those activities; ' +
      '`similar_to` adds stored sessions like it (same type, duration and pace/GAP within tolerance; optionally same_route, easy_only), newest first with `match`. ' +
      'Pass exactly one of `ids` or `similar_to`, otherwise it returns an error; the similar_to filters combine. For one activity in depth use get_activity. ' +
      'E.g. today vs usual easy runs, progress on a route: {"similar_to":23011268235,"same_route":true}.',
    input: {
      ids: z.array(id).min(2).max(10).optional().describe('2-10 activity ids to put side by side'),
      similar_to: id.optional().describe('Activity id to find stored sessions like'),
      limit: z.number().int().min(1).max(20).default(5).describe('similar_to: most similar sessions returned'),
      from: date.optional().describe('similar_to: earliest date searched (default: 365 days before it)'),
      duration_pct: z.number().positive().max(100).default(20).describe('similar_to: duration within ± this % of it'),
      pace_s_per_km: z.number().positive().default(20).describe('similar_to: pace or GAP within ± this many s/km'),
      same_route: z.boolean().default(false).describe('similar_to: same start, end and distance'),
      easy_only: z.boolean().default(false).describe('similar_to: only sessions under 5 % in Z4-5'),
    },
    output: compareOutput,
    annotations: READ,
    run: (s, a, ctx) => analytics(s).compareActivities(a, ctx),
  }),
  tool({
    name: 'get_readiness',
    title: 'Morning readiness',
    description:
      'Morning GO/MODIFY/REST decision from HRV, resting HR, sleep hours and load against your own baselines. ' +
      'Returns each signal with its value, reference and rating (ok, yellow, red; unknown when data is missing), rules_used and a recommendation that starts with the signals that decided. ' +
      "Garmin's own scores (Training Readiness, Body Battery, stress; sleep score in the sleep value) are shown as info, not counted. " +
      'REST needs a red pair, a single red or 2 yellow give MODIFY; `rules` changes the thresholds and the decision rule. ' +
      'Use for "how am I today" or "can I do a hard session".',
    input: {
      date: date.optional().describe('Morning to judge; default today'),
      rules: z.looseObject({}).optional().describe(`Own thresholds, any of (default): ${defaults(DEFAULT_READINESS_RULES)}`),
    },
    output: readinessOutput,
    annotations: READ,
    run: (s, a, ctx) => analytics(s).getReadiness(a, ctx),
  }),
  tool({
    name: 'get_thresholds',
    title: 'Get training thresholds',
    description:
      'Thresholds the analytics use on `date` (default today): per param its value, the date it applies since and its source (garmin-auto from the Garmin profile, test, manual, import), ' +
      'by_sport (run, bike, swim: LTHR and LT1 with a note when a fallback, default or approximation), HRmax and the 28-day resting HR. ' +
      'zones has the HR and power zone floors per sport from the Garmin profile (method, HRmax/rest/LTHR or FTP used, fetched date; current, not historical). ' +
      'history adds every recorded row. Use it to see what get_load and get_readiness compute with; record a new test result with set_threshold. ' +
      'Example: {"param":"lthr_run","history":true}.',
    input: {
      date: date.optional().describe('Day the thresholds are in effect on; default today'),
      param: z.enum(THRESHOLD_PARAMS).optional().describe('Only this threshold; default all'),
      history: z.boolean().default(false).describe('true: add all recorded rows (of `param`, if given) with date, value, source and note'),
    },
    output: thresholdsOutput,
    annotations: READ,
    run: (s, a, ctx) => analytics(s).getThresholds(a, ctx),
  }),
  tool({
    name: 'set_threshold',
    title: 'Record a threshold',
    description:
      'Record a field test result (LTHR, LT1, HRmax, FTP…) effective from a date; ask the user before saving. ' +
      'Stored in the local database only, never sent to Garmin; a row with the same date, param and source stays as it is (added false). ' +
      'A backdated row recomputes earlier activities from its date on. ' +
      'Returns the row and the value in effect today. Example: {"date":"2026-10-11","param":"lthr_run","value":171,"note":"30 min TT"}.',
    input: {
      date: date.describe('Day of the test, not in the future'),
      param: z.enum(THRESHOLD_PARAMS).describe('Heart rates in bpm, ftp_w/run_ftp_w in W, css_s_per_100m in s per 100 m, run_threshold_pace_s_per_km in s per km'),
      value: z.number().positive().describe('In the unit of `param`'),
      source: z.enum(SET_THRESHOLD_SOURCES).default('test').describe('test: measured in a field or lab test; manual: a value the user sets without a test'),
      note: z.string().max(200).optional().describe('e.g. the test protocol'),
    },
    output: setThresholdOutput,
    annotations: LOCAL_WRITE,
    run: (s, a) => analytics(s).setThreshold(a),
  }),
  // ---------------------------------------------------------------- destructive, opt-in
  tool({
    name: 'delete_activity',
    title: 'Delete an activity',
    description: 'PERMANENTLY deletes the activity from Garmin Connect; it cannot be restored. Only call after the user explicitly confirmed deleting this activity id.',
    input: { id },
    output: deleteActivityOutput,
    annotations: DELETE,
    destructive: true,
    run: (s, a) => s.deleteActivity(a.id),
  }),
  tool({
    name: 'delete_workout',
    title: 'Delete a workout',
    description: 'PERMANENTLY deletes a saved workout and its calendar entries from Garmin Connect. Only call after explicit user confirmation.',
    input: { id },
    output: deleteWorkoutOutput,
    annotations: DELETE,
    destructive: true,
    run: (s, a) => s.deleteWorkout(a.id),
  }),
  tool({
    name: 'delete_weigh_in',
    title: 'Delete a weigh-in',
    description: 'PERMANENTLY deletes one weigh-in (sample_pk from get_body_composition raw data) on the given date. Only call after explicit user confirmation.',
    input: { sample_pk: id, date },
    output: deleteWeighInOutput,
    annotations: DELETE,
    destructive: true,
    run: (s, a) => s.deleteWeighIn(a.sample_pk, a.date),
  }),
];

/** Apply GARMIN_ENABLED_TOOLS / GARMIN_DISABLED_TOOLS / GARMIN_ENABLE_DESTRUCTIVE. */
export function selectTools(opts: { enabled?: string[]; disabled?: string[]; destructive: boolean }): ToolDef[] {
  return TOOLS.filter((t) => {
    if (t.destructive && !opts.destructive) return false;
    if (opts.enabled && !opts.enabled.includes(t.name)) return false;
    if (opts.disabled?.includes(t.name)) return false;
    return true;
  }).map((t) => {
    const option = t.destructiveOption;
    if (!option) return t;
    if (!opts.destructive) return { ...t, rejectedFields: { names: Object.keys(option.input), error: option.disabledError } };
    return {
      ...t,
      description: `${t.description} ${option.description}`,
      input: { ...t.input, ...option.input },
      annotations: { ...t.annotations, destructiveHint: true },
    };
  });
}

/** What the SDK validates against: an object of the input fields, strict when some fields must fail loudly. */
export function inputSchema(def: ToolDef): z.ZodObject {
  const rejected = def.rejectedFields;
  if (!rejected) return z.object(def.input);
  return z.strictObject(def.input, {
    error: (issue) => (issue.code === 'unrecognized_keys' && issue.keys.some((k) => rejected.names.includes(k)) ? rejected.error : undefined),
  });
}
