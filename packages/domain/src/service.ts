import { ACTIVITY_PRIVACY, type ActivityPrivacy, type ActivityType, type DownloadFormat, type EventType, type GarminClient } from 'garmin-mcp-client';
import {
  addDays,
  assertIsoDate,
  eachDay,
  endOfMonth,
  dateIn,
  GarminError,
  InputError,
  isIsoDate,
  silentLogger,
  startOfMonth,
  startOfWeek,
  type IsoDate,
  type Logger,
} from 'garmin-mcp-config';
import { errInfo, FATAL_CODES, isFresh, SCOPE_DAILY, signInPause, TTL, type DailyKind, type DetailKind, type EnsureResult, type ReferenceKind, type Store, type SyncJobProgress, type SyncJobReport, type SyncJobRunner, type SyncScope, type Syncer, type TrainingPlanCache, type CourseCache, type BadgeCache } from 'garmin-mcp-store';
import fs from 'node:fs';
import path from 'node:path';
import { activityBrief, activityListItem, eventTypeKey, periodActivitySummary } from './activities.js';
import { activityWeather, MIN_TYPED_SPLIT_S, splitSummaries, strengthSets, typedSplits, zoneTimes, type ActivityWeather, type SplitSummary, type StrengthSets, type TypedSplit, type ZoneTime } from './activity-extras.js';
import { gapPace, GPS_STREAM_METRICS, hrSource, motionTime, redactActivityRaw, respiration, runningDynamics, stamina, trainingEffectText, type RunningDynamics } from './activity-metrics.js';
import { badgeSummary, challengeList, type BadgeChallenge, type EarnedBadge } from './badges.js';
import { bodyComposition } from './body.js';
import { calendarEvent } from './calendar.js';
import { CLIMB_RULES } from './climbs.js';
import { courseBriefFromDetail, courseDetail, courseList, eventCourseRef, type CourseBrief } from './courses.js';
import { deviceSettings, deviceSolar } from './devices.js';
import { energyBalance } from './energy.js';
import { checkExerciseSets, exerciseSetsBody, exerciseSetsInput, rawExerciseSets, type ExerciseSetInput } from './exercise-sets.js';
import { readFitFile, weightScaleFile, type FitGearChange } from './fit.js';
import { compact, hms, isFootSport, iso, km, round, speedOrPace } from './format.js';
import { healthTable, tablesFor, type HealthGranularity, type HealthMetric } from './health.js';
import { hourlyTable, intradayKinds, isHourlyMetric } from './intraday.js';
import { activityListRow, activityTypeName, checkEditMode, checkManualActivity } from './manual-activity.js';
import { checkFatPct, checkPulse, checkWaterMl, checkWeightKg, measuredAt, parseBloodPressure } from './measurements.js';
import { decodeCursor, encodeCursor, pageBySize } from './paging.js';
import { bestEfforts, durationLabel, type BestEffort } from './power-curve.js';
import { sleepNight, sleepRange, sleepTimeline } from './sleep.js';
import { filterStream, streamSummary, type StreamBucket, type StreamSummary } from './stream.js';
import { trend } from './stats.js';
import { trainingOverview } from './training.js';
import { planName, planWorkoutLine, trainingPlanBlock } from './training-plan.js';
import { compileWorkout, describeWorkout, estimateWorkoutDuration, isGarminWorkoutJson, presetDefinition, SPORT_KEYS, workoutStepsByIndex, type WorkoutDefinition, type WorkoutPreset } from './workouts/index.js';
import { unzip } from './zip.js';
import { z } from 'zod';

export { InputError } from 'garmin-mcp-config';

/** Every response carries where the data came from; `local` is computed here without Garmin or the cache. */
export interface ResponseMeta {
  source: 'cache' | 'live' | 'partial' | 'local';
  /** When the oldest record in the answer was downloaded from Garmin; newer records may be fresher. */
  fetched_at?: string;
  coverage?: { from: IsoDate; to: IsoDate; complete: boolean; missing_days?: Record<string, number> };
  note?: string;
  /** Present when the answer lacks data that was never synced: the sync that would fill it. */
  sync_hint?: { scope: SyncScope; from?: IsoDate; to?: IsoDate };
}

/**
 * Output schema of `meta` (MCP `outputSchema`). Kept minimal - `coverage` and `sync_hint` as any
 * JSON - because every tool carries a copy; `ResponseMeta` above is the typed shape.
 */
export const responseMetaSchema = z
  .looseObject({
    source: z.enum(['cache', 'live', 'partial', 'local']),
    fetched_at: z.string().optional(),
    coverage: z.unknown().optional(),
    note: z.string().optional(),
    sync_hint: z.unknown().optional(),
  })
  .meta({ id: 'ResponseMeta' });

export interface Envelope<T> {
  data: T;
  meta: ResponseMeta;
}

/** Progress of the sync job a call starts (MCP `notifications/progress`); not called when it joins a running job. */
export interface SyncProgressOptions {
  onProgress?: (p: SyncJobProgress) => void;
  /**
   * A sync that stops because nobody is signed in (no tokens, expired or rejected ones) throws
   * that error instead of reporting a pause, so the caller can start a sign-in.
   */
  throwWhenSignedOut?: boolean;
}

/** The auth error behind a sync report paused for a missing sign-in; other reports pass. */
function throwIfSignedOut(report: SyncJobReport | undefined): void {
  const cause = report?.status === 'paused' ? signInPause(report.reason) : undefined;
  if (cause) throw new GarminError(cause.code, cause.message, { hint: 'Sign in again with `garmin login`.' });
}

export interface GarminServiceOptions {
  client: GarminClient;
  store: Store;
  syncer: Syncer;
  /** Runs explicit sync jobs (garmin_sync, `garmin sync`). */
  jobs: SyncJobRunner;
  timeZone: string;
  /** Max time a tool waits for Garmin before answering with partial data (20 s). */
  budgetMs?: number;
  /** Let `withAutoSync` download data a read reports missing (GARMIN_AUTO_FETCH, on by default). */
  autoSync?: boolean;
  /** Strip personal data and GPS from `get_activity`'s raw output (GARMIN_REDACT, on by default). */
  redact?: boolean;
  downloadDir: string;
  logger?: Logger;
  now?: () => number;
}

const MAX_RANGE_DAYS = 366 * 3;
/** Longest `query_health` range per hour, in days including both ends. */
const MAX_HOURLY_DAYS = 3;
/** Longest `get_period_summary` range, in days including both ends. */
const MAX_PERIOD_DAYS = 366;
/** Days before today Garmin's lactate threshold history is downloaded for (the range a recording confirmed). */
export const THRESHOLD_HISTORY_DAYS = 365;

/** Workout input of `create_workout`: exactly one of the three forms. */
export interface WorkoutInput {
  definition?: WorkoutDefinition;
  preset?: WorkoutPreset;
  garmin_json?: Record<string, unknown>;
}

/** Filters of `get_activities`; `pace` is a range per km, "4:45-5:30". */
export interface ActivitiesQuery {
  from?: string;
  to?: string;
  type?: string;
  /** Garmin event type key, e.g. race. */
  event_type?: string;
  name?: string;
  min_duration_min?: number;
  max_duration_min?: number;
  pace?: string;
  limit?: number;
  cursor?: string;
  sort?: 'asc' | 'desc';
}

/**
 * What `update_activity` can change; gear is named by uuid or by (part of) its name. Without an
 * id it adds a manual activity from `type`, `start`, `duration_min`, `distance_km`, `name`,
 * `description`, `rpe`, `feel` and `privacy`.
 */
/** One file of `garmin upload`: what Garmin made of it and whether the new activity is in the cache. */
export interface UploadReport {
  file: string;
  status: 'created' | 'duplicate' | 'processing' | 'failed';
  activity_id?: number;
  /** A created activity was downloaded into the local database. */
  stored?: boolean;
  name?: string;
  type?: string;
  /** Local start, "2026-11-16 18:30". */
  start_local?: string;
  message?: string;
}

export interface ActivityEdit {
  name?: string;
  type?: string;
  event_type?: string;
  description?: string;
  rpe?: number;
  feel?: 0 | 25 | 50 | 75 | 100;
  add_gear?: string;
  remove_gear?: string;
  privacy?: ActivityPrivacy;
  /** Replaces every strength set of the activity. */
  exercise_sets?: ExerciseSetInput[];
  /** With `exercise_sets`: keep the times the watch recorded, change exercise, reps and weight only. */
  keep_timing?: boolean;
  /** New activity only: local start, "2026-11-16T18:30". */
  start?: string;
  /** New activity only. */
  duration_min?: number;
  /** New activity only. */
  distance_km?: number;
}

/** `update_activity` privacy of Garmin's access control rule: "subscribers" is "followers"; other rules keep Garmin's key. */
function privacyKey(rule: unknown): string | undefined {
  const key = rule && typeof rule === 'object' ? (rule as { typeKey?: unknown }).typeKey : undefined;
  if (typeof key !== 'string') return undefined;
  return Object.entries(ACTIVITY_PRIVACY).find(([, r]) => r.typeKey === key)?.[0] ?? key;
}

/** Keys compared without case, spaces or separators: "Special Event", special_event and specialEvent are one key. */
const looseKey = (key: string) => key.toLowerCase().replaceAll(/[^a-z0-9]/g, '');

const PACE = /^\s*(\d{1,2}):([0-5]\d)\s*$/;

/** "4:45-5:30" (either order) → seconds per km of its fast and slow end. */
export function parsePaceRange(text: string): { fastest_s: number; slowest_s: number } {
  const parts = text.split('-');
  const secs = parts.map((p) => {
    const m = PACE.exec(p);
    return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
  });
  const [a, b] = secs;
  if (parts.length !== 2 || a === undefined || b === undefined || a === 0 || b === 0) {
    throw new InputError(`Invalid pace range "${text}"`, 'Use minutes:seconds per km, fast-slow, e.g. "4:45-5:30".');
  }
  return { fastest_s: Math.min(a, b), slowest_s: Math.max(a, b) };
}

/** Optional sections `get_activity` adds to the overview, by detail level. */
interface ActivitySections {
  splits?: ({
    lap?: number | null;
    intensity?: string;
    wkt_step_index?: number;
    wkt_step?: string;
    compliance_pct?: number;
    distance_km?: number;
    duration?: string;
    moving_time?: string;
    avg_pace?: string;
    avg_gap_pace?: string;
    avg_speed_kmh?: number;
    avg_hr_bpm?: number;
    max_hr_bpm?: number;
    avg_power_w?: number;
    normalized_power_w?: number;
    elevation_gain_m?: number;
    elevation_loss_m?: number;
    avg_respiration_brpm?: number;
  } & RunningDynamics)[];
  typed_splits?: TypedSplit[];
  split_summaries?: SplitSummary[];
  hr_zones?: ZoneTime[];
  power_zones?: ZoneTime[];
  weather?: ActivityWeather;
  exercise_sets?: StrengthSets;
  raw_summary?: Record<string, unknown>;
  stream_summary?: StreamSummary;
  /** `null`: the activity has no power, so it has no curve. */
  power_curve?: { best: { duration: string; power_w: number; w_per_kg?: number; at?: string }[] } | null;
  stream?: { metrics: string[]; total_samples: number; offset: number; samples: Record<string, unknown>[] };
  next_cursor?: string;
}

/**
 * `get_activity` levels: the overview, one extra section, the stream aggregated per bucket, the
 * power curve from the FIT file (never part of `full`), or everything incl. the raw stream.
 */
export type ActivityDetailLevel = 'summary' | 'splits' | 'hr_zones' | 'power_zones' | 'weather' | 'exercise_sets' | 'stream_summary' | 'power_curve' | 'full';

/**
 * What `activity_details` keeps of an activity's FIT file (kind `power_curve`); the file itself
 * is not kept. `best` is empty when the file has no power; the gear shifts are kept for the
 * shifting summary. `null`: Garmin has no FIT file for the activity.
 */
interface StoredFit {
  best: BestEffort[];
  gear_changes: FitGearChange[];
}

/** The .fit entry of a downloaded zip, else the bytes as they came. */
function fitEntry(data: Uint8Array): Uint8Array {
  const isZip = data[0] === 0x50 && data[1] === 0x4b;
  return (isZip ? unzip(data).find((e) => e.name.toLowerCase().endsWith('.fit'))?.data : undefined) ?? data;
}

/** Options of the stream levels: `bucket` for `stream_summary`, `metrics` and `downsample_s` for `full` (keep them the same on every page). */
export interface ActivityStreamOptions {
  bucket?: StreamBucket;
  metrics?: readonly string[];
  downsample_s?: number;
}

function autoSyncNote(report: SyncJobReport | undefined): string {
  if (!report) return 'The missing days are downloading from Garmin in the background; ask again in a minute for the rest.';
  if (report.status === 'budget') return `The daily Garmin request limit is used up; the missing days download after ${iso(report.resume_at) ?? 'midnight'} when asked again.`;
  if (report.status === 'paused') return `Syncing with Garmin is paused (${report.reason ?? 'rate limit'}); the missing days download after ${iso(report.resume_at) ?? 'the pause'} when asked again.`;
  return 'Another sync was running, so some days are still missing; ask again in a minute.';
}

function mergeSource(results: readonly EnsureResult[]): ResponseMeta['source'] {
  if (results.some((r) => r.source === 'partial')) return 'partial';
  if (results.some((r) => r.source === 'live')) return 'live';
  return 'cache';
}

/** Adds a note after any note the response already carries (sync gap, partial data). */
/** The narrowest sync scope that fills these daily tables. */
function dailyScope(kinds: readonly DailyKind[]): SyncScope {
  const training = kinds.includes('training_status');
  if (!training) return 'health';
  return kinds.every((k) => k === 'training_status') ? 'training' : 'all';
}

function withNote(meta: ResponseMeta, note: string): ResponseMeta {
  return { ...meta, note: meta.note ? `${meta.note} ${note}` : note };
}

/** Why a `list_workouts` sport filter found no workouts: not a workout sport, or none in the library. */
function workoutSportNote(sport: string): string {
  if (!(SPORT_KEYS as readonly string[]).includes(sport)) return `No workout sport matches "${sport}"; valid sports are ${SPORT_KEYS.join(', ')}.`;
  return `The workout library has no ${sport} workouts.`;
}

/**
 * Use cases behind the MCP tools and the CLI: validate ranges, make sure the cache
 * covers them (fetching on demand within a time budget), then compute with pure
 * domain functions. Adapters only shape input and output.
 */
export class GarminService {
  readonly client: GarminClient;
  readonly store: Store;
  readonly syncer: Syncer;
  readonly jobs: SyncJobRunner;
  readonly #tz: string;
  readonly #budget: number;
  readonly #downloadDir: string;
  readonly #now: () => number;
  readonly #autoSync: boolean;
  readonly #redact: boolean;
  readonly #log: Logger;

  constructor(opts: GarminServiceOptions) {
    this.client = opts.client;
    this.store = opts.store;
    this.syncer = opts.syncer;
    this.jobs = opts.jobs;
    this.#tz = opts.timeZone;
    this.#budget = opts.budgetMs ?? 20_000;
    this.#downloadDir = opts.downloadDir;
    this.#now = opts.now ?? Date.now;
    this.#autoSync = opts.autoSync ?? false;
    this.#redact = opts.redact ?? true;
    this.#log = opts.logger ?? silentLogger;
  }

  /**
   * Auto sync: when a read reports data that was never synced (`meta.sync_hint`), run the
   * regular sync job for exactly that scope and range - 7-day chunks, pauses, the daily
   * request cap and the pause after a 429 - wait at most the time budget and read again.
   * Whatever is still missing keeps downloading in the background, and the answer says so
   * instead of asking the user to sync. Results without a hint pass through untouched.
   */
  async withAutoSync<T>(read: () => Promise<T>, opts: SyncProgressOptions = {}): Promise<T> {
    const first = await read();
    const hint = (first as Partial<Envelope<unknown>> | undefined)?.meta?.sync_hint;
    if (!this.#autoSync || !hint) return first;
    const today = this.today();
    const job = this.jobs.start({ scope: hint.scope, from: hint.from ?? today, to: hint.to ?? today, ...(opts.onProgress && { onProgress: opts.onProgress }) });
    const timer = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), this.#budget).unref());
    let report: SyncJobReport | undefined;
    try {
      report = await Promise.race([job, timer]);
    } catch (err) {
      this.#log.warn({ err: errInfo(err), hint }, 'auto sync failed');
      return first;
    }
    if (opts.throwWhenSignedOut) throwIfSignedOut(report);
    const second = (await read()) as T & Envelope<unknown>;
    if (!second.meta.sync_hint) return { ...second, meta: { ...second.meta, source: 'live' } };
    const { sync_hint: _, ...meta } = second.meta;
    return { ...second, meta: { ...meta, source: 'partial', note: autoSyncNote(report) } };
  }

  get timeZone(): string {
    return this.#tz;
  }

  today(): IsoDate {
    return this.syncer.today();
  }

  /** Resolve and validate a date range; defaults to the last `defaultDays` days. */
  range(from: string | undefined, to: string | undefined, defaultDays: number): { from: IsoDate; to: IsoDate } {
    const end = to ? assertIsoDate(to, 'to') : this.today();
    const start = from ? assertIsoDate(from, 'from') : addDays(end, -(defaultDays - 1));
    if (start > end) throw new InputError(`from (${start}) is after to (${end})`);
    if (addDays(start, MAX_RANGE_DAYS) < end) throw new InputError(`Range too long; at most ${MAX_RANGE_DAYS} days`, 'Split the request into smaller ranges.');
    return { from: start, to: end };
  }

  #meta(results: readonly EnsureResult[], fetchedAt: readonly (number | undefined)[], extra: Partial<ResponseMeta> = {}): ResponseMeta {
    const times = fetchedAt.filter((t): t is number => typeof t === 'number');
    const coverage = results.find((r) => r.coverage)?.coverage;
    const source = mergeSource(results);
    return compact({
      source,
      fetched_at: iso(times.length ? Math.min(...times) : undefined),
      coverage: coverage && { from: coverage.from, to: coverage.to, complete: coverage.complete, missing_days: coverage.missing as Record<string, number> },
      note: source === 'partial' ? 'Garmin is still being synced in the background; ask again shortly for complete data.' : undefined,
      ...extra,
    });
  }

  /**
   * Without auto fetch, say exactly what is missing and which sync would fill it,
   * so the model can ask the user before anything is downloaded.
   */
  #gap(scope: SyncScope, from: IsoDate, to: IsoDate, what: string): Partial<ResponseMeta> {
    if (this.syncer.fetchOnDemand) return {};
    return {
      note: `Not synced from Garmin yet: ${what}. Data is only downloaded on request; ask the user whether to call garmin_sync with sync_hint (or run \`garmin sync --scope ${scope} --from ${from} --to ${to}\`).`,
      sync_hint: { scope, from, to },
    };
  }

  #dailyGap(scope: SyncScope, kinds: readonly DailyKind[], from: IsoDate, to: IsoDate): Partial<ResponseMeta> {
    const cov = this.syncer.coverage(kinds, from, to);
    if (cov.complete) return {};
    const missing = Object.entries(cov.missing).map(([k, n]) => `${n} day(s) of ${k}`).join(', ');
    return this.#gap(scope, from, to, `${missing} between ${from} and ${to}`);
  }

  #activityGap(from: IsoDate, to: IsoDate): Partial<ResponseMeta> {
    const gaps = this.syncer.activityGaps(from, to);
    if (gaps.length === 0) return {};
    const first = gaps[0] as [IsoDate, IsoDate];
    const last = gaps.at(-1) as [IsoDate, IsoDate];
    return this.#gap('activities', first[0], last[1], `activities in ${gaps.map(([a, b]) => (a === b ? a : `${a}..${b}`)).join(', ')}`);
  }

  #periodGap(from: IsoDate, to: IsoDate, kinds: readonly DailyKind[] = SCOPE_DAILY.health): Partial<ResponseMeta> {
    const daily = this.#dailyGap(dailyScope(kinds), kinds, from, to);
    const acts = this.#activityGap(from, to);
    if (daily.sync_hint && acts.sync_hint) return { ...daily, sync_hint: { scope: 'all', from, to }, note: `${daily.note} Activities are missing too.` };
    return daily.sync_hint ? daily : acts;
  }

  /**
   * What the cache lacks for [from, to], as the `meta` fields a read puts in its envelope:
   * `note` and `sync_hint` when something was never synced and auto fetch is off, nothing
   * otherwise. The same result `queryHealth` ("daily"), `getActivities` ("activities") and
   * `getPeriodSummary` ("period") return, for computations that build their own envelope on
   * top of the service and pass it through `withAutoSync`. `kinds` are the daily tables
   * checked by "daily" and "period" (default: the health scope); the hint's scope follows them.
   */
  coverage(kind: 'daily' | 'activities' | 'period', from: IsoDate, to: IsoDate, kinds: readonly DailyKind[] = SCOPE_DAILY.health): Partial<ResponseMeta> {
    if (kind === 'activities') return this.#activityGap(from, to);
    if (kind === 'period') return this.#periodGap(from, to, kinds);
    return this.#dailyGap(dailyScope(kinds), kinds, from, to);
  }

  /**
   * What the cache lacks of a reference table (`referenceFetchedAt` never set), as the `meta`
   * fields of a read: `sync_hint` with `scope: "reference"`, plus a note when auto fetch is off;
   * nothing once the table was fetched. The same gap `getProfile`, `getGear` and `getDevices`
   * report, for computations that build their own envelope on top of the service.
   */
  referenceCoverage(kind: ReferenceKind): Partial<ResponseMeta> {
    return this.#referenceGap(kind);
  }

  /**
   * Garmin's own threshold history for the analytics reads: the running lactate threshold heart
   * rate and speed per day over the last {@link THRESHOLD_HISTORY_DAYS} days and the latest
   * cycling FTP. Three requests within the daily request limit, at most once a local day and only
   * with auto fetch on; no sync job fetches it. A part Garmin does not give is stored as
   * null, so it is not asked for again that day. The analytics records it as `garmin-auto`
   * thresholds from the cache (`Store.getThresholdHistory`).
   */
  async ensureThresholdHistory(): Promise<{ result: EnsureResult; note?: string }> {
    const cached = this.store.getThresholdHistory();
    const today = this.today();
    const fetch = this.#autoSync || this.syncer.fetchOnDemand;
    if (!fetch || (cached && dateIn(this.#tz, new Date(cached.fetched_at)) >= today)) return { result: { source: 'cache' } };
    const from = addDays(today, -THRESHOLD_HISTORY_DAYS);
    const parts = {
      lthr_hr: () => this.client.getLactateThresholdHeartRate(from, today),
      lthr_speed: () => this.client.getLactateThresholdSpeed(from, today),
      ftp: () => this.client.getCyclingFtp(),
    };
    const got = { lthr_hr: null as unknown, lthr_speed: null as unknown, ftp: null as unknown };
    for (const key of Object.keys(parts) as (keyof typeof parts)[]) {
      try {
        const res = await this.syncer.lazyRequest(`thresholds:${key}`, parts[key]);
        if ('blocked' in res) {
          const why = res.blocked.reason === 'budget' ? 'The daily Garmin request limit is used up' : 'Syncing with Garmin is paused';
          return { result: { source: 'cache' }, note: `${why}; Garmin's threshold history downloads after ${iso(res.blocked.resume_at)} when asked again.` };
        }
        got[key] = res.value ?? null;
      } catch (err) {
        const info = errInfo(err);
        if (FATAL_CODES.has(info.code)) return { result: { source: 'cache' }, note: `Garmin's threshold history could not be downloaded (${info.code}).` };
        this.#log.warn({ part: key, err: info }, 'threshold history fetch failed');
      }
    }
    this.store.setThresholdHistory({ ...got, fetched_at: this.#now() });
    return { result: { source: 'live' } };
  }

  #referenceGap(kind: ReferenceKind): Partial<ResponseMeta> {
    if (this.store.referenceFetchedAt(kind) !== undefined) return {};
    const meta = this.#gap('reference', this.today(), this.today(), kind.replace('_', ' '));
    return { ...meta, sync_hint: { scope: 'reference' } };
  }

  /** The workout library and the calendar months of [from, to] come from the reference sync. */
  #calendarGap(from: IsoDate, to: IsoDate): Partial<ResponseMeta> {
    if (this.store.referenceFetchedAt('workouts') === undefined) return this.#gap('reference', from, to, `workout library and calendar ${from}..${to}`);
    const gap = this.syncer.calendarGap(from, to);
    return gap ? this.#gap('reference', gap.from, gap.to, `calendar ${gap.from}..${gap.to} (never fetched or older than 15 min)`) : {};
  }

  // ------------------------------------------------------------ sync

  /**
   * Explicit sync of a scope and date range (default: the last 7 days). Long ranges
   * run as a background job in chunks with pauses; this waits at most the time
   * budget and reports progress. Data already stored is skipped.
   */
  async sync(scope: SyncScope = 'all', from?: string, to?: string, force = false, opts: SyncProgressOptions = {}) {
    const end = to ? assertIsoDate(to, 'to') : this.today();
    const start = from ? assertIsoDate(from, 'from') : addDays(end, -6);
    if (start > end) throw new InputError(`from (${start}) is after to (${end})`);
    const running = this.jobs.current();
    const job = this.jobs.start({ scope, from: start, to: end, force, ...(opts.onProgress && { onProgress: opts.onProgress }) });
    const timer = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), this.#budget).unref());
    const report: SyncJobReport | undefined = await Promise.race([job, timer]);
    if (opts.throwWhenSignedOut) throwIfSignedOut(report);
    const current = this.jobs.current();
    return {
      data: compact({
        status: report ? report.status : 'running',
        joined_running_job: running ? running.request : undefined,
        requests: report?.requests ?? current?.progress.requests,
        chunks: report ? `${report.chunks_done}/${report.chunks_total}` : current ? `${current.progress.chunks_done}/${current.progress.chunks_total}` : undefined,
        fetched: report?.fetched,
        removed: report?.removed,
        remaining: report?.remaining,
        resume_at: iso(report?.resume_at),
        reason: report?.reason,
        errors: report?.errors.slice(0, 5).map((e) => `${e.item}: ${e.code} ${e.message}`),
        limits: this.jobs.limits(),
      }),
      meta: compact({
        source: report ? ('live' as const) : ('partial' as const),
        note: report
          ? report.status === 'done'
            ? undefined
            : `Sync stopped (${report.status}); run the same sync again after resume_at to continue. Stored data is kept.`
          : 'The sync continues in the background in chunks with pauses; read garmin://sync-status for progress.',
      }),
    };
  }

  syncStatus() {
    const today = this.today();
    const kinds: DailyKind[] = ['daily_summary', 'sleep', 'hrv', 'training_status'];
    return compact({
      today,
      auto_fetch: this.#autoSync || this.syncer.fetchOnDemand,
      running_job: this.jobs.current(),
      limits: this.jobs.limits(),
      activities_synced: this.store.getMeta('activities:covered'),
      weigh_ins_synced: this.store.getMeta('weighins:covered'),
      activities_listed_at: iso(this.store.getMetaNumber('activities:listed_at')),
      coverage_last_90_days: this.syncer.coverage(kinds, addDays(today, -89), today),
      tables: this.store.tableStats(),
      recent_runs: this.store.recentSyncs(10).map((s) => ({
        id: s.id,
        scope: s.scope,
        mode: s.mode,
        range: s.from_date ? `${s.from_date}..${s.to_date}` : undefined,
        status: s.status,
        started: iso(s.started_at),
        finished: iso(s.finished_at),
        stats: s.stats,
        error: s.error?.split('\n')[0],
      })),
    });
  }

  // ------------------------------------------------------------ activities

  async getActivities(q: ActivitiesQuery) {
    const from = q.from ? assertIsoDate(q.from, 'from') : undefined;
    const to = q.to ? assertIsoDate(q.to, 'to') : undefined;
    const pace = q.pace === undefined ? undefined : parsePaceRange(q.pace);
    const ensured = await this.syncer.ensureActivities(from, to, this.#budget);
    const limit = Math.min(Math.max(q.limit ?? 20, 1), 100);
    const offset = decodeCursor(q.cursor);
    const rows = this.store.queryActivities({
      from,
      to,
      type: q.type,
      eventType: q.event_type === undefined ? undefined : looseKey(q.event_type),
      name: q.name,
      minDurationS: q.min_duration_min === undefined ? undefined : q.min_duration_min * 60,
      maxDurationS: q.max_duration_min === undefined ? undefined : q.max_duration_min * 60,
      // The fast end of the pace range is the upper speed bound.
      minSpeedMps: pace && 1000 / pace.slowest_s,
      maxSpeedMps: pace && 1000 / pace.fastest_s,
      limit: limit + 1,
      offset,
      sort: q.sort ?? 'desc',
    });
    const page = rows.slice(0, limit);
    const meta = this.#meta([ensured], page.map((r) => r.fetched_at), this.#activityGap(from ?? addDays(to ?? this.today(), -29), to ?? this.today()));
    return {
      data: compact({
        activities: page.map((r) => activityListItem(r, this.store.getActivityDetail(r.id, 'weather')?.raw)),
        next_cursor: rows.length > limit ? encodeCursor(offset + limit) : undefined,
      }),
      meta: q.type !== undefined && page.length === 0 && offset === 0 ? withNote(meta, this.#activityTypeNote(q.type, from, to)) : meta,
    };
  }

  /**
   * Why a type filter found nothing: an unknown key (matched like the store query: equal or
   * substring, case-insensitive) or simply no such activities in the range.
   */
  #activityTypeNote(type: string, from: IsoDate | undefined, to: IsoDate | undefined): string {
    const keys = this.store.getActivityTypes().flatMap((t) => (typeof t.typeKey === 'string' && t.typeKey !== '' ? [t.typeKey] : []));
    if (keys.length === 0) return `No activities match type "${type}" and activity type keys are not stored yet; sync reference data to list them (garmin://activity-types).`;
    const needle = type.toLowerCase();
    if (!keys.some((k) => k === type || k.toLowerCase().includes(needle))) {
      return `No activity type matches "${type}"; valid keys are in garmin://activity-types, e.g. running, trail_running, cycling.`;
    }
    const range = from && to ? ` between ${from} and ${to}` : from ? ` since ${from}` : to ? ` up to ${to}` : '';
    return `"${type}" is a valid activity type, but there are no such activities${range}.`;
  }

  async #activityRow(id: number) {
    let row = this.store.getActivity(id);
    if (!row) {
      const a = await this.client.getActivity(id).catch((err: unknown) => this.#forgetIfGone(id, err, true));
      const start = typeof a.summaryDTO?.startTimeLocal === 'string' ? a.summaryDTO.startTimeLocal.slice(0, 10) : undefined;
      if (start) await this.syncer.ensureActivities(start, start, this.#budget);
      row = this.store.getActivity(id);
    }
    return row;
  }

  /**
   * Rethrows `err`, except for a 404 for an activity Garmin no longer has (deleted in Garmin
   * Connect): that one is removed from the cache and reported as such. `confirmed` says the 404
   * came from the activity itself; a 404 for one of its sections is checked against it first.
   */
  async #forgetIfGone(id: number, err: unknown, confirmed: boolean): Promise<never> {
    if (errInfo(err).code !== 'NOT_FOUND') throw err;
    if (!confirmed) {
      const gone = await this.client.getActivity(id).then(
        () => false,
        (probe: unknown) => errInfo(probe).code === 'NOT_FOUND',
      );
      if (!gone) throw err;
    }
    this.store.deleteActivity(id);
    throw new GarminError('NOT_FOUND', `Activity ${id} no longer exists in Garmin Connect; it was deleted there and is now removed from the local cache.`, {
      hint: 'List current activities with get_activities.',
    });
  }

  /**
   * Activity detail from the cache, else fetched once and cached forever. For the
   * optional sections (`notFoundIsEmpty`) a 404 means "no such data for this
   * activity" (indoor weather, no power meter, not a strength workout) and is
   * cached as null, so it is not asked again.
   */
  async #detail<T>(id: number, kind: DetailKind, fetch: () => Promise<T>, notFoundIsEmpty = false): Promise<{ raw: T; fetched_at: number; live: boolean }> {
    const cached = this.store.getActivityDetail(id, kind);
    if (cached) return { raw: cached.raw as T, fetched_at: cached.fetched_at, live: false };
    let raw: T;
    try {
      raw = await fetch();
    } catch (err) {
      if (!notFoundIsEmpty) return this.#forgetIfGone(id, err, kind === 'summary');
      if (errInfo(err).code !== 'NOT_FOUND') throw err;
      raw = null as T;
    }
    const at = this.#now();
    this.store.putActivityDetail(id, kind, raw, at);
    return { raw, fetched_at: at, live: true };
  }

  async getActivity(id: number, detail: ActivityDetailLevel = 'summary', cursor?: string, opts: ActivityStreamOptions = {}) {
    const row = await this.#activityRow(id);
    const summary = await this.#detail(id, 'summary', () => this.client.getActivity(id));
    const s = summary.raw.summaryDTO ?? {};
    const brief = row ? activityBrief(row) : { id, name: summary.raw.activityName ?? undefined };
    const footSport = isFootSport(row?.type ?? summary.raw.activityTypeDTO?.typeKey);
    const base = compact({
      ...brief,
      description: summary.raw.description ?? undefined,
      location: summary.raw.locationName ?? undefined,
      moving_time: hms(s.movingDuration),
      elevation_loss_m: round(s.elevationLoss, 0),
      avg_gap_pace: footSport ? gapPace(s) : undefined,
      max_power_w: round(s.maxPower, 0),
      normalized_power_w: round(s.normalizedPower, 0),
      training_effect: { ...('training_effect' in brief ? brief.training_effect : {}), ...trainingEffectText(s) },
      running_dynamics: runningDynamics(s),
      respiration: respiration(s),
      stamina: stamina(s),
      motion: motionTime(summary.raw.splitSummaries),
      ...hrSource(summary.raw.metadataDTO, (s.averageHR ?? row?.avg_hr ?? 0) > 0),
      workout_id: summary.raw.metadataDTO?.associatedWorkoutId ?? undefined,
      workout_compliance_pct: round(s.directWorkoutComplianceScore, 0),
      // The list entry follows later edits in Garmin Connect; the stored summary only stands in without one.
      event_type: row ? activityBrief(row).event_type : eventTypeKey(summary.raw.eventTypeDTO),
      rpe: typeof s.directWorkoutRpe === 'number' ? s.directWorkoutRpe / 10 : undefined,
      feel: typeof s.directWorkoutFeel === 'number' ? s.directWorkoutFeel : undefined,
      gear_uuid: row?.gear_uuid ?? undefined,
    });
    const sources: EnsureResult[] = [{ source: summary.live ? 'live' : 'cache' }];
    const times = [summary.fetched_at];
    let extra: ActivitySections = {};
    const notes: string[] = [];

    if (detail === 'splits' || detail === 'full') {
      const splits = await this.#detail(id, 'splits', () => this.client.getActivitySplits(id));
      sources.push({ source: splits.live ? 'live' : 'cache' });
      times.push(splits.fetched_at);
      const laps = splits.raw?.lapDTOs ?? [];
      const workoutId = base.workout_id;
      const steps = workoutId !== undefined && laps.some((l) => l.wktStepIndex != null) ? await this.#workoutSteps(workoutId, s.startTimeGMT ?? undefined, notes) : undefined;
      extra.splits = laps.map((l) =>
        compact({
          lap: l.lapIndex,
          intensity: l.intensityType?.toLowerCase(),
          wkt_step_index: l.wktStepIndex ?? undefined,
          wkt_step: l.wktStepIndex == null ? undefined : steps?.get(l.wktStepIndex),
          compliance_pct: round(l.directWorkoutComplianceScore, 0),
          distance_km: km(l.distance),
          duration: hms(l.duration),
          moving_time: hms(l.movingDuration),
          ...speedOrPace(row?.type, l.distance, l.duration),
          avg_gap_pace: footSport ? gapPace(l) : undefined,
          avg_hr_bpm: round(l.averageHR, 0),
          max_hr_bpm: round(l.maxHR, 0),
          avg_power_w: round(l.averagePower, 0),
          normalized_power_w: round(l.normalizedPower, 0),
          cadence_spm: round(l.averageRunCadence, 0),
          ...runningDynamics(l),
          avg_respiration_brpm: respiration(l)?.avg_brpm,
          elevation_gain_m: round(l.elevationGain, 0),
          elevation_loss_m: round(l.elevationLoss, 0),
        }),
      );
      const sport = row?.type ?? summary.raw.activityTypeDTO?.typeKey ?? undefined;
      const typed = await this.#detail(id, 'typed_splits', () => this.client.getActivityTypedSplits(id), true);
      sources.push({ source: typed.live ? 'live' : 'cache' });
      times.push(typed.fetched_at);
      const typedList = typedSplits(typed.raw, sport);
      extra.typed_splits = typedList.splits;
      const merged = typedList.merged;
      if (merged > 0) notes.push(`${merged} run, walk or stand ${merged === 1 ? 'split' : 'splits'} under ${MIN_TYPED_SPLIT_S} s ${merged === 1 ? 'is' : 'are'} merged into a neighbour in typed_splits; split_summaries count all.`);
      // The activity carries the totals per split type itself; only without them they are fetched.
      if (Array.isArray(summary.raw.splitSummaries)) extra.split_summaries = splitSummaries(summary.raw.splitSummaries, sport);
      else {
        const totals = await this.#detail(id, 'split_summaries', () => this.client.getActivitySplitSummaries(id), true);
        sources.push({ source: totals.live ? 'live' : 'cache' });
        times.push(totals.fetched_at);
        const raw = totals.raw as { splitSummaries?: unknown } | null;
        extra.split_summaries = splitSummaries(raw?.splitSummaries, sport);
      }
    }
    if (detail === 'hr_zones' || detail === 'full') {
      const zones = await this.#detail(id, 'hr_zones', () => this.client.getActivityHrZones(id));
      sources.push({ source: zones.live ? 'live' : 'cache' });
      times.push(zones.fetched_at);
      extra.hr_zones = zoneTimes(zones.raw, 'bpm');
    }
    const missing: string[] = [];
    if (detail === 'power_zones' || detail === 'full') {
      const zones = await this.#detail(id, 'power_zones', () => this.client.getActivityPowerZones(id), true);
      sources.push({ source: zones.live ? 'live' : 'cache' });
      times.push(zones.fetched_at);
      extra.power_zones = zoneTimes(zones.raw, 'w');
      if (extra.power_zones.length === 0 && detail === 'power_zones') missing.push('power zones (no power meter data)');
    }
    if (detail === 'weather' || detail === 'full') {
      const weather = await this.#detail(id, 'weather', () => this.client.getActivityWeather(id), true);
      sources.push({ source: weather.live ? 'live' : 'cache' });
      times.push(weather.fetched_at);
      extra.weather = activityWeather(weather.raw, this.#units());
      if (!extra.weather && detail === 'weather') missing.push('weather (indoor activity or no station data)');
    }
    if (detail === 'exercise_sets' || detail === 'full') {
      const sets = await this.#detail(id, 'exercise_sets', () => this.client.getActivityExerciseSets(id), true);
      sources.push({ source: sets.live ? 'live' : 'cache' });
      times.push(sets.fetched_at);
      extra.exercise_sets = strengthSets(sets.raw);
      if (!extra.exercise_sets && detail === 'exercise_sets') missing.push('exercise sets (not a strength activity or no sets recorded)');
    }
    if (detail === 'full' || detail === 'stream_summary') {
      const details = await this.#detail(id, 'details', () => this.client.getActivityDetails(id));
      sources.push({ source: details.live ? 'live' : 'cache' });
      times.push(details.fetched_at);
      const all = (details.raw?.metricDescriptors ?? []).toSorted((a, b) => (a.metricsIndex ?? 0) - (b.metricsIndex ?? 0)).map((d) => d.key ?? `m${d.metricsIndex}`);
      const indexed = all.flatMap((k, i) => (this.#redact && GPS_STREAM_METRICS.has(k) ? [] : [[k, i] as const]));
      const samples = (details.raw?.activityDetailMetrics ?? []).map((m) => Object.fromEntries(indexed.map(([k, i]) => [k, m.metrics[i] ?? null])));
      if (detail === 'stream_summary') {
        const bucket = opts.bucket ?? 'km';
        const date = (row?.start_time_local ?? s.startTimeLocal ?? undefined)?.slice(0, 10);
        const weight = bucket === 'climbs' && date !== undefined ? this.#weightOn(date) : undefined;
        extra.stream_summary = streamSummary(samples, bucket, footSport, { weightKg: weight?.kg });
        if (!extra.stream_summary) missing.push(`a usable stream${bucket === 'km' ? ' with distance' : bucket === 'climbs' ? ' with distance and elevation' : ''}`);
        else if (bucket === 'climbs' && extra.stream_summary.buckets.length === 0)
          notes.push(`No climbs: a climb is at least ${CLIMB_RULES.minLengthM} m long, ${CLIMB_RULES.minAvgGradePct} % steep on average and ${CLIMB_RULES.minGainM} m high.`);
        else if (weight && extra.stream_summary.buckets.some((b) => b.w_per_kg !== undefined)) notes.push(`W/kg with ${weight.kg} kg (${weight.source}).`);
      } else {
        const keys = indexed.map(([k]) => k);
        const filtered = filterStream(keys, samples, { metrics: opts.metrics, downsampleS: opts.downsample_s });
        const hidden = filtered.unknown.filter((k) => all.includes(k));
        const absent = filtered.unknown.filter((k) => !all.includes(k));
        if (hidden.length > 0) notes.push(`${hidden.join(', ')} left out: GPS is removed while GARMIN_REDACT is on.`);
        if (absent.length > 0) notes.push(`This stream has no ${absent.join(', ')}; its metrics are ${keys.join(', ')}.`);
        const offset = decodeCursor(cursor);
        const { page, next } = pageBySize(filtered.samples, offset, 40 * 1024);
        extra = {
          ...extra,
          raw_summary: offset === 0 ? (this.#redact ? redactActivityRaw(summary.raw) : summary.raw) : undefined,
          stream: { metrics: filtered.keys, total_samples: filtered.samples.length, offset, samples: page },
          next_cursor: next === undefined ? undefined : encodeCursor(next),
        };
      }
    }
    if (detail === 'power_curve') {
      // The list and the summary say whether there is power at all; without it no file is downloaded.
      const hasPower = (row?.avg_power ?? 0) > 0 || (s.averagePower ?? 0) > 0 || (s.maxPower ?? 0) > 0;
      const cached = this.store.getActivityDetail(id, 'power_curve') as { raw: StoredFit | null; fetched_at: number } | undefined;
      const fit = cached ?? (hasPower ? await this.#fitCurve(id) : undefined);
      if (fit === undefined) {
        extra.power_curve = null;
        notes.push('This activity has no power data, so it has no power curve; no file was downloaded.');
      } else if ('blocked' in fit) {
        const why = fit.blocked.reason === 'budget' ? 'The daily Garmin request limit is used up' : 'Syncing with Garmin is paused';
        notes.push(`${why}; the FIT file for the power curve downloads after ${iso(fit.blocked.resume_at)} when asked again.`);
      } else if ('unreadable' in fit) {
        notes.push(`The FIT file of this activity could not be read (${fit.unreadable}), so there is no power curve.`);
      } else {
        sources.push({ source: cached ? 'cache' : 'live' });
        times.push(fit.fetched_at);
        if (fit.raw === null || fit.raw.best.length === 0) {
          extra.power_curve = null;
          notes.push(fit.raw === null ? 'Garmin has no FIT file for this activity, so it has no power curve.' : 'The FIT file of this activity has no power data, so it has no power curve.');
        } else {
          const date = (row?.start_time_local ?? s.startTimeLocal ?? undefined)?.slice(0, 10);
          const weight = date === undefined ? undefined : this.#weightOn(date);
          extra.power_curve = {
            best: fit.raw.best.map((b) =>
              compact({ duration: durationLabel(b.duration_s), power_w: Math.round(b.power_w), w_per_kg: weight ? round(b.power_w / weight.kg, 2) : undefined, at: hms(b.start_s) }),
            ),
          };
          notes.push(weight ? `W/kg with ${weight.kg} kg (${weight.source}).` : 'No body weight in the cache, so no W/kg.');
        }
      }
    }
    if (missing.length > 0) notes.unshift(`Garmin has no ${missing.join(', ')} for this activity.`);
    const data = compact({ ...base, ...extra });
    // No climbs is an answer: the empty list stays.
    if (data.stream_summary && extra.stream_summary?.buckets.length === 0) data.stream_summary.buckets = [];
    // So is no power: the curve is null rather than missing.
    if (extra.power_curve === null) data.power_curve = null;
    return { data, meta: this.#meta(sources, times, notes.length > 0 ? { note: notes.join(' ') } : {}) };
  }

  /**
   * The power curve of an activity from its FIT file: downloaded once (one request within the
   * daily limit), reduced to the best efforts and the gear shifts, which are stored; the file is
   * not. A file Garmin does not have is stored as `null`; one that cannot be read is not stored.
   */
  async #fitCurve(id: number): Promise<{ raw: StoredFit | null; fetched_at: number } | { blocked: { reason: 'budget' | 'paused'; resume_at: number } } | { unreadable: string }> {
    let bytes: Uint8Array | undefined;
    try {
      const res = await this.syncer.lazyRequest(`fit:${id}`, () => this.client.downloadActivity(id, 'fit'));
      if ('blocked' in res) return res;
      bytes = fitEntry(res.value.data);
    } catch (err) {
      if (errInfo(err).code !== 'NOT_FOUND') throw err;
      // A 404 for an activity that still exists means it has no file (a manual entry).
      await this.#forgetIfGone(id, err, false).catch((probe: unknown) => {
        if (probe !== err) throw probe;
      });
    }
    let raw: StoredFit | null = null;
    if (bytes) {
      try {
        const fit = await readFitFile(bytes);
        raw = { best: bestEfforts(fit.records) ?? [], gear_changes: fit.gear_changes };
      } catch (err) {
        return { unreadable: errInfo(err).message };
      }
    }
    const at = this.#now();
    this.store.putActivityDetail(id, 'power_curve', raw, at);
    return { raw, fetched_at: at };
  }

  /**
   * Body weight on a day from the cache, without requests: the latest weigh-in up to 30 days
   * before (and on) the day, else the profile's weight.
   */
  #weightOn(date: IsoDate): { kg: number; source: string } | undefined {
    const weighIn = this.store
      .getBodyComposition(addDays(date, -30), date)
      .filter((r) => r.weight_kg !== null && r.weight_kg > 0)
      .at(-1);
    if (weighIn?.weight_kg) return { kg: round(weighIn.weight_kg, 1) ?? weighIn.weight_kg, source: `weigh-in ${weighIn.date}` };
    const grams = ((this.store.getProfile()?.raw.settings ?? {}) as { userData?: { weight?: unknown } }).userData?.weight;
    return typeof grams === 'number' && grams > 0 ? { kg: round(grams / 1000, 1) ?? grams / 1000, source: 'profile' } : undefined;
  }

  /**
   * Steps of the workout an activity followed, by the lap step index: the stored copy, else
   * fetched and stored. Without the steps, or when the workout was changed after the activity,
   * `notes` says so.
   */
  async #workoutSteps(workoutId: number, startGmt: string | undefined, notes: string[]): Promise<Map<number, string> | undefined> {
    let raw = this.store.getWorkout(workoutId)?.raw as { workoutSegments?: unknown; updatedDate?: unknown } | undefined;
    if (!Array.isArray(raw?.workoutSegments)) {
      try {
        const fetched = await this.client.getWorkout(workoutId);
        this.store.upsertWorkout(fetched, this.#now());
        raw = fetched;
      } catch (err) {
        const gone = errInfo(err).code === 'NOT_FOUND';
        notes.push(`${gone ? `Workout ${workoutId} no longer exists in Garmin Connect` : `The steps of workout ${workoutId} could not be read (${errInfo(err).message})`}; laps have wkt_step_index only.`);
        return undefined;
      }
    }
    if (typeof raw.updatedDate === 'string' && startGmt !== undefined && raw.updatedDate > startGmt) {
      notes.push(`Workout ${workoutId} was changed after this activity, so wkt_step shows its current steps, which may differ from the ones run.`);
    }
    return workoutStepsByIndex(raw);
  }

  /** Account measurement system from the cached profile, without fetching it. */
  #units(): string | undefined {
    const settings = (this.store.getProfile()?.raw.settings ?? {}) as { userData?: { measurementSystem?: unknown } };
    const units = settings.userData?.measurementSystem;
    return typeof units === 'string' ? units : undefined;
  }

  /** Edits activity `id`; `update_activity` without an id is `addActivity`. */
  async updateActivity(id: number, patch: ActivityEdit) {
    checkEditMode(id, patch);
    if (Object.values(patch).every((v) => v === undefined)) {
      throw new InputError('Nothing to update', 'Pass at least one of name, type, event_type, description, rpe, feel, privacy, exercise_sets, add_gear, remove_gear.');
    }
    if (patch.keep_timing !== undefined && patch.exercise_sets === undefined) throw new InputError('keep_timing goes with exercise_sets', 'Pass the sets to write in exercise_sets.');
    // Every key, gear name and set is checked before the first write, so a wrong one changes nothing.
    const sets = patch.exercise_sets === undefined ? undefined : await this.#exerciseSetsEdit(id, patch.exercise_sets, patch.keep_timing ?? false);
    const activityType = patch.type === undefined ? undefined : await this.#cachedActivityType(patch.type);
    const eventType = patch.event_type === undefined ? undefined : await this.#eventType(patch.event_type);
    const removed = patch.remove_gear === undefined ? undefined : this.#gearItem(patch.remove_gear);
    const added = patch.add_gear === undefined ? undefined : this.#gearItem(patch.add_gear);
    const at = this.#now();
    const { add_gear: _add, remove_gear: _remove, event_type: _event, exercise_sets: _sets, keep_timing: _keep, type, ...fields } = patch;
    let privacy: string | undefined;
    if (type !== undefined || eventType !== undefined || Object.values(fields).some((v) => v !== undefined)) {
      await this.client.updateActivity(id, { ...fields, typeKey: type, activityType, eventType });
      const activity = await this.client.getActivity(id);
      this.store.applyActivityEdit(activity, at);
      if (patch.privacy !== undefined) privacy = privacyKey(activity.accessControlRuleDTO) ?? patch.privacy;
    }
    let exerciseSets: StrengthSets | undefined;
    if (sets) {
      await this.client.updateActivityExerciseSets(id, sets.body);
      const written = await this.client.getActivityExerciseSets(id);
      this.store.putActivityDetail(id, 'exercise_sets', written, at);
      exerciseSets = strengthSets(written);
    }
    if (removed) {
      await this.client.unlinkGear(removed.uuid, id);
      this.store.clearActivityGear(id, removed.uuid);
    }
    if (added) {
      await this.client.linkGear(added.uuid, id);
      this.store.setActivityGear([id], added.uuid);
    }
    await Promise.all([removed, added].map((g) => g && this.#refreshGearStats(g.uuid)));
    const gear = removed || added ? compact({ added, removed }) : undefined;
    const previous = sets?.previous;
    return this.getActivity(id, 'summary').then((r) => ({
      data: compact({ updated: true, activity: r.data, gear, privacy, exercise_sets: exerciseSets, previous_exercise_sets: previous }),
      meta: { source: 'live' as const, fetched_at: iso(at) },
    }));
  }

  /**
   * Adds a manual activity, private unless `privacy` says otherwise, and stores it as the
   * activity list and the summary of `get_activity` would, so it is in the cache without a sync.
   * Notes, effort and feel are written by the regular edit right after it.
   */
  async addActivity(patch: ActivityEdit) {
    checkEditMode(undefined, patch);
    const fields = checkManualActivity(patch, this.#tz, this.#now());
    const activityType = await this.#cachedActivityType(fields.type);
    const id = await this.client.createManualActivity({
      typeKey: fields.type,
      activityType,
      name: patch.name ?? activityTypeName(fields.type),
      startLocal: fields.startLocal,
      timeZone: this.#tz,
      durationS: fields.durationS,
      distanceM: fields.distanceM,
      privacy: patch.privacy ?? 'private',
    });
    const { description, rpe, feel } = patch;
    if (description !== undefined || rpe !== undefined || feel !== undefined) await this.client.updateActivity(id, { description, rpe, feel });
    const activity = await this.client.getActivity(id);
    const at = this.#now();
    this.store.upsertActivities([activityListRow(activity)], at);
    this.store.putActivityDetail(id, 'summary', activity, at);
    const privacy = privacyKey(activity.accessControlRuleDTO) ?? patch.privacy ?? 'private';
    return this.getActivity(id, 'summary').then((r) => ({
      data: compact({ created: true, activity: r.data, privacy }),
      meta: { source: 'live' as const, fetched_at: iso(at) },
    }));
  }

  /**
   * Uploads one FIT, GPX or TCX file (`garmin upload`). A new activity is stored like `addActivity`
   * stores one, so it is in the cache without a sync; a duplicate or a file Garmin still processes
   * comes back with its status and leaves the cache alone.
   */
  async uploadActivity(file: string, data: Uint8Array): Promise<UploadReport> {
    const res = await this.client.uploadActivityFile(file, data);
    if (res.status === 'duplicate') return compact({ file, status: res.status, activity_id: res.activityId, message: res.message });
    if (res.status === 'failed') return { file, status: res.status, message: res.message };
    if (res.status === 'processing') return { file, status: res.status };
    const id = res.activityId;
    try {
      const activity = await this.client.getActivity(id);
      const at = this.#now();
      this.store.upsertActivities([activityListRow(activity)], at);
      this.store.putActivityDetail(id, 'summary', activity, at);
      const sum = activity.summaryDTO ?? {};
      return compact({ file, status: res.status, activity_id: id, stored: true, name: activity.activityName ?? undefined, type: activity.activityTypeDTO?.typeKey ?? undefined, start_local: sum.startTimeLocal?.slice(0, 16).replace('T', ' ') ?? undefined });
    } catch (err) {
      // The upload is done either way; the activity comes with the next activity sync.
      return { file, status: res.status, activity_id: id, stored: false, message: `not in the local database yet: ${errInfo(err).message}` };
    }
  }

  /**
   * `garmin log weight`: a manual weigh-in, then that day's weigh-ins downloaded again into the
   * cache. With body fat it goes as a weight scale FIT file through the upload service, the only
   * way Garmin Connect takes body composition; a file Garmin refuses is an error, a duplicate or
   * a file still processing comes back with a note.
   */
  async logWeight(kg: number, opts: { date?: string; fatPct?: number } = {}) {
    const weight = checkWeightKg(kg);
    const fat = opts.fatPct === undefined ? undefined : checkFatPct(opts.fatPct);
    const at = measuredAt(opts.date, this.#tz, this.#now());
    const day = at.local.slice(0, 10);
    let note: string | undefined;
    if (fat === undefined) await this.client.addWeighIn(weight, at);
    else {
      const file = await weightScaleFile({ at: at.utc, createdAt: new Date(this.#now()), weightKg: weight, fatPct: fat });
      const res = await this.client.uploadActivityFile('body_composition.fit', file);
      if (res.status === 'failed') {
        throw new GarminError('UPLOAD_REFUSED', `Garmin refused the body composition file: ${res.message}`, { hint: 'Nothing was added. Without --fat the weight goes as a plain weigh-in.' });
      }
      if (res.status === 'duplicate') note = `Garmin already has this measurement (${res.message}); nothing new was added`;
      if (res.status === 'processing') note = `Garmin is still processing the file; if the weigh-in is missing, run \`garmin sync --scope health --from ${day} --to ${day} --force\` later`;
    }
    const refreshed = await this.syncer.syncWeighIns(day, day, true);
    return compact({ logged: 'weight', weight_kg: kg, body_fat_pct: fat, at: at.local.slice(0, 16).replace('T', ' '), stored: refreshed.errors.length === 0, note });
  }

  /** `garmin log bp`: a manual blood pressure reading, "120/80" mmHg with an optional pulse. */
  async logBloodPressure(reading: string, opts: { pulse?: number; note?: string; date?: string } = {}) {
    const { systolic, diastolic } = parseBloodPressure(reading);
    const pulse = opts.pulse === undefined ? undefined : checkPulse(opts.pulse);
    const at = measuredAt(opts.date, this.#tz, this.#now());
    await this.client.addBloodPressure({ systolic, diastolic, pulse, notes: opts.note, at });
    return compact({ logged: 'blood_pressure', systolic, diastolic, pulse, at: at.local.slice(0, 16).replace('T', ' ') });
  }

  /** `garmin log water`: ml of water added to a day; Garmin answers with the day's total when it can. */
  async logHydration(ml: number, date?: string) {
    const at = measuredAt(date, this.#tz, this.#now());
    const day = (await this.client.addHydration(checkWaterMl(ml), at)) as { valueInML?: unknown } | null;
    const total = typeof day?.valueInML === 'number' ? day.valueInML : undefined;
    return compact({ logged: 'water', water_ml: ml, date: at.local.slice(0, 10), day_total_ml: total });
  }

  /**
   * Garmin's new `exerciseSets` for an edit and the sets it replaces. The current sets are read
   * live (a 404 means none), because the write replaces whatever Garmin has now.
   */
  async #exerciseSetsEdit(id: number, input: ExerciseSetInput[], keepTiming: boolean) {
    const checked = await checkExerciseSets(input, keepTiming);
    let raw: unknown = null;
    try {
      raw = await this.client.getActivityExerciseSets(id);
    } catch (err) {
      if (errInfo(err).code !== 'NOT_FOUND') throw err;
    }
    const current = rawExerciseSets(raw);
    let start: string | undefined;
    if (!keepTiming) {
      const first = current[0]?.startTime;
      start = typeof first === 'string' && first !== '' ? first : await this.#activityStartGmt(id);
    }
    return { body: exerciseSetsBody(current, checked, keepTiming, start), previous: exerciseSetsInput(raw) };
  }

  /** Start of an activity in UTC ("2026-10-07 05:00:00"), from the cache or else from Garmin. */
  async #activityStartGmt(id: number): Promise<string | undefined> {
    const cached = this.store.getActivity(id)?.raw.startTimeGMT;
    if (typeof cached === 'string' && cached !== '') return cached;
    const start = (await this.client.getActivity(id)).summaryDTO?.startTimeGMT;
    return typeof start === 'string' && start !== '' ? start : undefined;
  }

  /**
   * Garmin's event type for `key` (race, training...). The list is fetched with the first edit
   * that needs it and kept: it does not change, and a key missing from the stored list is looked
   * up once more before it is refused.
   */
  async #eventType(key: string): Promise<EventType> {
    const find = (types: readonly EventType[]) => types.find((t) => typeof t.typeKey === 'string' && looseKey(t.typeKey) === looseKey(key));
    let types = this.store.getEventTypes();
    if (!find(types)) {
      types = await this.client.getEventTypes();
      this.store.setEventTypes(types);
    }
    const match = find(types);
    if (match) return match;
    const valid = types.map((t) => t.typeKey).filter(Boolean).join(', ');
    throw new InputError(`Unknown event type "${key}". Valid keys: ${valid}`);
  }

  /**
   * A gear item from the stored gear list by uuid or by name: the full name first, then a part
   * of it, active gear before retired. A uuid that is not in the list passes as it is, so gear
   * added in Garmin Connect a moment ago works without a sync.
   */
  #gearItem(ref: string): { uuid: string; name?: string } {
    const rows = this.store.getGear();
    const brief = (g: (typeof rows)[number]) => compact({ uuid: g.uuid, name: g.name ?? undefined });
    const byUuid = rows.find((g) => g.uuid === ref);
    if (byUuid) return brief(byUuid);
    if (/^[0-9a-f-]{32,36}$/i.test(ref)) return { uuid: ref };
    const needle = ref.trim().toLowerCase();
    const named = rows.filter((g) => g.name?.toLowerCase() === needle);
    const partly = named.length > 0 ? named : rows.filter((g) => g.name?.toLowerCase().includes(needle));
    const active = partly.filter((g) => g.status === 'active');
    const matches = active.length > 0 ? active : partly;
    if (matches.length === 1) return brief(matches[0] as (typeof rows)[number]);
    const names = (list: typeof rows) => list.map((g) => `${g.name ?? '(no name)'} (${g.uuid})`).join(', ');
    if (matches.length > 1) throw new InputError(`"${ref}" matches several gear items: ${names(matches)}`, 'Pass the uuid of the one you mean.');
    if (rows.length === 0) throw new InputError('No gear is stored yet', 'Call get_gear first, then pass the gear name or uuid.');
    throw new InputError(`No gear matches "${ref}". Gear: ${names(rows)}`, 'Gear added a moment ago shows up in get_gear after a reference sync; its uuid works right away.');
  }

  /** Distance and activity count of one gear item after it was put on or taken off an activity; a failure only leaves the old totals. */
  async #refreshGearStats(uuid: string): Promise<void> {
    try {
      const stats = await this.client.getGearStats(uuid);
      if (stats) this.store.setGearStats(uuid, stats);
    } catch (err) {
      this.#log.warn({ gear: uuid, err: errInfo(err) }, 'gear totals not refreshed');
    }
  }

  /**
   * The activity type for `key` from the cached type list (refreshed like other reference data).
   * Undefined when no list is stored yet: the client then fetches it once for the edit.
   */
  async #cachedActivityType(key: string): Promise<ActivityType | undefined> {
    await this.syncer.ensureReference('activity_types', this.#budget);
    const types = this.store.getActivityTypes();
    if (types.length === 0) return undefined;
    const match = types.find((t) => t.typeKey === key);
    if (match) return match;
    const valid = types.map((t) => t.typeKey).filter(Boolean).toSorted().join(', ');
    throw new InputError(`Unknown activity type "${key}". Valid keys: ${valid}`, 'Valid keys are also in the garmin://activity-types resource.');
  }

  /** `outputDir` is a subdirectory of the download directory; the base itself is set by GARMIN_FIT_DOWNLOAD_DIR. */
  async downloadActivityFile(id: number, format: DownloadFormat, outputDir?: string) {
    const dir = this.#downloadTarget(outputDir);
    const file = await this.client.downloadActivity(id, format);
    let name = `${id}.${format}`;
    let data = file.data;
    if (format === 'fit') {
      const isZip = data[0] === 0x50 && data[1] === 0x4b;
      const fit = isZip ? unzip(data).find((e) => e.name.toLowerCase().endsWith('.fit')) : undefined;
      if (fit) {
        data = fit.data;
        name = `${id}.fit`;
      } else if (isZip) {
        name = `${id}.zip`;
      }
    }
    const target = path.join(dir, name);
    fs.writeFileSync(target, data);
    return { data: { path: target, bytes: data.length, format }, meta: { source: 'live' as const, fetched_at: iso(this.#now()) } };
  }

  #downloadTarget(outputDir: string | undefined): string {
    const base = path.resolve(this.#downloadDir);
    const dir = path.resolve(base, outputDir ?? '.');
    const inside = (root: string, p: string) => {
      const rel = path.relative(root, p);
      return rel === '' || (rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel));
    };
    const refuse = () =>
      new InputError(
        `output_dir must be a subdirectory of the download directory ${base}, got "${outputDir}"`,
        'Pass a relative name such as "races", or leave output_dir out. The download directory itself is set by GARMIN_FIT_DOWNLOAD_DIR.',
      );
    if (!inside(base, dir)) throw refuse();
    // A symlink inside the download directory must not lead out of it: check the deepest
    // existing part of the path before creating the rest.
    fs.mkdirSync(base, { recursive: true });
    let existing = dir;
    while (!fs.existsSync(existing)) existing = path.dirname(existing);
    if (!inside(fs.realpathSync(base), fs.realpathSync(existing))) throw refuse();
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  // ------------------------------------------------------------ health

  async queryHealth(metrics: readonly HealthMetric[], fromArg: string | undefined, toArg: string | undefined, granularity: HealthGranularity = 'day') {
    if (metrics.length === 0) throw new InputError('metrics must not be empty');
    if (granularity === 'hour') return this.#hourlyHealth(metrics, fromArg, toArg);
    const { from, to } = this.range(fromArg, toArg, 7);
    const daily = await this.#dailyHealth(metrics, from, to, granularity);
    return { data: compact({ from, to, ...daily.table }), meta: daily.meta };
  }

  async #dailyHealth(metrics: readonly HealthMetric[], from: IsoDate, to: IsoDate, granularity: 'day' | 'week') {
    const historyFrom = addDays(to, -27) < from ? addDays(to, -27) : from;
    const tables = tablesFor(metrics);
    const [ensured, water] = await Promise.all([
      tables.length > 0 ? this.syncer.ensureDaily(tables, historyFrom, to, this.#budget) : undefined,
      metrics.includes('hydration') ? this.#ensureHydration(from, to) : undefined,
    ]);
    const load = (a: IsoDate, b: IsoDate) => ({
      daily: tables.includes('daily_summary') ? this.store.getDaily('daily_summary', a, b) : [],
      sleep: tables.includes('sleep') ? this.store.getDaily('sleep', a, b) : [],
      hrv: tables.includes('hrv') ? this.store.getDaily('hrv', a, b) : [],
      hydration: water ? this.store.getIntradayRange('hydration', a, b) : [],
    });
    const history = load(historyFrom, to);
    const inRange = load(from, to);
    const table = healthTable(metrics, inRange, from, to, granularity, history);
    const times = [...inRange.daily, ...inRange.sleep, ...inRange.hrv, ...inRange.hydration].map((r) => r.fetched_at);
    const results: EnsureResult[] = [
      ...(ensured ? [{ ...ensured, coverage: this.syncer.coverage(tables, from, to) }] : []),
      ...(water?.results ?? []),
    ];
    let gap = this.#dailyGap('health', tables, from, to);
    const waterNote = water && water.note(table.summary.hydration?.days_with_data ?? 0);
    if (waterNote) gap = { ...gap, note: gap.note ? `${gap.note} ${waterNote}` : waterNote };
    return { table, results, times, gap, meta: this.#meta(results, times, gap) };
  }

  /**
   * The `hydration` metric: Garmin's water summary of each day of [from, to] up to today, one
   * request per day the cache lacks (today's after 15 min), kept in the `intraday` table. Fetched
   * only here, with auto fetch on and within the daily request limit, never by `garmin_sync`.
   * `note` says what is missing, or that no water was logged at all.
   */
  async #ensureHydration(from: IsoDate, to: IsoDate) {
    const today = this.today();
    const days = from <= today ? eachDay(from, to < today ? to : today) : [];
    const fetch = this.#autoSync || this.syncer.fetchOnDemand;
    const ensured = await Promise.all(days.map((d) => this.syncer.ensureIntraday(d, ['hydration'], this.#budget, { fetch })));
    const results: EnsureResult[] = ensured.map((r) => ({ source: r.source }));
    const missing = days.filter((_, i) => (ensured[i]?.missing.length ?? 0) > 0);
    const blocked = ensured.find((r) => r.blocked)?.blocked;
    const note = (daysWithData: number): string | undefined => {
      if (blocked) {
        const why = blocked.reason === 'budget' ? 'The daily Garmin request limit is used up' : 'Syncing with Garmin is paused';
        return `${why}; hydration of the days still missing downloads after ${iso(blocked.resume_at)} when asked again.`;
      }
      if (!fetch && missing.length > 0) {
        return `Hydration of ${missing.length} day(s) between ${missing[0]} and ${missing.at(-1)} is not downloaded yet: it is fetched only by a query_health question with auto fetch on (GARMIN_AUTO_FETCH), never by garmin_sync.`;
      }
      if (days.length > 0 && missing.length === 0 && daysWithData === 0) return `No water intake is logged in Garmin Connect for ${from}..${to}.`;
      return undefined;
    };
    return { results, note };
  }

  /**
   * `query_health` per hour for up to 3 days: the intraday series are downloaded only here, on the
   * question that needs them (with auto fetch, within the daily request limit), and kept; metrics
   * without hourly values come per day in `daily`.
   */
  async #hourlyHealth(metrics: readonly HealthMetric[], fromArg: string | undefined, toArg: string | undefined) {
    const { from, to } = this.range(fromArg, toArg, 1);
    const days = eachDay(from, to);
    if (days.length > MAX_HOURLY_DAYS) {
      throw new InputError(`granularity "hour" covers at most ${MAX_HOURLY_DAYS} days; ${from}..${to} has ${days.length}`, 'Use granularity "day" (or "week") for longer ranges, or ask about up to 3 days.');
    }
    const hourly = metrics.filter(isHourlyMetric);
    const perDay = metrics.filter((m) => !isHourlyMetric(m));
    const kinds = intradayKinds(hourly);
    const today = this.today();
    const fetchDays = kinds.length > 0 ? days.filter((d) => d <= today) : [];
    const fetch = this.#autoSync || this.syncer.fetchOnDemand;
    const [daily, ensured] = await Promise.all([
      perDay.length > 0 ? this.#dailyHealth(perDay, from, to, 'day') : undefined,
      Promise.all(fetchDays.map((d) => this.syncer.ensureIntraday(d, kinds, this.#budget, { fetch }))),
    ]);
    const series = fetchDays.map((date) => ({ date, series: this.store.getIntraday(date, kinds) }));
    const table = hourlyTable(hourly, series, from, to, this.#tz);

    const results: EnsureResult[] = [...(daily?.results ?? []), ...ensured.map((r) => ({ source: r.source }))];
    const times = [...(daily?.times ?? []), ...series.flatMap((s) => s.series.map((r) => r.fetched_at))];
    let meta = this.#meta(results, times, daily?.gap);
    const notFetched = fetchDays.filter((_, i) => (ensured[i]?.missing.length ?? 0) > 0 && !ensured[i]?.blocked);
    if (!fetch && notFetched.length > 0) {
      meta = withNote(meta, `Hourly data of ${notFetched.join(', ')} is not downloaded yet: it is fetched only by an hourly question with auto fetch on (GARMIN_AUTO_FETCH), never by garmin_sync.`);
    }
    const blocked = ensured.find((r) => r.blocked)?.blocked;
    if (blocked) {
      const why = blocked.reason === 'budget' ? 'The daily Garmin request limit is used up' : 'Syncing with Garmin is paused';
      meta = withNote(meta, `${why}; hourly data that is missing or older than 15 min downloads after ${iso(blocked.resume_at)} when asked again.`);
    }
    const empty = hourly.filter((m) => !table.summary[m]?.hours_with_data);
    const notes = [
      perDay.length > 0 ? `${perDay.join(', ')} ${perDay.length > 1 ? 'have' : 'has'} no hourly values; ${perDay.length > 1 ? 'their' : 'its'} daily values are in daily.` : undefined,
      empty.length > 0 && fetchDays.length > 0 && notFetched.length === 0 && !blocked ? `Garmin has no hourly ${empty.join(', ')} for these days.` : undefined,
    ].filter((n): n is string => n !== undefined);
    return {
      data: compact({
        from,
        to,
        granularity: 'hour' as const,
        rows: table.rows,
        daily: daily?.table.rows,
        events: table.events,
        summary: { ...table.summary, ...daily?.table.summary },
        note: notes.length > 0 ? notes.join(' ') : undefined,
      }),
      meta,
    };
  }

  async getSleep(q: { date?: string; from?: string; to?: string }) {
    if (q.date) {
      const date = assertIsoDate(q.date, 'date');
      const ensured = await this.syncer.ensureDaily(['sleep'], date, date, this.#budget);
      const [row] = this.store.getDaily('sleep', date, date);
      if (!row) return { data: { date, sleep: null }, meta: this.#meta([ensured], [], this.#dailyGap('health', ['sleep'], date, date)) };
      if (!row.duration_s) return { data: { date, sleep: null, note: 'No sleep recorded for this date.' }, meta: this.#meta([ensured], [row.fetched_at]) };
      // The timeline reads only what the cache already has: no HRV request for a night without a row.
      const [hrv] = this.store.getDaily('hrv', date, date);
      return { data: compact({ ...sleepNight(row), timeline: sleepTimeline(row.raw, hrv?.raw, this.#tz) }), meta: this.#meta([ensured], [row.fetched_at]) };
    }
    const { from, to } = this.range(q.from, q.to, 7);
    const historyFrom = addDays(to, -27) < from ? addDays(to, -27) : from;
    const ensured = await this.syncer.ensureDaily(['sleep'], historyFrom, to, this.#budget);
    const rows = this.store.getDaily('sleep', from, to);
    const history = this.store.getDaily('sleep', historyFrom, to);
    const { summary, nights } = sleepRange(rows);
    return {
      data: compact({
        from,
        to,
        summary: { ...summary, duration_trend: trend(history.map((r) => ({ date: r.date, value: r.duration_s ? r.duration_s / 3600 : null })), to, 0.03, 2), score_trend: trend(history.map((r) => ({ date: r.date, value: r.score })), to, 0.03, 0) },
        nights: nights.map((n) => compact({ date: n.date, duration: n.duration, score: n.score, deep_h: n.stages_h?.deep, rem_h: n.stages_h?.rem, awake_h: n.stages_h?.awake, avg_spo2_pct: n.avg_spo2_pct, avg_respiration_brpm: n.avg_respiration_brpm, hrv_ms: n.avg_overnight_hrv_ms })),
      }),
      meta: this.#meta([{ ...ensured, coverage: this.syncer.coverage(['sleep'], from, to) }], rows.map((r) => r.fetched_at), this.#dailyGap('health', ['sleep'], from, to)),
    };
  }

  async getTrainingStatus(q: { from?: string; to?: string; include_series?: boolean }) {
    const { from, to } = this.range(q.from, q.to, 28);
    const warmup = addDays(from, -120);
    const [status, acts, metricsFetch] = await Promise.all([
      this.syncer.ensureDaily(['training_status'], addDays(to, -27) < from ? addDays(to, -27) : from, to, this.#budget),
      this.syncer.ensureActivities(warmup, to, this.#budget),
      this.syncer.ensureTrainingMetrics(to, this.#budget),
    ]);
    const statusRows = this.store.getDaily('training_status', addDays(to, -89) < from ? addDays(to, -89) : from, to);
    const activities = this.store.queryActivities({ from: warmup, to, sort: 'asc' }).map((a) => ({ date: a.date ?? '', training_load: a.training_load }));
    const metrics = this.store.latestTrainingMetrics(to);
    const overview = trainingOverview(statusRows, activities, from, to, q.include_series ?? false, metrics);
    const gap = this.#dailyGap('training', ['training_status'], from, to);
    // Race predictions, scores and records are fetched by a training sync that reaches today.
    const metricsGap = metrics ? {} : this.#gap('training', addDays(this.today(), -6), this.today(), 'race predictions, endurance/hill score, fitness age, personal records and acclimation');
    return {
      data: compact(overview),
      meta: this.#meta(
        [status, acts, metricsFetch],
        statusRows.filter((r) => r.date >= from).map((r) => r.fetched_at),
        gap.sync_hint ? gap : metricsGap.sync_hint ? metricsGap : this.#activityGap(warmup, to),
      ),
    };
  }

  async getBodyComposition(fromArg?: string, toArg?: string) {
    const { from, to } = this.range(fromArg, toArg, 90);
    const historyFrom = addDays(to, -27) < from ? addDays(to, -27) : from;
    const ensured = await this.syncer.ensureWeighIns(historyFrom, to, this.#budget);
    const rows = this.store.getBodyComposition(from, to);
    const summary = bodyComposition(rows, to, this.store.getBodyComposition(historyFrom, to));
    const gaps = this.syncer.weighInGaps(from, to);
    const gap = gaps.length ? this.#gap('health', (gaps[0] as [IsoDate, IsoDate])[0], (gaps.at(-1) as [IsoDate, IsoDate])[1], 'weigh-ins in this range') : {};
    return { data: compact({ from, to, ...summary }), meta: this.#meta([ensured], rows.map((r) => r.fetched_at), gap) };
  }

  /** Bounds of a summary period: a calendar week or month around `anchor_date`, or `from`..`to` as given. */
  #periodBounds(period: 'week' | 'month' | 'range', q: { anchor_date?: string; from?: string; to?: string }): { from: IsoDate; fullTo: IsoDate } {
    if (period !== 'range') {
      if (q.from !== undefined || q.to !== undefined) throw new InputError(`from and to apply only to period "range", not "${period}"`, 'Use anchor_date for a week or month, or period "range" with from and to.');
      const date = q.anchor_date ? assertIsoDate(q.anchor_date, 'anchor_date') : this.today();
      const from = period === 'week' ? startOfWeek(date) : startOfMonth(date);
      return { from, fullTo: period === 'week' ? addDays(from, 6) : endOfMonth(date) };
    }
    if (q.anchor_date !== undefined) throw new InputError('anchor_date applies only to period "week" or "month"', 'For period "range" give from and to.');
    if (q.from === undefined || q.to === undefined) throw new InputError('Period "range" needs both from and to', 'Example: {"period":"range","from":"2026-09-01","to":"2026-09-21"}.');
    const from = assertIsoDate(q.from, 'from');
    const fullTo = assertIsoDate(q.to, 'to');
    if (from > fullTo) throw new InputError(`from (${from}) is after to (${fullTo})`);
    if (addDays(from, MAX_PERIOD_DAYS - 1) < fullTo) throw new InputError(`Range too long; at most ${MAX_PERIOD_DAYS} days`, 'Split the request into smaller ranges.');
    return { from, fullTo };
  }

  async getPeriodSummary(period: 'week' | 'month' | 'range', q: { anchor_date?: string; from?: string; to?: string } = {}) {
    const { from, fullTo } = this.#periodBounds(period, q);
    const to = fullTo > this.today() ? this.today() : fullTo;
    if (from > to) throw new InputError('The period lies in the future');
    const warmup = addDays(from, -120);
    const [acts, health] = await Promise.all([
      this.syncer.ensureActivities(warmup, to, this.#budget),
      this.syncer.ensureDaily(['daily_summary', 'sleep', 'hrv'], from, to, this.#budget),
    ]);
    const activities = this.store.queryActivities({ from, to, sort: 'asc' });
    const daily = this.store.getDaily('daily_summary', from, to);
    const metrics: HealthMetric[] = ['sleep', 'resting_hr', 'hrv', 'steps', 'stress', 'body_battery'];
    const table = healthTable(metrics, { daily, sleep: this.store.getDaily('sleep', from, to), hrv: this.store.getDaily('hrv', from, to) }, from, to, 'day');
    const loadActs = this.store.queryActivities({ from: warmup, to, sort: 'asc' }).map((a) => ({ date: a.date ?? '', training_load: a.training_load }));
    const load = trainingOverview([], loadActs, from, to, false).garmin_load_model;
    const energy = energyBalance(daily);
    // Without synced activities an empty period would read as "no sessions, every day a rest day".
    const activitiesMissing = this.syncer.activityGaps(from, to).length > 0;
    const healthMissing = !this.syncer.coverage(['daily_summary', 'sleep', 'hrv'], from, to).complete;
    return {
      data: compact({
        period,
        from,
        to: fullTo,
        complete: to === fullTo && !activitiesMissing && !healthMissing,
        training: activitiesMissing ? undefined : periodActivitySummary(activities, from, to),
        garmin_load_model: load,
        health: Object.fromEntries(Object.entries(table.summary).map(([k, v]) => [k, { avg: v.avg, min: v.min, max: v.max, total: v.total }])),
        energy: { avg_total_kcal: energy.avg_total_kcal, avg_resting_kcal: energy.avg_resting_kcal, avg_active_kcal: energy.avg_active_kcal },
      }),
      meta: this.#meta([acts, health], [...activities.map((a) => a.fetched_at), ...daily.map((d) => d.fetched_at)], this.#periodGap(from, to)),
    };
  }

  async getEnergyBalance(fromArg?: string, toArg?: string) {
    const { from, to } = this.range(fromArg, toArg, 7);
    const ensured = await this.syncer.ensureDaily(['daily_summary'], from, to, this.#budget);
    const rows = this.store.getDaily('daily_summary', from, to);
    return { data: compact({ from, to, ...energyBalance(rows) }), meta: this.#meta([ensured], rows.map((r) => r.fetched_at), this.#dailyGap('health', ['daily_summary'], from, to)) };
  }

  // ------------------------------------------------------------ workouts

  /** Calendar range of `list_workouts`: default today + 60 days, as before date ranges existed. */
  #calendarRange(fromArg?: string, toArg?: string): { from: IsoDate; to: IsoDate } {
    const today = this.today();
    const toIn = toArg === undefined ? undefined : assertIsoDate(toArg, 'to');
    const from = fromArg !== undefined ? assertIsoDate(fromArg, 'from') : toIn !== undefined && toIn < today ? addDays(toIn, -60) : today;
    const to = toIn ?? addDays(from, 60);
    if (from > to) throw new InputError(`from (${from}) is after to (${to})`);
    if (addDays(from, MAX_RANGE_DAYS) < to) throw new InputError(`Range too long; at most ${MAX_RANGE_DAYS} days`, 'Split the request into smaller ranges.');
    return { from, to };
  }

  async listWorkouts(q: { limit?: number; sport?: string; from?: string; to?: string } = {}) {
    const { from, to } = this.#calendarRange(q.from, q.to);
    const started = this.#now();
    const ensured = await this.syncer.ensureReference('workouts', this.#budget);
    const calendar = await this.syncer.ensureCalendar(from, to, Math.max(0, this.#budget - (this.#now() - started)));
    const plan = await this.#activePlan();
    const rows = this.store.getWorkouts({ sport: q.sport, limit: Math.min(q.limit ?? 50, 200) });
    const scheduled = this.store.getSchedule(from, to);
    const events = this.store.getCalendarEvents(from, to);
    const refs = events.flatMap((e) => eventCourseRef(e.raw) ?? []);
    const courses = refs.length > 0 ? await this.#eventCourses(refs) : undefined;
    const planOf = (s: (typeof scheduled)[number]) => (plan.cached && plan.cached.id === s.raw.trainingPlanId ? plan.cached.raw : undefined);
    let meta = this.#meta(
      [ensured, calendar, ...(plan.result ? [plan.result] : []), ...(courses?.results ?? [])],
      [this.store.referenceFetchedAt('workouts'), plan.result && plan.cached?.fetched_at, ...(courses?.times ?? [])],
      this.#calendarGap(from, to),
    );
    if (plan.note) meta = withNote(meta, plan.note);
    if (courses?.note) meta = withNote(meta, courses.note);
    if (q.sport !== undefined && rows.length === 0) meta = withNote(meta, workoutSportNote(q.sport));
    return {
      data: compact({
        from,
        to,
        workouts: rows.map((w) =>
          compact({
            id: w.id,
            name: w.name,
            sport: w.sport,
            updated: w.updated_at?.slice(0, 10),
            description: w.raw.description,
            estimated_duration: hms(w.raw.estimatedDurationInSecs),
            estimated_distance_km: km(w.raw.estimatedDistanceInMeters),
          }),
        ),
        upcoming_schedule: scheduled.map((s) =>
          s.source === 'plan'
            ? compact({
                date: s.date,
                workout_id: s.workout_id,
                title: s.raw.title,
                schedule_id: s.id,
                source: s.source,
                plan_name: planName(planOf(s)),
                sport: s.raw.sportTypeKey,
                description: planWorkoutLine(planOf(s), s.date, s.raw.workoutUuid),
              })
            : compact({ date: s.date, workout_id: s.workout_id, title: s.raw.title, schedule_id: s.id, source: s.source }),
        ),
        upcoming_events: events.map((e) => {
          const ref = eventCourseRef(e.raw);
          const course = ref && (courses?.byId.get(ref.id) ?? { id: ref.id });
          return compact({
            ...calendarEvent(e.raw),
            course: course && { id: course.id, name: course.name ?? ref.name, distance_km: course.distance_km, elevation_gain_m: course.elevation_gain_m },
          });
        }),
        plan:
          plan.cached?.raw && plan.active
            ? trainingPlanBlock(plan.cached.raw, plan.active.adaptive, this.today(), this.#planEvents(plan.cached.raw))
            : undefined,
      }),
      meta,
    };
  }

  /**
   * The training plan with the nearest workout on the calendar from today on: one request (the
   * adaptive or the phased plan), fetched lazily by `list_workouts` with auto fetch on and kept
   * for the reference TTL (1 h), within the daily request limit; no sync job fetches it. A plan Garmin does not
   * give is stored as null, so it is not asked for again within the TTL.
   */
  async #activePlan(): Promise<{ active?: { id: number; adaptive: boolean }; cached?: TrainingPlanCache; result?: EnsureResult; note?: string }> {
    const [active] = this.store.plansFrom(this.today());
    if (!active) return {};
    const stored = this.store.getTrainingPlan();
    const cached = stored?.id === active.id ? stored : undefined;
    if ((cached && isFresh(cached.fetched_at, TTL.reference, this.#now())) || !(this.#autoSync || this.syncer.fetchOnDemand)) {
      return { active, cached, result: cached && { source: 'cache' } };
    }
    try {
      const res = await this.syncer.lazyRequest(`plan:${active.id}`, () =>
        active.adaptive ? this.client.getAdaptiveTrainingPlan(active.id) : this.client.getTrainingPlan(active.id),
      );
      if ('blocked' in res) {
        const why = res.blocked.reason === 'budget' ? 'The daily Garmin request limit is used up' : 'Syncing with Garmin is paused';
        return { active, cached, result: cached && { source: 'cache' }, note: `${why}; the training plan downloads after ${iso(res.blocked.resume_at)} when asked again.` };
      }
      this.store.setTrainingPlan(active.id, res.value ?? null, this.#now());
    } catch (err) {
      const info = errInfo(err);
      if (!FATAL_CODES.has(info.code)) this.store.setTrainingPlan(active.id, null, this.#now());
      return { active, cached, result: cached && { source: 'cache' }, note: `The training plan could not be downloaded (${info.code}), so its workouts come without the plan details.` };
    }
    return { active, cached: this.store.getTrainingPlan(), result: { source: 'live' } };
  }

  /** Cached races and events within the plan's dates, for its target event. */
  #planEvents(raw: unknown) {
    const p = (raw ?? {}) as { startDate?: unknown; endDate?: unknown };
    const from = typeof p.startDate === 'string' ? p.startDate.slice(0, 10) : undefined;
    const to = typeof p.endDate === 'string' ? p.endDate.slice(0, 10) : undefined;
    if (!from || !to || !isIsoDate(from) || !isIsoDate(to)) return [];
    return this.store.getCalendarEvents(from, to).map((e) => calendarEvent(e.raw));
  }

  // ------------------------------------------------------------ courses

  /**
   * The course list (no id) or one course: from the cache while younger than the reference TTL
   * (1 h), else one request within the daily request limit, made only with auto fetch on; no
   * sync job fetches courses. A failed request leaves what the cache has, with a note and the
   * error, so a read with nothing cached can throw it.
   */
  async #lazyCourse(courseId?: number): Promise<{ cached?: CourseCache; result: EnsureResult; note?: string; error?: unknown }> {
    const cached = this.store.getCourse(courseId);
    const what = courseId === undefined ? 'the course list' : `course ${courseId}`;
    if (cached && isFresh(cached.fetched_at, TTL.reference, this.#now())) return { cached, result: { source: 'cache' } };
    if (!(this.#autoSync || this.syncer.fetchOnDemand)) {
      const note = `Courses are not downloaded yet: ${what} is fetched only by a question about it with auto fetch on (GARMIN_AUTO_FETCH), never by garmin_sync.`;
      return { cached, result: { source: 'cache' }, note: cached ? undefined : note };
    }
    try {
      const res = await this.syncer.lazyRequest(courseId === undefined ? 'courses' : `course:${courseId}`, () =>
        courseId === undefined ? this.client.listCourses() : this.client.getCourse(courseId),
      );
      if ('blocked' in res) {
        const why = res.blocked.reason === 'budget' ? 'The daily Garmin request limit is used up' : 'Syncing with Garmin is paused';
        return { cached, result: { source: 'cache' }, note: `${why}; ${what} downloads after ${iso(res.blocked.resume_at)} when asked again.` };
      }
      const fresh = { raw: res.value ?? null, fetched_at: this.#now() };
      this.store.setCourse(courseId, fresh.raw, fresh.fetched_at);
      return { cached: fresh, result: { source: 'live' } };
    } catch (error) {
      const kept = cached ? `; this is the copy from ${iso(cached.fetched_at)}` : '';
      return { cached, result: { source: 'cache' }, note: `${what[0]?.toUpperCase()}${what.slice(1)} could not be downloaded (${errInfo(error).code})${kept}.`, error };
    }
  }

  /** `garmin://courses`: the account's courses in brief, newest first. */
  async listCourses() {
    const got = await this.#lazyCourse();
    if (!got.cached && got.error) throw got.error;
    const courses = compact(courseList(got.cached?.raw));
    const meta = this.#meta([got.result], [got.cached?.fetched_at]);
    // No courses is an answer: the empty list stays.
    return { data: { courses }, meta: got.note ? withNote(meta, got.note) : meta };
  }

  /**
   * `garmin://course/{id}`: one course with its profile in 20 stretches and its climbs. Positions
   * (the start and the start of every stretch) only with GARMIN_REDACT off.
   */
  async getCourse(id: number) {
    const got = await this.#lazyCourse(id);
    if (!got.cached && got.error) throw got.error;
    const notes = got.note ? [got.note] : [];
    let data: Record<string, unknown> = { id };
    if (got.cached?.raw) {
      const detail = courseDetail(got.cached.raw, { coordinates: !this.#redact, sport: this.#courseSport(id, got.cached.raw) });
      // No climbs is an answer: the empty list stays.
      data = { ...compact(detail), climbs: compact(detail.climbs) };
      if (detail.climbs.length === 0 && detail.profile.length > 0) {
        notes.push(`No climbs: a climb is at least ${CLIMB_RULES.minLengthM} m long, ${CLIMB_RULES.minAvgGradePct} % steep on average and ${CLIMB_RULES.minGainM} m high.`);
      }
      if (this.#redact) notes.push('Positions left out: GPS is removed while GARMIN_REDACT is on.');
    } else if (got.cached) {
      notes.push(`Garmin gave no details for course ${id}.`);
    }
    const meta = this.#meta([got.result], [got.cached?.fetched_at]);
    return { data, meta: notes.length > 0 ? withNote(meta, notes.join(' ')) : meta };
  }

  /** Ids of the cached course list for completing `garmin://course/{id}`; never calls Garmin. */
  courseIds(): number[] {
    return this.store.courseIds();
  }

  /** The sport of a course: from the cached list, else its type id in the cached activity types. */
  #courseSport(id: number, raw: unknown): string | undefined {
    const listed = courseList(this.store.getCourse()?.raw).find((c) => c.id === id)?.sport;
    if (listed) return listed;
    const typeId = (raw as { activityTypePk?: unknown } | null)?.activityTypePk;
    return this.store.getActivityTypes().find((t) => t.typeId === typeId)?.typeKey ?? undefined;
  }

  /**
   * The courses of calendar events in brief: from the course list, and a course not in it (a
   * race course shared by the organiser) from its own details; whatever cannot be fetched keeps
   * the id and the name the calendar gives.
   */
  async #eventCourses(refs: readonly { id: number; name?: string }[]): Promise<{ byId: Map<number, CourseBrief>; results: EnsureResult[]; times: number[]; note?: string }> {
    const list = await this.#lazyCourse();
    const byId = new Map(courseList(list.cached?.raw).map((c) => [c.id as number, c]));
    const results = [list.result];
    const times = list.cached ? [list.cached.fetched_at] : [];
    const notes = list.note ? [list.note] : [];
    for (const id of new Set(refs.map((r) => r.id))) {
      if (byId.has(id) || !list.cached) continue;
      const one = await this.#lazyCourse(id);
      results.push(one.result);
      if (one.cached) times.push(one.cached.fetched_at);
      if (one.note) notes.push(one.note);
      if (one.cached?.raw) byId.set(id, courseBriefFromDetail(one.cached.raw));
    }
    return { byId, results, times, note: notes.length > 0 ? notes.join(' ') : undefined };
  }

  /**
   * `garmin course download`: the course as a GPX file, straight from Garmin (one request), with
   * the file name Garmin gives or `course-<id>.gpx`.
   */
  async downloadCourseGpx(id: number): Promise<{ name: string; data: Uint8Array }> {
    const file = await this.client.downloadCourseGpx(id);
    const name = file.filename && /\.gpx$/i.test(file.filename) ? path.basename(file.filename) : `course-${id}.gpx`;
    return { name, data: file.data };
  }

  /**
   * `garmin course upload`: a GPX file as a new course. The cached course list is dropped, so the
   * next read of `garmin://courses` has the new course.
   */
  async uploadCourse(file: string, data: Uint8Array) {
    const saved = await this.client.uploadCourseGpx(file, data);
    this.store.forgetCourses();
    return compact({ file: path.basename(file), ...courseBriefFromDetail(saved, this.#courseSport(saved.courseId as number, saved)) });
  }

  // ------------------------------------------------------------ badges and challenges

  /**
   * Earned badges or the badge challenges in progress: from the cache while younger than the
   * reference TTL (1 h), else one request within the daily request limit, made only with auto
   * fetch on; no sync job fetches them. A failed request leaves what the cache has, with a note
   * and the error.
   */
  async #lazyBadges(kind: 'earned' | 'challenges'): Promise<{ cached?: BadgeCache; result: EnsureResult; note?: string; error?: unknown }> {
    const cached = this.store.getBadges(kind);
    const what = kind === 'earned' ? 'earned badges' : 'badge challenges';
    if (cached && isFresh(cached.fetched_at, TTL.reference, this.#now())) return { cached, result: { source: 'cache' } };
    if (!(this.#autoSync || this.syncer.fetchOnDemand)) {
      const note = 'Badges and challenges are not downloaded yet: they are fetched only by reading garmin://challenges with auto fetch on (GARMIN_AUTO_FETCH), never by garmin_sync.';
      return { cached, result: { source: 'cache' }, note: cached ? undefined : note };
    }
    try {
      const res = await this.syncer.lazyRequest(`badges:${kind}`, () => (kind === 'earned' ? this.client.getEarnedBadges() : this.client.getBadgeChallengesInProgress()));
      if ('blocked' in res) {
        const why = res.blocked.reason === 'budget' ? 'The daily Garmin request limit is used up' : 'Syncing with Garmin is paused';
        return { cached, result: { source: 'cache' }, note: `${why}; ${what} download after ${iso(res.blocked.resume_at)} when asked again.` };
      }
      const fresh = { raw: res.value ?? null, fetched_at: this.#now() };
      this.store.setBadges(kind, fresh.raw, fresh.fetched_at);
      return { cached: fresh, result: { source: 'live' } };
    } catch (error) {
      const kept = cached ? `; this is the copy from ${iso(cached.fetched_at)}` : '';
      return { cached, result: { source: 'cache' }, note: `${what[0]?.toUpperCase()}${what.slice(1)} could not be downloaded (${errInfo(error).code})${kept}.`, error };
    }
  }

  /**
   * `garmin://challenges`: how many badges are earned and the 10 latest, and the badge
   * challenges in progress with how far along they are. Either part that cannot be read leaves
   * the other with a note; both failing with nothing cached is the first error.
   */
  async getChallenges() {
    const earned = await this.#lazyBadges('earned');
    const challenges = await this.#lazyBadges('challenges');
    const failed = [earned, challenges].find((g) => !g.cached && g.error);
    if (!earned.cached && !challenges.cached && failed) throw failed.error;
    const notes = [earned.note, challenges.note].filter((n): n is string => n !== undefined);
    // No badges or no challenges is an answer: the empty lists stay; a part never downloaded is left out.
    const data: { badges?: { count: number; recent: EarnedBadge[] }; challenges?: BadgeChallenge[] } = {};
    if (earned.cached) {
      const badges = badgeSummary(earned.cached.raw);
      data.badges = { count: badges.count, recent: compact(badges.recent) };
    }
    if (challenges.cached) data.challenges = compact(challengeList(challenges.cached.raw));
    const meta = this.#meta([earned.result, challenges.result], [earned.cached?.fetched_at, challenges.cached?.fetched_at]);
    return { data, meta: notes.length > 0 ? withNote(meta, [...new Set(notes)].join(' ')) : meta };
  }

  /**
   * From the cache while the stored copy is younger than the reference TTL (1 h) and has its
   * steps; a row from the workout list has none, so that one is fetched and stored whole.
   */
  async getWorkout(id: number) {
    const row = this.store.getWorkout(id);
    if (row && Array.isArray((row.raw as { workoutSegments?: unknown }).workoutSegments) && isFresh(row.fetched_at, TTL.reference, this.#now())) {
      return { data: compact(describeWorkout(row.raw)), meta: { source: 'cache' as const, fetched_at: iso(row.fetched_at) } };
    }
    const raw = await this.client.getWorkout(id);
    const fetchedAt = this.#now();
    this.store.upsertWorkout(raw, fetchedAt);
    return { data: compact(describeWorkout(raw)), meta: { source: 'live' as const, fetched_at: iso(fetchedAt) } };
  }

  /**
   * Compile and save a workout; with `workoutId`, overwrite that one instead. The id stays,
   * so its calendar entries stay too.
   */
  async createWorkout(input: WorkoutInput, workoutId?: number) {
    const { payload } = this.#workoutPayload(input);
    if (workoutId === undefined) {
      const created = await this.client.createWorkout(payload);
      this.store.upsertWorkout(created, this.#now());
      return { data: compact({ workout_id: created.workoutId, name: created.workoutName, sport: created.sportType?.sportTypeKey }), meta: { source: 'live' as const, fetched_at: iso(this.#now()) } };
    }
    // Keep what the new definition does not set (owner, dates, description); steps and estimates come only from it.
    const { workoutSegments: _segments, estimatedDurationInSecs: _duration, estimatedDistanceInMeters: _distance, ...current } = await this.client.getWorkout(workoutId);
    await this.client.updateWorkout(workoutId, { ...current, ...payload });
    const saved = await this.client.getWorkout(workoutId);
    this.store.upsertWorkout(saved, this.#now());
    return {
      data: compact({ workout_id: workoutId, name: saved.workoutName, sport: saved.sportType?.sportTypeKey, updated: true }),
      meta: { source: 'live' as const, fetched_at: iso(this.#now()) },
    };
  }

  /**
   * What `createWorkout` would save, without sending anything to Garmin: the readable steps
   * and the estimated duration, so the model can show it and ask first (`create_workout` with `dry_run`).
   */
  async previewWorkout(input: WorkoutInput) {
    const { payload, copied } = this.#workoutPayload(input);
    const { id: _id, estimated_duration_s, ...readable } = describeWorkout(payload);
    // A copied garmin_json that carries its own estimate keeps it on Garmin.
    const given = copied && (typeof payload.estimatedDurationInSecs === 'number' || typeof payload.estimatedDuration === 'number');
    const { skipped } = estimateWorkoutDuration(payload);
    const note = given
      ? 'estimated_duration is the one given in garmin_json.'
      : skipped.length > 0
        ? `Step${skipped.length > 1 ? 's' : ''} ${skipped.join(', ')} ${skipped.length > 1 ? 'have' : 'has'} no time and no distance with a pace range, so the estimate leaves ${skipped.length > 1 ? 'them' : 'it'} out.`
        : undefined;
    return {
      data: compact({
        dry_run: true,
        ...readable,
        estimated_duration: hms(estimated_duration_s),
        estimate_note: note,
        next: 'Nothing was saved. Show this to the user and, once they agree, call create_workout with the same input without dry_run (plus workout_id when it replaces a saved workout).',
      }),
      meta: { source: 'local' as const, note: 'Preview computed locally; no request was sent to Garmin.' },
    };
  }

  /** Garmin JSON for exactly one of definition, preset or garmin_json; `copied` when it is the caller's garmin_json. */
  #workoutPayload(input: WorkoutInput): { payload: Record<string, unknown>; copied: boolean } {
    const given = (['definition', 'preset', 'garmin_json'] as const).filter((key) => input[key] !== undefined);
    if (given.length !== 1) {
      throw new InputError(
        given.length === 0 ? 'Nothing to create' : `Pass only one of ${given.join(', ')}`,
        'Pass exactly one of definition (typed steps), preset ({ name, params }) or garmin_json.',
      );
    }
    const definition = input.definition ?? (input.preset ? presetDefinition(input.preset) : undefined);
    if (definition) return { payload: compileWorkout(definition) as unknown as Record<string, unknown>, copied: false };
    if (isGarminWorkoutJson(input.garmin_json)) return { payload: input.garmin_json, copied: true };
    throw new InputError('garmin_json is not a Garmin workout', 'It needs workoutName, sportType and workoutSegments with workoutSteps.');
  }

  /** Unschedule first, so moving a workout to another day is one call. */
  async scheduleWorkouts(items: readonly { date: string; workout_id: number }[], unschedule: readonly number[] = []) {
    if (items.length === 0 && unschedule.length === 0) {
      throw new InputError('Nothing to schedule or unschedule', 'Pass items ({ date, workout_id }) and/or unschedule (schedule_id values).');
    }
    const removed = [];
    for (const scheduleId of unschedule) {
      const entry = this.store.getScheduleItem(scheduleId);
      if (entry?.source === 'plan') {
        const plan = this.store.getTrainingPlan();
        const name = plan && plan.id === entry.raw.trainingPlanId ? planName(plan.raw) : undefined;
        removed.push({
          schedule_id: scheduleId,
          ok: false,
          error: `This is a workout of the training plan${name ? ` "${name}"` : ''} (${entry.date}), not one scheduled from the library; the plan is not changed here. Move or skip it in Garmin Connect or on the watch.`,
        });
        continue;
      }
      try {
        await this.client.deleteWorkoutSchedule(scheduleId);
        this.store.deleteSchedule(scheduleId);
        removed.push({ schedule_id: scheduleId, ok: true });
      } catch (err) {
        removed.push({ schedule_id: scheduleId, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    const results = [];
    for (const it of items) {
      try {
        const date = assertIsoDate(it.date, 'date');
        const res = await this.client.scheduleWorkout(it.workout_id, date);
        const scheduleId = res?.workoutScheduleId;
        if (typeof scheduleId === 'number') this.store.addSchedule(scheduleId, it.workout_id, date, { ...res, title: res.workout?.workoutName }, this.#now());
        results.push(compact({ date, workout_id: it.workout_id, ok: true, schedule_id: scheduleId }));
      } catch (err) {
        results.push({ date: it.date, workout_id: it.workout_id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    const data = compact({
      results,
      unschedule_results: removed.length > 0 ? removed : undefined,
      scheduled: results.filter((r) => r.ok).length,
      unscheduled: removed.length > 0 ? removed.filter((r) => r.ok).length : undefined,
      failed: [...results, ...removed].filter((r) => !r.ok).length,
    });
    return { data, meta: { source: 'live' as const, fetched_at: iso(this.#now()) } };
  }

  // ------------------------------------------------------------ reference

  async getGear(includeActivities = false) {
    const ensured = await this.syncer.ensureReference('gear', this.#budget);
    const rows = this.store.getGear();
    return {
      data: {
        gear: rows.map((g) =>
          compact({
            uuid: g.uuid,
            name: g.name,
            type: g.type,
            status: g.status,
            distance_km: km(g.total_distance_m, 1),
            activities: g.raw.stats?.totalActivities ?? undefined,
            max_distance_km: km(g.raw.gear.maximumMeters, 0),
            in_use_since: g.raw.gear.dateBegin?.slice(0, 10),
            retired: g.raw.gear.dateEnd?.slice(0, 10),
            notes: g.raw.gear.notes,
            recent_activities: includeActivities ? this.store.queryActivities({ gearUuid: g.uuid, limit: 10 }).map(activityBrief) : undefined,
          }),
        ),
      },
      meta: this.#meta([ensured], [this.store.referenceFetchedAt('gear')], this.#referenceGap('gear')),
    };
  }

  async getDevices() {
    const ensured = await this.syncer.ensureReference('devices', this.#budget);
    const rows = this.store.getDevices();
    return {
      data: {
        devices: rows.map((d) =>
          compact({
            id: d.id,
            name: d.name,
            model: d.model,
            firmware: d.raw.currentFirmwareVersion,
            primary: d.raw.primaryActivityTrackerIndicator === true ? true : undefined,
            last_sync_utc: d.last_sync_utc,
            settings: deviceSettings(d.settings),
            solar: deviceSolar(d.solar),
          }),
        ),
      },
      meta: this.#meta([ensured], [this.store.referenceFetchedAt('devices')], this.#referenceGap('devices')),
    };
  }

  /**
   * Garmin's activity type keys (the values `get_activities` filters by and
   * `update_activity` accepts) with the key of their parent type.
   */
  async getActivityTypes() {
    const ensured = await this.syncer.ensureReference('activity_types', this.#budget);
    const types = this.store.getActivityTypes();
    const keyOf = new Map(types.map((t) => [t.typeId, t.typeKey]));
    return {
      data: {
        activity_types: types
          .filter((t): t is typeof t & { typeKey: string } => typeof t.typeKey === 'string' && t.typeKey !== '')
          .map((t) => compact({ key: t.typeKey, parent: t.parentTypeId == null ? undefined : (keyOf.get(t.parentTypeId) ?? undefined) }))
          .toSorted((a, b) => a.key.localeCompare(b.key)),
      },
      meta: this.#meta([ensured], [this.store.referenceFetchedAt('activity_types')], this.#referenceGap('activity_types')),
    };
  }

  async getProfile() {
    const ensured = await this.syncer.ensureReference('profile', this.#budget);
    const p = this.store.getProfile();
    const social = (p?.raw.social ?? {}) as Record<string, unknown>;
    const settings = ((p?.raw.settings ?? {}) as { userData?: Record<string, unknown> }).userData ?? {};
    const hrZones = (Array.isArray(p?.raw.heartRateZones) ? p.raw.heartRateZones : []) as Record<string, unknown>[];
    const powerZones = (Array.isArray(p?.raw.powerZones) ? p.raw.powerZones : []) as Record<string, unknown>[];
    const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
    return {
      data: compact({
        name: social.fullName,
        display_name: social.displayName,
        units: settings.measurementSystem,
        time_format: settings.timeFormat,
        timezone: this.#tz,
        gender: typeof settings.gender === 'string' ? settings.gender.toLowerCase() : undefined,
        weight_kg: round((num(settings.weight) ?? NaN) / 1000, 1),
        height_cm: num(settings.height),
        birth_date: settings.birthDate,
        vo2max: { running: num(settings.vo2MaxRunning), cycling: num(settings.vo2MaxCycling) },
        lactate_threshold_hr_bpm: num(settings.lactateThresholdHeartRate),
        hr_zones: hrZones.map((z) =>
          compact({
            sport: typeof z.sport === 'string' ? z.sport.toLowerCase() : undefined,
            method: z.trainingMethod,
            resting_hr: z.restingHeartRateUsed,
            max_hr: z.maxHeartRateUsed,
            zone_floors_bpm: [z.zone1Floor, z.zone2Floor, z.zone3Floor, z.zone4Floor, z.zone5Floor],
          }),
        ),
        power_zones: powerZones.map((z) =>
          compact({
            sport: typeof z.sport === 'string' ? z.sport.toLowerCase() : undefined,
            ftp_w: z.functionalThresholdPower,
            zone_floors_w: [z.zone1Floor, z.zone2Floor, z.zone3Floor, z.zone4Floor, z.zone5Floor, z.zone6Floor, z.zone7Floor],
          }),
        ),
      }),
      meta: this.#meta([ensured], [p?.fetched_at], this.#referenceGap('profile')),
    };
  }

  // ------------------------------------------------------------ destructive (opt-in)

  async deleteActivity(id: number) {
    await this.client.deleteActivity(id);
    this.store.deleteActivity(id);
    return { data: { deleted: true, activity_id: id }, meta: { source: 'live' as const } };
  }

  async deleteWorkout(id: number) {
    await this.client.deleteWorkout(id);
    this.store.deleteWorkout(id);
    return { data: { deleted: true, workout_id: id }, meta: { source: 'live' as const } };
  }

  async deleteWeighIn(samplePk: number, date: string) {
    await this.client.deleteWeighIn(samplePk, assertIsoDate(date, 'date'));
    this.store.deleteWeighIn(samplePk);
    return { data: { deleted: true, sample_pk: samplePk }, meta: { source: 'live' as const } };
  }
}
