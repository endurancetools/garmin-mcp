import type { ActivityType, DownloadFormat, GarminClient } from 'garmin-mcp-client';
import {
  addDays,
  assertIsoDate,
  endOfMonth,
  InputError,
  silentLogger,
  startOfMonth,
  startOfWeek,
  type IsoDate,
  type Logger,
} from 'garmin-mcp-config';
import { errInfo, isFresh, SCOPE_DAILY, TTL, type DailyKind, type DetailKind, type EnsureResult, type ReferenceKind, type Store, type SyncJobProgress, type SyncJobReport, type SyncJobRunner, type SyncScope, type Syncer } from 'garmin-mcp-store';
import fs from 'node:fs';
import path from 'node:path';
import { activityBrief, periodActivitySummary } from './activities.js';
import { activityWeather, strengthSets, zoneTimes, type ActivityWeather, type StrengthSets, type ZoneTime } from './activity-extras.js';
import { bodyComposition } from './body.js';
import { calendarEvent } from './calendar.js';
import { deviceSettings } from './devices.js';
import { energyBalance } from './energy.js';
import { compact, hms, iso, km, round, speedOrPace } from './format.js';
import { healthTable, tablesFor, type HealthMetric } from './health.js';
import { decodeCursor, encodeCursor, pageBySize } from './paging.js';
import { sleepNight, sleepRange } from './sleep.js';
import { trend } from './stats.js';
import { trainingOverview } from './training.js';
import { compileWorkout, describeWorkout, estimateWorkoutDuration, isGarminWorkoutJson, presetDefinition, SPORT_KEYS, type WorkoutDefinition, type WorkoutPreset } from './workouts/index.js';
import { unzip } from './zip.js';
import { z } from 'zod';

export { InputError } from 'garmin-mcp-config';

/** Every response carries where the data came from; `local` is computed here without Garmin or the cache. */
export interface ResponseMeta {
  source: 'cache' | 'live' | 'partial' | 'local';
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
  downloadDir: string;
  logger?: Logger;
  now?: () => number;
}

const MAX_RANGE_DAYS = 366 * 3;
/** Longest `get_period_summary` range, in days including both ends. */
const MAX_PERIOD_DAYS = 366;

/** Workout input of `create_workout`: exactly one of the three forms. */
export interface WorkoutInput {
  definition?: WorkoutDefinition;
  preset?: WorkoutPreset;
  garmin_json?: Record<string, unknown>;
}

/** Optional sections `get_activity` adds to the overview, by detail level. */
interface ActivitySections {
  splits?: {
    lap?: number | null;
    distance_km?: number;
    duration?: string;
    avg_pace?: string;
    avg_speed_kmh?: number;
    avg_hr_bpm?: number;
    max_hr_bpm?: number;
    avg_power_w?: number;
    cadence_spm?: number;
    elevation_gain_m?: number;
  }[];
  hr_zones?: ZoneTime[];
  power_zones?: ZoneTime[];
  weather?: ActivityWeather;
  exercise_sets?: StrengthSets;
  raw_summary?: Record<string, unknown>;
  stream?: { metrics: string[]; total_samples: number; offset: number; samples: Record<string, unknown>[] };
  next_cursor?: string;
}

/** `get_activity` levels: the overview, one extra section, or everything incl. the raw stream. */
export type ActivityDetailLevel = 'summary' | 'splits' | 'hr_zones' | 'power_zones' | 'weather' | 'exercise_sets' | 'full';

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

  #referenceGap(kind: ReferenceKind): Partial<ResponseMeta> {
    if (this.store.referenceFetchedAt(kind) !== undefined) return {};
    const meta = this.#gap('reference', this.today(), this.today(), kind.replace('_', ' '));
    return { ...meta, sync_hint: { scope: 'reference' } };
  }

  /** The workout library and the calendar months of [from, to] come from the reference sync. */
  #calendarGap(from: IsoDate, to: IsoDate): Partial<ResponseMeta> {
    if (this.store.referenceFetchedAt('workouts') === undefined) return this.#gap('reference', from, to, `workout library and calendar ${from}..${to}`);
    const gap = this.syncer.calendarGap(from, to);
    return gap ? this.#gap('reference', gap.from, gap.to, `calendar ${gap.from}..${gap.to} (never fetched or older than 1 h)`) : {};
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
    const current = this.jobs.current();
    return {
      data: compact({
        status: report ? report.status : 'running',
        joined_running_job: running ? running.request : undefined,
        requests: report?.requests ?? current?.progress.requests,
        chunks: report ? `${report.chunks_done}/${report.chunks_total}` : current ? `${current.progress.chunks_done}/${current.progress.chunks_total}` : undefined,
        fetched: report?.fetched,
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

  async getActivities(q: { from?: string; to?: string; type?: string; limit?: number; cursor?: string; sort?: 'asc' | 'desc' }) {
    const from = q.from ? assertIsoDate(q.from, 'from') : undefined;
    const to = q.to ? assertIsoDate(q.to, 'to') : undefined;
    const ensured = await this.syncer.ensureActivities(from, to, this.#budget);
    const limit = Math.min(Math.max(q.limit ?? 20, 1), 100);
    const offset = decodeCursor(q.cursor);
    const rows = this.store.queryActivities({ from, to, type: q.type, limit: limit + 1, offset, sort: q.sort ?? 'desc' });
    const page = rows.slice(0, limit);
    const meta = this.#meta([ensured], page.map((r) => r.fetched_at), this.#activityGap(from ?? addDays(to ?? this.today(), -29), to ?? this.today()));
    return {
      data: compact({
        activities: page.map(activityBrief),
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
      const a = await this.client.getActivity(id);
      const start = typeof a.summaryDTO?.startTimeLocal === 'string' ? a.summaryDTO.startTimeLocal.slice(0, 10) : undefined;
      if (start) await this.syncer.ensureActivities(start, start, this.#budget);
      row = this.store.getActivity(id);
    }
    return row;
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
      if (!notFoundIsEmpty || errInfo(err).code !== 'NOT_FOUND') throw err;
      raw = null as T;
    }
    const at = this.#now();
    this.store.putActivityDetail(id, kind, raw, at);
    return { raw, fetched_at: at, live: true };
  }

  async getActivity(id: number, detail: ActivityDetailLevel = 'summary', cursor?: string) {
    const row = await this.#activityRow(id);
    const summary = await this.#detail(id, 'summary', () => this.client.getActivity(id));
    const s = summary.raw.summaryDTO ?? {};
    const base = compact({
      ...(row ? activityBrief(row) : { id, name: summary.raw.activityName ?? undefined }),
      description: summary.raw.description ?? undefined,
      location: summary.raw.locationName ?? undefined,
      moving_time: hms(s.movingDuration),
      elevation_loss_m: round(s.elevationLoss, 0),
      max_power_w: round(s.maxPower, 0),
      normalized_power_w: round(s.normalizedPower, 0),
      rpe: typeof s.directWorkoutRpe === 'number' ? s.directWorkoutRpe / 10 : undefined,
      feel: typeof s.directWorkoutFeel === 'number' ? s.directWorkoutFeel : undefined,
      gear_uuid: row?.gear_uuid ?? undefined,
    });
    const sources: EnsureResult[] = [{ source: summary.live ? 'live' : 'cache' }];
    const times = [summary.fetched_at];
    let extra: ActivitySections = {};

    if (detail === 'splits' || detail === 'full') {
      const splits = await this.#detail(id, 'splits', () => this.client.getActivitySplits(id));
      sources.push({ source: splits.live ? 'live' : 'cache' });
      times.push(splits.fetched_at);
      extra.splits = (splits.raw?.lapDTOs ?? []).map((l) =>
        compact({
          lap: l.lapIndex,
          distance_km: km(l.distance),
          duration: hms(l.duration),
          ...speedOrPace(row?.type, l.distance, l.duration),
          avg_hr_bpm: round(l.averageHR, 0),
          max_hr_bpm: round(l.maxHR, 0),
          avg_power_w: round(l.averagePower, 0),
          cadence_spm: round(l.averageRunCadence, 0),
          elevation_gain_m: round(l.elevationGain, 0),
        }),
      );
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
    if (detail === 'full') {
      const details = await this.#detail(id, 'details', () => this.client.getActivityDetails(id));
      sources.push({ source: details.live ? 'live' : 'cache' });
      times.push(details.fetched_at);
      const keys = (details.raw?.metricDescriptors ?? []).toSorted((a, b) => (a.metricsIndex ?? 0) - (b.metricsIndex ?? 0)).map((d) => d.key ?? `m${d.metricsIndex}`);
      const samples = (details.raw?.activityDetailMetrics ?? []).map((m) => Object.fromEntries(keys.map((k, i) => [k, m.metrics[i] ?? null])));
      const offset = decodeCursor(cursor);
      const { page, next } = pageBySize(samples, offset, 40 * 1024);
      extra = {
        ...extra,
        raw_summary: offset === 0 ? summary.raw : undefined,
        stream: { metrics: keys, total_samples: samples.length, offset, samples: page },
        next_cursor: next === undefined ? undefined : encodeCursor(next),
      };
    }
    const note = missing.length > 0 ? `Garmin has no ${missing.join(', ')} for this activity.` : undefined;
    return { data: compact({ ...base, ...extra }), meta: this.#meta(sources, times, note ? { note } : {}) };
  }

  /** Account measurement system from the cached profile, without fetching it. */
  #units(): string | undefined {
    const settings = (this.store.getProfile()?.raw.settings ?? {}) as { userData?: { measurementSystem?: unknown } };
    const units = settings.userData?.measurementSystem;
    return typeof units === 'string' ? units : undefined;
  }

  async updateActivity(id: number, patch: { name?: string; type?: string; description?: string; rpe?: number; feel?: 0 | 25 | 50 | 75 | 100 }) {
    if (Object.values(patch).every((v) => v === undefined)) throw new InputError('Nothing to update', 'Pass at least one of name, type, description, rpe, feel.');
    const activityType = patch.type === undefined ? undefined : await this.#cachedActivityType(patch.type);
    await this.client.updateActivity(id, { name: patch.name, typeKey: patch.type, activityType, description: patch.description, rpe: patch.rpe, feel: patch.feel });
    const after = await this.client.getActivity(id);
    const at = this.#now();
    this.store.applyActivityEdit(after, at);
    return this.getActivity(id, 'summary').then((r) => ({ data: { updated: true, activity: r.data }, meta: { source: 'live' as const, fetched_at: iso(at) } }));
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

  async queryHealth(metrics: readonly HealthMetric[], fromArg: string | undefined, toArg: string | undefined, granularity: 'day' | 'week' = 'day') {
    if (metrics.length === 0) throw new InputError('metrics must not be empty');
    const { from, to } = this.range(fromArg, toArg, 7);
    const historyFrom = addDays(to, -27) < from ? addDays(to, -27) : from;
    const tables = tablesFor(metrics);
    const ensured = await this.syncer.ensureDaily(tables, historyFrom, to, this.#budget);
    const load = (a: IsoDate, b: IsoDate) => ({
      daily: tables.includes('daily_summary') ? this.store.getDaily('daily_summary', a, b) : [],
      sleep: tables.includes('sleep') ? this.store.getDaily('sleep', a, b) : [],
      hrv: tables.includes('hrv') ? this.store.getDaily('hrv', a, b) : [],
    });
    const history = load(historyFrom, to);
    const inRange = load(from, to);
    const table = healthTable(metrics, inRange, from, to, granularity, history);
    const times = [...inRange.daily, ...inRange.sleep, ...inRange.hrv].map((r) => r.fetched_at);
    const cov = this.syncer.coverage(tables, from, to);
    return { data: compact({ from, to, ...table }), meta: this.#meta([{ ...ensured, coverage: cov }], times, this.#dailyGap('health', tables, from, to)) };
  }

  async getSleep(q: { date?: string; from?: string; to?: string }) {
    if (q.date) {
      const date = assertIsoDate(q.date, 'date');
      const ensured = await this.syncer.ensureDaily(['sleep'], date, date, this.#budget);
      const [row] = this.store.getDaily('sleep', date, date);
      if (!row) return { data: { date, sleep: null }, meta: this.#meta([ensured], [], this.#dailyGap('health', ['sleep'], date, date)) };
      if (!row.duration_s) return { data: { date, sleep: null, note: 'No sleep recorded for this date.' }, meta: this.#meta([ensured], [row.fetched_at]) };
      return { data: compact(sleepNight(row)), meta: this.#meta([ensured], [row.fetched_at]) };
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
    const rows = this.store.getWorkouts({ sport: q.sport, limit: Math.min(q.limit ?? 50, 200) });
    const scheduled = this.store.getSchedule(from, to);
    const events = this.store.getCalendarEvents(from, to);
    const meta = this.#meta([ensured, calendar], [this.store.referenceFetchedAt('workouts')], this.#calendarGap(from, to));
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
        upcoming_schedule: scheduled.map((s) => compact({ date: s.date, workout_id: s.workout_id, title: s.raw.title, schedule_id: s.id })),
        upcoming_events: events.map((e) => compact(calendarEvent(e.raw))),
      }),
      meta: q.sport !== undefined && rows.length === 0 ? withNote(meta, workoutSportNote(q.sport)) : meta,
    };
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
