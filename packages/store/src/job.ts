import { addDays, dateIn, InputError, silentLogger, type IsoDate, type Logger, type PauseRange } from 'garmin-mcp-config';
import type { Store } from './store.js';
import {
  SCOPE_DAILY,
  scopeHasActivities,
  scopeHasReference,
  scopeHasWeighIns,
  type StepResult,
  type SyncScope,
  type Syncer,
} from './sync.js';

export interface SyncJobRequest {
  scope: SyncScope;
  from: IsoDate;
  to: IsoDate;
  /** Refetch even data that is already stored and fresh. */
  force?: boolean;
  /** Override the pause between chunks. */
  pause?: PauseRange;
  signal?: AbortSignal;
  onProgress?: (p: SyncJobProgress) => void;
}

export interface SyncJobProgress {
  phase: 'reference' | 'activities' | 'body_composition' | 'daily' | 'pause';
  chunk?: { from: IsoDate; to: IsoDate };
  chunks_done: number;
  chunks_total: number;
  requests: number;
  /** When the next chunk starts, during a pause. */
  next_at?: number;
}

export type SyncJobStatus = 'done' | 'paused' | 'budget' | 'aborted';

export interface SyncJobReport {
  id: number;
  scope: SyncScope;
  from: IsoDate;
  to: IsoDate;
  status: SyncJobStatus;
  requests: number;
  fetched: Record<string, number>;
  /** Stored items removed because Garmin no longer has them; left out when nothing was removed. */
  removed?: Record<string, number>;
  errors: { item: string; code: string; message: string }[];
  chunks_done: number;
  chunks_total: number;
  /** Part of the range not synced yet; re-run the same sync to continue. */
  remaining?: { from: IsoDate; to: IsoDate };
  /** For `paused` and `budget`: when syncing may continue. */
  resume_at?: number;
  reason?: string;
  started_at: number;
  finished_at: number;
}

export interface SyncJobOptions {
  chunkDays: number;
  /** Pause after a chunk that made requests, drawn at random from the range. */
  pause: PauseRange;
  maxRequestsPerDay: number;
  timeZone: string;
  logger?: Logger;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface SyncLimitsState {
  requests_today: number;
  max_requests_per_day: number;
  paused_until?: string;
  pause_reason?: string;
}

const HOUR = 3_600_000;
/** Pause after Garmin pushes back; long enough for rate limits to reset. */
const PAUSE_ON_RATE_LIMIT = 6 * HOUR;
const PAUSE_ON_AUTH = HOUR;
const PAUSE_ON_ERRORS = HOUR;

const abortableSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

/**
 * Explicit, user-requested sync of a scope and date range. Nothing
 * syncs on its own. Long ranges are split into chunks, newest first, with a
 * jittered pause after every chunk that actually hit Garmin; data already stored
 * is skipped, so re-running the same sync costs nothing and continues where it
 * stopped. A daily request budget and long pauses on 429/Cloudflare/auth errors
 * are shared by every job (CLI and MCP) through `meta`.
 */
export class SyncJobRunner {
  readonly #syncer: Syncer;
  readonly #store: Store;
  readonly #opts: Required<Omit<SyncJobOptions, 'logger'>>;
  readonly #log: Logger;
  #current: { request: SyncJobRequest; progress: SyncJobProgress; promise: Promise<SyncJobReport> } | undefined;

  constructor(syncer: Syncer, store: Store, options: SyncJobOptions) {
    this.#syncer = syncer;
    this.#store = store;
    this.#log = options.logger ?? silentLogger;
    const { logger: _logger, ...rest } = options;
    this.#opts = { now: Date.now, random: Math.random, sleep: abortableSleep, ...rest };
  }

  #today(): IsoDate {
    return dateIn(this.#opts.timeZone, new Date(this.#opts.now()));
  }

  #requestsToday(): number {
    return Number(this.#store.getMeta(`sync:requests:${this.#today()}`) ?? 0);
  }

  #spend(n: number): void {
    if (n > 0) this.#store.setMeta(`sync:requests:${this.#today()}`, String(this.#requestsToday() + n));
  }

  #pausedUntil(): number {
    return Number(this.#store.getMeta('sync:paused_until') ?? 0);
  }

  limits(): SyncLimitsState {
    const until = this.#pausedUntil();
    const paused = until > this.#opts.now();
    return {
      requests_today: this.#requestsToday(),
      max_requests_per_day: this.#opts.maxRequestsPerDay,
      ...(paused ? { paused_until: new Date(until).toISOString(), pause_reason: this.#store.getMeta('sync:pause_reason') } : {}),
    };
  }

  /** Clear a pause, e.g. after a fresh `garmin login`. */
  resume(): void {
    this.#store.setMeta('sync:paused_until', '0');
  }

  /** The job running in this process, if any. */
  current(): { request: Omit<SyncJobRequest, 'signal' | 'onProgress'>; progress: SyncJobProgress } | undefined {
    if (!this.#current) return undefined;
    const { signal: _s, onProgress: _p, ...request } = this.#current.request;
    return { request, progress: this.#current.progress };
  }

  /** Start a job, or join the one already running (one job at a time per process). */
  start(req: SyncJobRequest): Promise<SyncJobReport> {
    if (this.#current) return this.#current.promise;
    const progress: SyncJobProgress = { phase: 'reference', chunks_done: 0, chunks_total: 0, requests: 0 };
    const onProgress = (p: SyncJobProgress) => {
      Object.assign(progress, p);
      req.onProgress?.(p);
    };
    const promise = this.run({ ...req, onProgress }).finally(() => {
      this.#current = undefined;
    });
    this.#current = { request: req, progress, promise };
    return promise;
  }

  /** Split [from, to] into chunks, newest first. */
  chunks(from: IsoDate, to: IsoDate): { from: IsoDate; to: IsoDate }[] {
    const out: { from: IsoDate; to: IsoDate }[] = [];
    for (let end = to; end >= from; end = addDays(end, -this.#opts.chunkDays)) {
      const start = addDays(end, -(this.#opts.chunkDays - 1));
      out.push({ from: start < from ? from : start, to: end });
    }
    return out;
  }

  async run(req: SyncJobRequest): Promise<SyncJobReport> {
    const startedAt = this.#opts.now();
    const today = this.#today();
    const from = req.from;
    // Dated data (days, activities, weigh-ins) ends today; the calendar also reaches into the future.
    const calendar = scopeHasReference(req.scope);
    const datedTo = req.to > today ? today : req.to;
    const dated = from <= datedTo;
    if (from > (calendar ? req.to : datedTo)) throw new InputError(`from (${from}) is after to (${calendar ? req.to : datedTo})`);
    const to = calendar ? req.to : datedTo;
    const chunks = SCOPE_DAILY[req.scope].length && dated ? this.chunks(from, datedTo) : [];
    const fetched: Record<string, number> = {};
    const removed: Record<string, number> = {};
    const errors: SyncJobReport['errors'] = [];
    let requests = 0;
    let chunksDone = 0;
    const id = this.#store.startSync(req.scope, 'job', from, to, startedAt);
    const progress = (p: Omit<SyncJobProgress, 'chunks_done' | 'chunks_total' | 'requests'>) =>
      req.onProgress?.({ ...p, chunks_done: chunksDone, chunks_total: chunks.length, requests });

    const finish = (status: SyncJobStatus, extra: Partial<SyncJobReport> = {}): SyncJobReport => {
      const finishedAt = this.#opts.now();
      const remainingChunks = chunks.slice(chunksDone);
      const report: SyncJobReport = {
        id,
        scope: req.scope,
        from,
        to,
        status,
        requests,
        fetched,
        ...(Object.keys(removed).length ? { removed } : {}),
        errors,
        chunks_done: chunksDone,
        chunks_total: chunks.length,
        ...(status !== 'done' && remainingChunks.length
          ? { remaining: { from: (remainingChunks.at(-1) as { from: IsoDate }).from, to: (remainingChunks[0] as { to: IsoDate }).to } }
          : {}),
        started_at: startedAt,
        finished_at: finishedAt,
        ...extra,
      };
      const logStatus = status === 'done' ? (errors.length ? 'partial' : 'ok') : requests > 0 ? 'partial' : 'error';
      const removedStats = Object.fromEntries(Object.entries(removed).map(([k, v]) => [`removed_${k}`, v]));
      this.#store.finishSync(id, logStatus, finishedAt, { ...fetched, ...removedStats, requests }, report.reason ?? (errors.length ? errors.slice(0, 20).map((e) => `${e.item}: ${e.message}`).join('\n') : undefined));
      return report;
    };

    /** Check pause, budget and abort before each step; returns a stop report or undefined. */
    const gate = (): SyncJobReport | undefined => {
      if (req.signal?.aborted) return finish('aborted', { reason: 'stopped by user' });
      const paused = this.#pausedUntil();
      if (paused > this.#opts.now()) return finish('paused', { resume_at: paused, reason: this.#store.getMeta('sync:pause_reason') });
      if (this.#requestsToday() >= this.#opts.maxRequestsPerDay) {
        return finish('budget', { resume_at: this.#nextLocalMidnight(), reason: `daily budget of ${this.#opts.maxRequestsPerDay} requests used` });
      }
      return undefined;
    };

    /** Account a step; on fatal or mostly failed steps pause all syncing and stop. */
    const absorb = (res: StepResult): SyncJobReport | undefined => {
      requests += res.requests;
      this.#spend(res.requests);
      for (const [k, v] of Object.entries(res.fetched)) fetched[k] = (fetched[k] ?? 0) + v;
      for (const [k, v] of Object.entries(res.removed)) removed[k] = (removed[k] ?? 0) + v;
      errors.push(...res.errors);
      const failedShare = res.requests > 0 ? res.errors.length / res.requests : 0;
      if (!res.fatal && !(res.requests >= 4 && failedShare > 0.5)) return undefined;
      const reason = res.fatal ? `${res.fatal.code}: ${res.fatal.message}` : `${res.errors.length} of ${res.requests} requests failed`;
      const code = res.fatal?.code ?? '';
      const pause = !res.fatal ? PAUSE_ON_ERRORS : /RATE_LIMITED|CLOUDFLARE/.test(code) ? PAUSE_ON_RATE_LIMIT : PAUSE_ON_AUTH;
      const until = this.#opts.now() + pause;
      this.#store.setMeta('sync:paused_until', String(until));
      this.#store.setMeta('sync:pause_reason', reason);
      this.#log.warn({ reason, pausedHours: pause / HOUR }, 'sync paused');
      return finish('paused', { resume_at: until, reason });
    };

    const force = req.force ?? false;
    const steps: [SyncJobProgress['phase'], boolean, () => Promise<StepResult>, (() => number)?][] = [
      ['reference', calendar, () => this.#syncer.syncReference(force)],
      [
        'reference',
        calendar,
        () => this.#syncer.syncCalendar(from, req.to, force, startedAt),
        () => this.#syncer.estimateCalendarRequests(from, req.to, force, startedAt),
      ],
      ['activities', scopeHasActivities(req.scope) && dated, () => this.#syncer.syncActivities(from, datedTo, force)],
      ['body_composition', scopeHasWeighIns(req.scope) && dated, () => this.#syncer.syncWeighIns(from, datedTo, force)],
    ];
    for (const [phase, enabled, step, estimate] of steps) {
      if (!enabled) continue;
      const stop = gate();
      if (stop) return stop;
      const cost = estimate?.() ?? 0;
      if (cost > 0 && this.#requestsToday() + cost > this.#opts.maxRequestsPerDay) {
        return finish('budget', { resume_at: this.#nextLocalMidnight(), reason: `daily budget of ${this.#opts.maxRequestsPerDay} requests used` });
      }
      progress({ phase });
      const stopped = absorb(await step());
      if (stopped) return stopped;
    }

    const pause = req.pause ?? this.#opts.pause;
    for (const chunk of chunks) {
      const stop = gate();
      if (stop) return stop;
      // Never start a chunk that would overshoot the daily budget.
      const cost = this.#syncer.estimateDailyRequests(SCOPE_DAILY[req.scope], chunk.from, chunk.to, force);
      if (cost > 0 && this.#requestsToday() + cost > this.#opts.maxRequestsPerDay) {
        return finish('budget', { resume_at: this.#nextLocalMidnight(), reason: `daily budget of ${this.#opts.maxRequestsPerDay} requests used` });
      }
      progress({ phase: 'daily', chunk });
      const res = await this.#syncer.syncDaily(SCOPE_DAILY[req.scope], chunk.from, chunk.to, force);
      const stopped = absorb(res);
      if (stopped) return stopped;
      chunksDone++;
      const more = chunksDone < chunks.length;
      // Pause only after chunks that actually talked to Garmin.
      if (more && res.requests > 0 && pause.maxMs > 0) {
        const wait = pause.minMs + this.#opts.random() * (pause.maxMs - pause.minMs);
        progress({ phase: 'pause', next_at: this.#opts.now() + wait });
        await this.#opts.sleep(wait, req.signal);
      }
    }
    return finish('done');
  }

  /** First instant (to 15 min) at which the local date changes. */
  #nextLocalMidnight(): number {
    const today = this.#today();
    let t = this.#opts.now();
    while (dateIn(this.#opts.timeZone, new Date(t)) === today) t += 15 * 60_000;
    return t;
  }
}
