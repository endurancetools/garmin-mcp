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
      'Days already stored are skipped. Long ranges run in the background in 7-day chunks with pauses and a daily request cap to stay gentle with Garmin; ' +
      'this waits at most 20 s and reports progress (also in garmin://sync-status). Example: {"scope":"health","from":"2026-09-01","to":"2026-09-30"}.',
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
      'training load and Training Effect, temperature (if weather downloaded). ' +
      'Use for "what did I do last week", finding an activity id, or comparing sessions. For one activity in depth use get_activity; ' +
      'for weekly/monthly totals use get_period_summary. Example: {"from":"2026-10-01","type":"running","limit":10}.',
    input: {
      from: date.optional(),
      to: date.optional(),
      type: z.string().optional().describe('Garmin type key, e.g. running, trail_running, cycling, lap_swimming, strength_training; partial match. All keys: resource garmin://activity-types'),
      name: z.string().optional().describe('Part of the activity name, any case, e.g. a route'),
      min_duration_min: z.number().positive().optional(),
      max_duration_min: z.number().positive().optional(),
      pace: z.string().optional().describe('Average pace range per km, e.g. "4:45-5:30"'),
      limit: z.number().int().min(1).max(100).default(20),
      cursor: z.string().optional().describe('next_cursor from the previous page'),
      sort: z.enum(['desc', 'asc']).default('desc'),
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
      'compares halves or kilometres without raw samples); "full" adds all sections plus the raw stream (HR, pace, power...) paginated with next_cursor, 50 KB per page, ' +
      'optionally only `metrics` and one sample per `downsample_s` - only when the user needs raw samples.',
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
      'Change an activity in Garmin Connect: name, type (Garmin type key such as "trail_running"; valid keys in resource garmin://activity-types), description (notes), rpe (0-10 perceived effort) ' +
      'or feel (0 very weak, 25 weak, 50 normal, 75 strong, 100 very strong). Only call when the user asked for the change. Returns the activity after the edit.',
    input: {
      id,
      name: z.string().max(200).optional(),
      type: z.string().optional().describe('Garmin type key from garmin://activity-types, e.g. trail_running'),
      description: z.string().max(2000).optional(),
      rpe: z.number().min(0).max(10).optional(),
      feel: z.union([z.literal(0), z.literal(25), z.literal(50), z.literal(75), z.literal(100)]).optional(),
    },
    output: updateActivityOutput,
    annotations: { ...WRITE, idempotentHint: true },
    run: (s, { id: activityId, ...patch }) => s.updateActivity(activityId, patch),
  }),
  tool({
    name: 'download_activity_file',
    title: 'Download activity file',
    description:
      'Save an activity as a file on this machine and return its path: fit (original device file), gpx, tcx, kml or csv (laps). ' +
      'Use when the user wants the file itself, e.g. to import elsewhere.',
    input: {
      id,
      format: z.enum(['fit', 'gpx', 'tcx', 'kml', 'csv']).default('fit'),
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
      'a table per day or per ISO week plus summary with averages, totals, min/max and 7/28-day trend. Metrics: ' +
      steps_desc() +
      ' steps also returns the daily distance in km, resting_hr the daily min/max HR, hrv the Garmin HRV status and baseline range, floors the floors climbed, calories the kcal burned (total, active) and eaten (calories_consumed_kcal, absent without food log entries).' +
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
      'Sleep for one night ({"date":"2026-10-08"}, the morning date) with stages, score, SpO2, respiration and overnight HRV; ' +
      'or for a range ({"from","to"}) a per-night table with averages and trends.',
    input: { date: date.optional(), from: date.optional(), to: date.optional() },
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
      'as of the newest training sync on or before `to`. Set include_series for the daily load curve.',
    input: { from: date.optional().describe('Default: 28 days before `to`'), to: date.optional(), include_series: z.boolean().default(false) },
    output: trainingStatusOutput,
    annotations: READ,
    run: (s, a) => s.getTrainingStatus(a),
  }),
  tool({
    name: 'get_body_composition',
    title: 'Get body composition',
    description: 'Weigh-ins (kg, body fat %, muscle mass, BMI) in a range with change and trend. Default range: last 90 days.',
    input: { from: date.optional(), to: date.optional() },
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
      'Period "range" gives the same for any from..to up to 366 days, e.g. a training block: {"period":"range","from":"2026-08-04","to":"2026-09-28"}. ' +
      '`complete` is true when the period is over and all its data is in the cache; `training` is left out while its activities are not. ' +
      'Example: {"period":"week","anchor_date":"2026-10-08"}.',
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
      'For "my next race", "what is planned this week" or "which workouts do I have": the saved workout library (`workouts`), ' +
      'scheduled workouts (`upcoming_schedule`) and races or events the user added or subscribed to (`upcoming_events`: date, title, distance, start time, location; ' +
      '`race`/`primary` present only when true, `primary` marks the goal race of an active training plan). The calendar covers `from` to `to` ' +
      '(default: today and the next 60 days); any range works, past or future, and months not in the cache yet are downloaded on the way. ' +
      'Example: {"from":"2027-03-01","to":"2027-05-31"} for races next spring.',
    input: {
      limit: z.number().int().min(1).max(200).default(50),
      sport: z.string().optional().describe('e.g. running, cycling, strength_training'),
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
    description: 'Steps of a saved workout in readable form (warm-up, repeats, targets in pace/HR/power).',
    input: { id },
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
      'dry_run saves nothing and does not contact Garmin: it returns the readable steps and the estimated duration ' +
      '(time steps, plus distance steps at the middle of their pace range; steps with neither are listed in estimate_note, ' +
      'and for garmin_json that carries its own estimate the note says it was taken from there).',
    input: {
      ...WORKOUT_INPUT,
      dry_run: z.boolean().default(false).describe('true: only show the steps and estimated duration, save nothing'),
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
    description: 'Shoes, bikes and other gear with total distance, usage since, notes and status. include_activities adds the last 10 activities per item.',
    input: { include_activities: z.boolean().default(false) },
    output: gearOutput,
    annotations: READ,
    run: (s, a) => s.getGear(a.include_activities),
  }),
  tool({
    name: 'get_devices',
    title: 'Get devices',
    description: 'Garmin devices on the account with model, firmware, last sync time and settings (time/date format, units, tones, move and heart-rate alerts, pulse ox during sleep, number of alarms). Comes from the reference sync.',
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
      "Own transparent load model (TSS per activity from power, else pace, else heart rate, else session RPE, with date-dependent thresholds), not Garmin's EPOC load; for Garmin's status and CTL/ATL/TSB from Garmin's load (`garmin_load_model`) use get_training_status. " +
      'Returns CTL/ATL/TSB, ACWR, monotony and strain on `to` (`latest`), warning `flags`, ISO weeks per sport (sessions, hours, km, TSS, hrTSS, Garmin load, hours in Z1-2/Z3/Z4-5), ' +
      'the 3-zone intensity split against LT1/LTHR of the last 28 days (Z1/Z2/Z3 minutes and %; answers time below LT1, % in Z1, polarisation) and the thresholds used. ' +
      'include_series adds the daily curve, include_activities TSS/IF/load_source/EF (runs with power also ef_power), cadence and running dynamics per activity, include_efficiency the monthly EF trend, ' +
      'both with aerobic decoupling (% EF drop from first to second half, `decoupling_basis` pa_hr or pw_hr; runs with power also decoupling_pw_pct) of sessions of 60+ min below LTHR with downloaded laps, ' +
      'include_dynamics monthly cadence, GCT, VO, VR, stride of road runs, also at a reference pace (`_at_ref`), ' +
      'include_by_sport CTL/ATL/TSB/ACWR per sport group (`by_sport`, plus run_ctl… columns in the series) next to the total, which stays the default. ' +
      'Example: {"from":"2026-09-01","to":"2026-09-30","include_activities":true}.',
    input: {
      from: date.optional().describe('Default: 27 days before `to`'),
      to: date.optional().describe('Default: today'),
      source: z.enum(['auto', 'hrtss', 'garmin_load']).default('auto').describe('auto: power, pace, HR, then RPE per activity; hrtss: HR only; garmin_load: Garmin activity training load'),
      include_series: z.boolean().default(false),
      include_activities: z.boolean().default(false),
      include_efficiency: z.boolean().default(false),
      include_dynamics: z.boolean().default(false),
      include_by_sport: z.boolean().default(false),
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
      '`similar_to` adds stored sessions like it (same type, duration and pace/GAP within tolerance; same_route: start, end and distance; easy_only: <5 % Z4-5), newest first with `match`. ' +
      'E.g. today vs usual easy runs, progress on a route: {"similar_to":24897101232,"same_route":true}.',
    input: {
      ids: z.array(id).min(2).max(10).optional(),
      similar_to: id.optional(),
      limit: z.number().int().min(1).max(20).default(5).describe('similar_to: most similar sessions returned'),
      from: date.optional().describe('similar_to: earliest date searched (default: 365 days before it)'),
      duration_pct: z.number().positive().max(100).default(20),
      pace_s_per_km: z.number().positive().default(20),
      same_route: z.boolean().default(false),
      easy_only: z.boolean().default(false),
    },
    output: compareOutput,
    annotations: READ,
    run: (s, a, ctx) => analytics(s).compareActivities(a, ctx),
  }),
  tool({
    name: 'get_readiness',
    title: 'Morning readiness',
    description:
      'Morning GO/MODIFY/REST decision from HRV, resting HR, sleep hours and load; pass `rules` to use your own thresholds. ' +
      'Each signal has its value, reference, rating (ok, yellow, red; unknown when data is missing) and a readable detail; plus rules_used and a recommendation. ' +
      "Garmin's own scores (Training Readiness, Body Battery, stress; sleep score in the sleep value) are shown as info, not counted. " +
      'REST needs a red pair (hrv with rhr or sleep, load with hrv, rhr or sleep), a single red or 2 yellow give MODIFY; decision_rule "count" instead gives REST at decision_red_min reds. ' +
      'Use for "how am I today" or "can I do a hard session". Example: {"date":"2026-10-12"}.',
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
      'history adds every recorded row. Example: {"param":"lthr_run","history":true}.',
    input: {
      date: date.optional(),
      param: z.enum(THRESHOLD_PARAMS).optional(),
      history: z.boolean().default(false),
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
      'A backdated row recomputes earlier activities from its date on (the first garmin-auto row is the Garmin profile as of its first download). ' +
      'Returns the row and the value in effect today. Example: {"date":"2026-10-11","param":"lthr_run","value":171,"note":"30 min TT"}.',
    input: {
      date: date.describe('Day of the test, not in the future'),
      param: z.enum(THRESHOLD_PARAMS).describe('Heart rates in bpm, ftp_w/run_ftp_w in W, css_s_per_100m in s per 100 m, run_threshold_pace_s_per_km in s per km'),
      value: z.number().positive(),
      source: z.enum(SET_THRESHOLD_SOURCES).default('test'),
      note: z.string().max(200).optional(),
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

function steps_desc(): string {
  return `${HEALTH_METRICS.join(', ')}.`;
}

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
