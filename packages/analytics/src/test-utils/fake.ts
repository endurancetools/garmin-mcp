import { eachDay, type IsoDate } from 'garmin-mcp-config';
import { GarminService } from 'garmin-mcp-domain';
import { addRange, parseRangeSet, Store, Syncer, SyncJobRunner, type DailyKind } from 'garmin-mcp-store';
import os from 'node:os';
import { AnalyticsService } from '../service.js';

/** 2026-10-08 12:00 UTC; the fake account lives in UTC. */
export const NOW = Date.parse('2026-10-08T12:00:00Z');
export const TODAY = '2026-10-08';

type Summary = Parameters<Store['upsertActivities']>[0][number];

/** A synthetic Garmin activity list entry (running, 1 h, 10 km, 150 bpm, load 100 unless overridden). */
export function activity(id: number, date: IsoDate, extra: Record<string, unknown> = {}): Summary {
  return {
    activityId: id,
    activityName: `Run ${date}`,
    startTimeLocal: `${date} 07:00:00`,
    startTimeGMT: `${date} 07:00:00`,
    activityType: { typeId: 1, typeKey: 'running' },
    distance: 10_000,
    duration: 3600,
    averageHR: 150,
    activityTrainingLoad: 100,
    ...extra,
  } as Summary;
}

/**
 * An analytics service over an in-memory store whose Garmin client fails every call: the
 * tests seed synthetic rows and never reach Garmin (on-demand fetching off).
 */
export function setup(opts: { autoSync?: boolean } = {}) {
  const calls: string[] = [];
  const client = new Proxy(
    {},
    {
      get: (_, name) =>
        name === 'then'
          ? undefined
          : () => {
              calls.push(String(name));
              return Promise.reject(new Error(`Unexpected Garmin call: ${String(name)}`));
            },
    },
  );
  const store = Store.open(':memory:');
  const syncer = new Syncer(client as never, store, { timeZone: 'UTC', now: () => NOW, fetchOnDemand: false });
  const jobs = new SyncJobRunner(syncer, store, { chunkDays: 7, pause: { minMs: 0, maxMs: 0 }, maxRequestsPerDay: 10_000, timeZone: 'UTC', now: () => NOW });
  const garmin = new GarminService({
    client: client as never,
    store,
    syncer,
    jobs,
    timeZone: 'UTC',
    downloadDir: os.tmpdir(),
    budgetMs: 200,
    autoSync: opts.autoSync ?? false,
    now: () => NOW,
  });
  const analytics = new AnalyticsService(garmin, { budgetMs: 200, now: () => NOW });

  return {
    store,
    garmin,
    analytics,
    calls,
    /** Stores activities and marks [from, to] as synced (`activities:covered`). */
    activities(list: readonly Summary[], from: IsoDate, to: IsoDate) {
      store.upsertActivities(list, NOW);
      store.setMeta('activities:covered', JSON.stringify(addRange(parseRangeSet(store.getMeta('activities:covered')), from, to)));
    },
    /** One daily row per day of [from, to]; `columns` may depend on the date. */
    daily(kind: DailyKind, from: IsoDate, to: IsoDate, columns: (date: IsoDate) => Record<string, unknown>, raw: (date: IsoDate) => unknown = () => ({})) {
      for (const d of eachDay(from, to)) store.putDaily(kind, d, columns(d), raw(d), NOW);
    },
    /** Runs every day of [from, to] with ids from `firstId`. */
    dailyRuns(from: IsoDate, to: IsoDate, firstId = 1, extra: Record<string, unknown> = {}): Summary[] {
      return eachDay(from, to).map((d, i) => activity(firstId + i, d, extra));
    },
  };
}
