import type { DeviceSettings, GarminClient, WeightEntry } from 'garmin-mcp-client';
import { addDays, dateIn, eachDay, endOfMonth, silentLogger, type IsoDate, type Logger } from 'garmin-mcp-config';
import { hrvColumns, dailySummaryColumns, sleepColumns, trainingColumns } from './extract.js';
import { isDayFresh, isFresh, TTL } from './freshness.js';
import { addRange, gaps, parseRangeSet, type RangeSet } from './ranges.js';
import type { DailyKind, ReferenceKind, Store, TrainingMetricsData } from './store.js';

export const SYNC_SCOPES = ['all', 'activities', 'health', 'training', 'reference'] as const;
export type SyncScope = (typeof SYNC_SCOPES)[number];

/** Which daily tables belong to which scope. */
export const SCOPE_DAILY: Record<SyncScope, DailyKind[]> = {
  all: ['daily_summary', 'sleep', 'hrv', 'training_status'],
  activities: [],
  health: ['daily_summary', 'sleep', 'hrv'],
  training: ['training_status'],
  reference: [],
};

export const scopeHasActivities = (s: SyncScope) => s === 'all' || s === 'activities';
export const scopeHasWeighIns = (s: SyncScope) => s === 'all' || s === 'health';
export const scopeHasReference = (s: SyncScope) => s === 'all' || s === 'reference';

export interface Coverage {
  from: IsoDate;
  to: IsoDate;
  /** Days missing per table. */
  missing: Partial<Record<DailyKind | 'activities' | 'body_composition', number>>;
  complete: boolean;
}

export interface StepResult {
  /** Requests issued (one per call; each list page counts). */
  requests: number;
  fetched: Record<string, number>;
  errors: { item: string; code: string; message: string }[];
  /** Set when Garmin refused further work (auth, Cloudflare, rate limit). */
  fatal: { code: string; message: string } | undefined;
}

export interface EnsureResult {
  /** cache: nothing fetched; live: fetched now; partial: time budget ran out, fetching continues. */
  source: 'cache' | 'live' | 'partial';
  coverage?: Coverage;
}

export interface SyncerOptions {
  timeZone: string;
  logger?: Logger;
  now?: () => number;
  /** Parallel day fetches; matches the client's pool so stopping on fatal errors is prompt. */
  concurrency?: number;
  /**
   * Let read paths (ensure*) fetch missing data. Off by default: Garmin is only
   * contacted by explicit sync jobs.
   */
  fetchOnDemand?: boolean;
}

export const errInfo = (err: unknown) => ({
  code: typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : 'ERROR',
  message: err instanceof Error ? err.message : String(err),
});

/** Errors that make further requests pointless (auth gone, Cloudflare wall, rate limit). */
export const FATAL_CODES = new Set([
  'UNAUTHORIZED',
  'CLOUDFLARE_BLOCKED',
  'RATE_LIMITED',
  'AUTH_EXPIRED',
  'AUTH_NOT_LOGGED_IN',
  'AUTH_CLOUDFLARE_BLOCKED',
  'AUTH_INVALID_CREDENTIALS',
]);

const emptyStep = (): StepResult => ({ requests: 0, fetched: {}, errors: [], fatal: undefined });

/**
 * Requests of one training-metrics fetch: race predictions, fitness age, personal
 * records, endurance score, hill score and maxmet (acclimation), one each.
 */
export const TRAINING_METRICS_REQUESTS = 6;
/** History fetched with endurance and hill score, ending at the sync day. */
const TRAINING_METRICS_DAYS = 28;

/**
 * Moves data from Garmin into the store. Explicit sync jobs call the `sync*`
 * methods; read paths call `ensure*`, which only fetch when `fetchOnDemand` is on.
 * Concurrent requests for the same item share one in-flight promise.
 */
export class Syncer {
  readonly #client: GarminClient;
  readonly #store: Store;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #tz: string;
  readonly #concurrency: number;
  readonly fetchOnDemand: boolean;
  readonly #inflight = new Map<string, Promise<unknown>>();

  constructor(client: GarminClient, store: Store, options: SyncerOptions) {
    this.#client = client;
    this.#store = store;
    this.#log = options.logger ?? silentLogger;
    this.#now = options.now ?? Date.now;
    this.#tz = options.timeZone;
    this.#concurrency = options.concurrency ?? 4;
    this.fetchOnDemand = options.fetchOnDemand ?? false;
  }

  today(): IsoDate {
    return dateIn(this.#tz, new Date(this.#now()));
  }

  // ------------------------------------------------------------ explicit sync steps (used by SyncJob)

  /** Activities in [from, to]: only uncovered parts, plus recent days whose list is stale. */
  async syncActivities(from: IsoDate, to: IsoDate, force = false): Promise<StepResult> {
    const ranges = this.#activityRangesToFetch(from, to, force);
    return this.#step('activities', async (res) => {
      for (const [a, b] of ranges) {
        const pages = await this.#fetchActivities(a, b);
        res.requests += pages.requests;
        res.fetched.activities = (res.fetched.activities ?? 0) + pages.count;
      }
    });
  }

  /** Weigh-ins in [from, to]; one request covers any range. */
  async syncWeighIns(from: IsoDate, to: IsoDate, force = false): Promise<StepResult> {
    if (!force && this.#weighInsCovered(from, to)) return emptyStep();
    return this.#step('body_composition', async (res) => {
      res.requests += 1;
      res.fetched.body_composition = await this.#fetchWeighIns(from, to);
    });
  }

  /** Daily tables for [from, to]; days already cached and fresh are skipped. */
  async syncDaily(kinds: readonly DailyKind[], from: IsoDate, to: IsoDate, force = false): Promise<StepResult> {
    const res = emptyStep();
    if (this.#trainingMetricsDue(kinds, to, force)) {
      await this.#fetchTrainingMetrics(res);
      if (res.fatal) return res;
    }
    const tasks = this.#staleDays(kinds, from, to, force);
    await pool(tasks, this.#concurrency, () => res.fatal !== undefined, async ({ kind, date }) => {
      res.requests += kind === 'training_status' ? 2 : 1;
      try {
        await this.#fetchDay(kind, date);
        res.fetched[kind] = (res.fetched[kind] ?? 0) + 1;
      } catch (err) {
        this.#fail(res, `${kind}:${date}`, err);
      }
    });
    return res;
  }

  /**
   * Profile, gear, devices, workouts and activity types (current state, not date based). Per-item
   * requests (gear stats and activities, device settings) are counted after the
   * fact; this step runs once per job, outside the daily chunks.
   */
  async syncReference(force = false): Promise<StepResult> {
    const res = emptyStep();
    const cost: Record<ReferenceKind, number> = { profile: 4, gear: 1, devices: 2, workouts: 4, activity_types: 1 };
    const perItem: Partial<Record<ReferenceKind, () => number>> = {
      gear: () => 2 * this.#store.getGear().length,
      devices: () => this.#store.getDevices().length,
    };
    for (const kind of ['profile', 'gear', 'devices', 'workouts', 'activity_types'] as const) {
      if (res.fatal) break;
      try {
        if (await this.#refreshReference(kind, force)) {
          res.requests += cost[kind] + (perItem[kind]?.() ?? 0);
          res.fetched[kind] = 1;
        }
      } catch (err) {
        this.#fail(res, kind, err);
      }
    }
    return res;
  }

  /**
   * Calendar months touching [from, to] (scheduled workouts, races, events): one
   * request per month that was never fetched or is not final yet (see #staleMonths).
   * With `force`, months fetched before `since` are fetched again, so a job does not
   * repeat months its own reference step has just refreshed.
   */
  async syncCalendar(from: IsoDate, to: IsoDate, force = false, since = this.#now()): Promise<StepResult> {
    const res = emptyStep();
    for (const month of this.#staleMonths(from, to, force, since)) {
      if (res.fatal) break;
      res.requests += 1;
      try {
        await this.#fetchMonth(month);
        res.fetched.calendar_months = (res.fetched.calendar_months ?? 0) + 1;
      } catch (err) {
        this.#fail(res, `calendar:${month}`, err);
      }
    }
    return res;
  }

  estimateCalendarRequests(from: IsoDate, to: IsoDate, force = false, since = this.#now()): number {
    return this.#staleMonths(from, to, force, since).length;
  }

  /** How many requests syncing [from, to] of `kinds` would take right now. */
  estimateDailyRequests(kinds: readonly DailyKind[], from: IsoDate, to: IsoDate, force = false): number {
    const metrics = this.#trainingMetricsDue(kinds, to, force) ? TRAINING_METRICS_REQUESTS : 0;
    return this.#staleDays(kinds, from, to, force).reduce((n, t) => n + (t.kind === 'training_status' ? 2 : 1), metrics);
  }

  async #step(item: string, fn: (res: StepResult) => Promise<void>): Promise<StepResult> {
    const res = emptyStep();
    try {
      await fn(res);
    } catch (err) {
      this.#fail(res, item, err);
    }
    return res;
  }

  #fail(res: StepResult, item: string, err: unknown): void {
    const info = errInfo(err);
    if (FATAL_CODES.has(info.code)) res.fatal ??= info;
    res.errors.push({ item, ...info });
    this.#log.warn({ item, err: info }, 'sync item failed');
  }

  // ------------------------------------------------------------ read paths for tools

  /**
   * Make sure the daily tables cover [from, to]. Without `fetchOnDemand` this only
   * reports coverage. Otherwise it fetches missing days and waits at most
   * `budgetMs`; whatever is left keeps running.
   */
  async ensureDaily(kinds: readonly DailyKind[], from: IsoDate, to: IsoDate, budgetMs: number): Promise<EnsureResult> {
    const coverageNow = () => this.coverage(kinds, from, to);
    if (!this.fetchOnDemand) return { source: 'cache', coverage: coverageNow() };
    const tasks = this.#staleDays(kinds, from, to, false);
    if (tasks.length === 0) return { source: 'cache', coverage: coverageNow() };
    let fatalError: unknown;
    const work = pool(tasks, this.#concurrency, () => fatalError !== undefined, async ({ kind, date }) => {
      try {
        await this.#fetchDay(kind, date);
      } catch (err) {
        if (FATAL_CODES.has(errInfo(err).code)) fatalError ??= err;
        else this.#log.warn({ kind, date, err: errInfo(err) }, 'on-demand fetch failed');
      }
    });
    const finished = await withBudget(work, budgetMs);
    const coverage = coverageNow();
    if (!finished) return { source: 'partial', coverage };
    // Expired auth or a Cloudflare wall must reach the model instead of silently stale data.
    if (fatalError !== undefined && !coverage.complete) throw fatalError;
    return { source: coverage.complete ? 'live' : 'partial', coverage };
  }

  async ensureActivities(from: IsoDate | undefined, to: IsoDate | undefined, budgetMs: number): Promise<EnsureResult> {
    if (!this.fetchOnDemand) return { source: 'cache' };
    const end = to ?? this.today();
    const ranges = this.#activityRangesToFetch(from ?? addDays(end, -29), end, false);
    if (ranges.length === 0) return { source: 'cache' };
    const work = this.#dedupe(`activities:${JSON.stringify(ranges)}`, async () => {
      for (const [a, b] of ranges) await this.#fetchActivities(a, b);
    });
    return { source: (await withBudget(work, budgetMs)) ? 'live' : 'partial' };
  }

  async ensureWeighIns(from: IsoDate, to: IsoDate, budgetMs: number): Promise<EnsureResult> {
    if (!this.fetchOnDemand || this.#weighInsCovered(from, to)) return { source: 'cache' };
    const work = this.#dedupe(`weighins:${from}:${to}`, () => this.#fetchWeighIns(from, to));
    return { source: (await withBudget(work, budgetMs)) ? 'live' : 'partial' };
  }

  async ensureReference(kind: ReferenceKind, budgetMs: number): Promise<EnsureResult> {
    if (!this.fetchOnDemand || isFresh(this.#store.referenceFetchedAt(kind), TTL.reference, this.#now())) return { source: 'cache' };
    const work = this.#dedupe(`ref:${kind}`, () => this.#refreshReference(kind, true));
    return { source: (await withBudget(work, budgetMs)) ? 'live' : 'partial' };
  }

  /** Calendar months of [from, to] that are missing or not final, fetched only with `fetchOnDemand`. */
  async ensureCalendar(from: IsoDate, to: IsoDate, budgetMs: number): Promise<EnsureResult> {
    const months = this.fetchOnDemand ? this.#staleMonths(from, to, false, 0) : [];
    if (months.length === 0) return { source: 'cache' };
    const work = Promise.all(months.map((m) => this.#fetchMonth(m)));
    return { source: (await withBudget(work, budgetMs)) ? 'live' : 'partial' };
  }

  /** Training metrics for today, fetched only with `fetchOnDemand` and when older than the TTL. */
  async ensureTrainingMetrics(to: IsoDate, budgetMs: number): Promise<EnsureResult> {
    if (!this.fetchOnDemand || !this.#trainingMetricsDue(['training_status'], to, false)) return { source: 'cache' };
    const work = this.#dedupe('training_metrics', async () => {
      const res = emptyStep();
      await this.#fetchTrainingMetrics(res);
      if (res.fatal) this.#log.warn({ err: res.fatal }, 'on-demand training metrics fetch failed');
    });
    return { source: (await withBudget(work, budgetMs)) ? 'live' : 'partial' };
  }

  coverage(kinds: readonly DailyKind[], from: IsoDate, to: IsoDate): Coverage {
    const end = to > this.today() ? this.today() : to;
    const days = from <= end ? eachDay(from, end).length : 0;
    const missing: Coverage['missing'] = {};
    for (const kind of kinds) {
      const have = this.#store.dailyFetchedAt(kind, from, end).size;
      if (have < days) missing[kind] = days - have;
    }
    return { from, to, missing, complete: Object.keys(missing).length === 0 };
  }

  /** Date ranges with no activity list fetched yet. */
  activityGaps(from: IsoDate, to: IsoDate): RangeSet {
    return gaps(this.#ranges('activities'), from, to > this.today() ? this.today() : to);
  }

  weighInGaps(from: IsoDate, to: IsoDate): RangeSet {
    return gaps(this.#ranges('weighins'), from, to > this.today() ? this.today() : to);
  }

  /** The part of [from, to] whose calendar months were never fetched: first to last missing month, clipped to the range. */
  calendarGap(from: IsoDate, to: IsoDate): { from: IsoDate; to: IsoDate } | undefined {
    const fetched = this.#calendarMonths();
    const missing = monthsIn(from, to).filter((m) => fetched[m] === undefined);
    if (missing.length === 0) return undefined;
    const start = `${missing[0] as string}-01` as IsoDate;
    const end = endOfMonth(`${missing.at(-1) as string}-01` as IsoDate);
    return { from: start < from ? from : start, to: end > to ? to : end };
  }

  // ------------------------------------------------------------ internals

  /** Month (YYYY-MM) → when its calendar was fetched. */
  #calendarMonths(): Record<string, number> {
    try {
      const parsed: unknown = JSON.parse(this.#store.getMeta('calendar:months') ?? '{}');
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, number>) : {};
    } catch {
      return {};
    }
  }

  #markMonths(months: readonly string[], at: number): void {
    const all = this.#calendarMonths();
    for (const m of months) all[m] = at;
    this.#store.setMeta('calendar:months', JSON.stringify(all));
  }

  /**
   * Months to fetch: never fetched; with `force`, fetched before `since`; otherwise
   * like days: a month fetched after it ended is final, any other month
   * (current, future, or cached while it was running) goes stale after the reference TTL.
   */
  #staleMonths(from: IsoDate, to: IsoDate, force: boolean, since: number): string[] {
    const fetched = this.#calendarMonths();
    const now = this.#now();
    return monthsIn(from, to).filter((m) => {
      const at = fetched[m];
      if (at === undefined) return true;
      if (force) return at < since;
      const end = endOfMonth(`${m}-01` as IsoDate);
      if (dateIn(this.#tz, new Date(at)) > end) return false;
      return !isFresh(at, TTL.reference, now);
    });
  }

  #fetchMonth(month: string): Promise<void> {
    return this.#dedupe(`calendar:${month}`, async () => {
      const startedAt = this.#now();
      const [year, mon] = month.split('-').map(Number) as [number, number];
      const cal = await this.#client.getCalendar(year, mon);
      const first = `${month}-01` as IsoDate;
      this.#store.replaceSchedule(first, endOfMonth(first), cal?.calendarItems ?? [], this.#now());
      this.#markMonths([month], startedAt);
    });
  }

  #ranges(kind: 'activities' | 'weighins'): RangeSet {
    return parseRangeSet(this.#store.getMeta(`${kind}:covered`));
  }

  #markCovered(kind: 'activities' | 'weighins', from: IsoDate, to: IsoDate): void {
    this.#store.setMeta(`${kind}:covered`, JSON.stringify(addRange(this.#ranges(kind), from, to)));
  }

  /** Uncovered parts of [from, to]; plus recent days when the list is older than its TTL. */
  #activityRangesToFetch(from: IsoDate, to: IsoDate, force: boolean): RangeSet {
    const today = this.today();
    const end = to > today ? today : to;
    if (from > end) return [];
    if (force) return [[from, end]];
    let ranges = gaps(this.#ranges('activities'), from, end);
    const yesterday = addDays(today, -1);
    if (end >= yesterday && !isFresh(this.#store.getMetaNumber('activities:listed_at'), TTL.activityList, this.#now())) {
      const recentFrom = from > yesterday ? from : yesterday;
      ranges = addRange(ranges, recentFrom, end);
    }
    return ranges;
  }

  async #fetchActivities(from: IsoDate, to: IsoDate): Promise<{ count: number; requests: number }> {
    const startedAt = this.#now();
    let count = 0;
    let requests = 0;
    await this.#client.listAllActivities({ from, to, pageSize: 100 }, (page) => {
      requests++;
      this.#store.upsertActivities(page, this.#now());
      count += page.length;
    });
    this.#markCovered('activities', from, to);
    if (to >= addDays(this.today(), -1)) this.#store.setMeta('activities:listed_at', String(startedAt));
    return { count, requests: Math.max(requests, 1) };
  }

  /** Covered and, for ranges reaching yesterday or today, fetched within the TTL. */
  #weighInsCovered(from: IsoDate, to: IsoDate): boolean {
    if (gaps(this.#ranges('weighins'), from, to > this.today() ? this.today() : to).length > 0) return false;
    if (to < addDays(this.today(), -1)) return true;
    return isFresh(this.#store.getMetaNumber('weighins:fetched_at'), TTL.recentDay, this.#now());
  }

  async #fetchWeighIns(from: IsoDate, to: IsoDate): Promise<number> {
    const startedAt = this.#now();
    const res = await this.#client.getWeighIns(from, to);
    const entries: WeightEntry[] = [];
    for (const day of res?.dailyWeightSummaries ?? []) {
      const all = day.allWeightMetrics?.length ? day.allWeightMetrics : day.latestWeight ? [day.latestWeight] : [];
      entries.push(...all);
    }
    this.#store.replaceWeighIns(from, to, entries, startedAt);
    this.#markCovered('weighins', from, to);
    if (to >= addDays(this.today(), -1)) this.#store.setMeta('weighins:fetched_at', String(startedAt));
    return entries.length;
  }

  #staleDays(kinds: readonly DailyKind[], from: IsoDate, to: IsoDate, force: boolean): { kind: DailyKind; date: IsoDate }[] {
    const today = this.today();
    const end = to > today ? today : to;
    const now = this.#now();
    const out: { kind: DailyKind; date: IsoDate }[] = [];
    for (const kind of kinds) {
      const fetched = this.#store.dailyFetchedAt(kind, from, end);
      for (const date of eachDay(from, end)) {
        if (force || !isDayFresh(kind, date, fetched.get(date), now, this.#tz)) out.push({ kind, date });
      }
    }
    // Newest first: recent days matter most when the budget runs out.
    return out.toSorted((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }

  /**
   * Training metrics describe the current state, so they are fetched with the
   * training scope only when the range reaches today, at most once per TTL.
   */
  #trainingMetricsDue(kinds: readonly DailyKind[], to: IsoDate, force: boolean): boolean {
    const today = this.today();
    if (!kinds.includes('training_status') || to < today) return false;
    if (force) return true;
    const row = this.#store.latestTrainingMetrics(today);
    return row?.date !== today || !isFresh(row.fetched_at, TTL.trainingToday, this.#now());
  }

  /**
   * One request per metric. A 404 means Garmin has no such data for the account
   * (no hill score without trail runs, for example) and is stored as null; other
   * failures keep the value from an earlier fetch of the same day.
   */
  async #fetchTrainingMetrics(res: StepResult): Promise<void> {
    const c = this.#client;
    const today = this.today();
    const from = addDays(today, -(TRAINING_METRICS_DAYS - 1));
    const calls: Record<keyof TrainingMetricsData, () => Promise<unknown>> = {
      race_predictions: () => c.getRacePredictions(),
      fitness_age: () => c.getFitnessAge(today),
      personal_records: () => c.getPersonalRecords(),
      endurance_score: () => c.getEnduranceScore(from, today),
      hill_score: () => c.getHillScore(from, today),
      max_metrics: () => c.getVo2Max(today),
    };
    const keys = Object.keys(calls) as (keyof TrainingMetricsData)[];
    res.requests += keys.length;
    const settled = await Promise.allSettled(keys.map((k) => calls[k]()));
    const previous = this.#store.latestTrainingMetrics(today);
    const kept = previous?.date === today ? previous.raw : undefined;
    const raw = {} as TrainingMetricsData;
    settled.forEach((r, i) => {
      const key = keys[i] as keyof TrainingMetricsData;
      if (r.status === 'fulfilled') raw[key] = r.value ?? null;
      else if (errInfo(r.reason).code === 'NOT_FOUND') raw[key] = null;
      else {
        raw[key] = kept?.[key] ?? null;
        this.#fail(res, `training_metrics:${key}`, r.reason);
      }
    });
    if (res.fatal) return;
    this.#store.putTrainingMetrics(today, raw, this.#now());
    res.fetched.training_metrics = (res.fetched.training_metrics ?? 0) + 1;
  }

  #dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.#inflight.get(key);
    if (existing) return existing as Promise<T>;
    const p = fn().finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, p);
    return p;
  }

  #fetchDay(kind: DailyKind, date: IsoDate): Promise<void> {
    return this.#dedupe(`${kind}:${date}`, async () => {
      const c = this.#client;
      switch (kind) {
        case 'daily_summary': {
          const raw = await c.getDailySummary(date);
          this.#store.putDaily(kind, date, dailySummaryColumns(raw), raw, this.#now());
          return;
        }
        case 'sleep': {
          const raw = await c.getSleep(date);
          this.#store.putDaily(kind, date, sleepColumns(raw), raw, this.#now());
          return;
        }
        case 'hrv': {
          const raw = await c.getHrv(date);
          this.#store.putDaily(kind, date, hrvColumns(raw), raw, this.#now());
          return;
        }
        case 'training_status': {
          const [status, readiness] = await Promise.all([c.getTrainingStatus(date), c.getTrainingReadiness(date)]);
          this.#store.putDaily(kind, date, trainingColumns(status, readiness), { status, readiness }, this.#now());
          return;
        }
      }
    });
  }

  /**
   * Settings of each device, one request per device. 404 means the device has none.
   * Other failures keep what the store had, unless they stop all requests (auth,
   * Cloudflare, rate limit), which fail the whole devices refresh.
   */
  async #deviceSettings(ids: readonly number[]): Promise<Map<number, DeviceSettings | null>> {
    const kept = new Map(this.#store.getDevices().map((d) => [d.id, d.settings]));
    const out = new Map<number, DeviceSettings | null>();
    const settled = await Promise.allSettled(ids.map((id) => this.#client.getDeviceSettings(id)));
    for (const [i, r] of settled.entries()) {
      const id = ids[i] as number;
      if (r.status === 'fulfilled') {
        out.set(id, r.value ?? null);
        continue;
      }
      const info = errInfo(r.reason);
      if (FATAL_CODES.has(info.code)) throw r.reason;
      if (info.code === 'NOT_FOUND') {
        out.set(id, null);
        continue;
      }
      out.set(id, kept.get(id) ?? null);
      this.#log.warn({ item: `device_settings:${id}`, err: info }, 'sync item failed');
    }
    return out;
  }

  async #refreshReference(kind: ReferenceKind, force: boolean): Promise<boolean> {
    const now = this.#now();
    if (!force && isFresh(this.#store.referenceFetchedAt(kind), TTL.reference, now)) return false;
    const c = this.#client;
    switch (kind) {
      case 'profile': {
        const [social, settings, heartRateZones, powerZones] = await Promise.all([
          c.getProfile(),
          c.getUserSettings(),
          c.getHeartRateZones().catch(() => null),
          c.getPowerZones().catch(() => null),
        ]);
        this.#store.setProfile({ social, settings, heartRateZones, powerZones }, now);
        break;
      }
      case 'gear': {
        const gear = await c.listGear();
        const items = await Promise.all(gear.map(async (g) => ({ gear: g, stats: await c.getGearStats(g.uuid) })));
        this.#store.replaceGear(items, now);
        await Promise.all(
          gear.map(async (g) => {
            const acts = await c.getGearActivities(g.uuid);
            this.#store.setActivityGear(
              acts.map((a) => a.activityId),
              g.uuid,
            );
          }),
        );
        break;
      }
      case 'devices': {
        const [devices, lastUsed] = await Promise.all([c.listDevices(), c.getLastUsedDevice().catch(() => null)]);
        this.#store.replaceDevices(devices, lastUsed, now, await this.#deviceSettings(devices.map((d) => d.deviceId)));
        break;
      }
      case 'workouts': {
        const workouts = await c.listWorkouts(0, 200);
        this.#store.replaceWorkouts(workouts, now);
        const today = this.today();
        const months = [0, 1, 2].map((i) => {
          const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
          d.setUTCMonth(d.getUTCMonth() + i);
          return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
        });
        const calendars = await Promise.all(months.map((m) => c.getCalendar(m.year, m.month)));
        const first = `${today.slice(0, 7)}-01`;
        const last = months.at(-1) as { year: number; month: number };
        const end = new Date(Date.UTC(last.year, last.month, 0)).toISOString().slice(0, 10);
        this.#store.replaceSchedule(first, end, calendars.flatMap((cal) => cal?.calendarItems ?? []), now);
        this.#markMonths(monthsIn(first, end), now);
        break;
      }
      case 'activity_types':
        this.#store.setActivityTypes(await c.getActivityTypes());
        break;
    }
    this.#store.markReferenceFetched(kind, now);
    return true;
  }
}

/** Months (YYYY-MM) touching [from, to], oldest first. */
export function monthsIn(from: IsoDate, to: IsoDate): string[] {
  const out: string[] = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number) as [number, number];
  const last = to.slice(0, 7);
  for (;;) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    if (key > last) return out;
    out.push(key);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
}

/** Resolve true if `work` settles within `ms`; otherwise false while `work` keeps running. */
export async function withBudget(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref();
  });
  try {
    return await Promise.race([work.then(() => true as const, () => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Run `fn` over `items` with `n` workers; stops picking new items once `stop()` is true. */
export async function pool<T>(items: readonly T[], n: number, stop: () => boolean, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stop()) {
      const item = items[next++] as T;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
}
