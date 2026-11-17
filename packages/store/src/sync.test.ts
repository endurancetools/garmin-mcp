import { describe, expect, it } from 'vitest';
import { INTRADAY_KINDS, Store } from './store.js';
import { MAX_GONE_ACTIVITIES, SCOPE_DAILY, Syncer, requestCounterKey, withBudget } from './sync.js';
import { activity, fakeClient, fixture } from './test-utils/fake-client.js';

const NOW = Date.parse('2026-10-08T12:00:00Z');

function setup(opts: Parameters<typeof fakeClient>[0] & { fetchOnDemand?: boolean; maxRequestsPerDay?: number } = {}, now = () => NOW) {
  const store = Store.open(':memory:');
  const fake = fakeClient(opts);
  const syncer = new Syncer(fake.client, store, {
    timeZone: 'UTC',
    now,
    fetchOnDemand: opts.fetchOnDemand ?? false,
    ...(opts.maxRequestsPerDay !== undefined && { maxRequestsPerDay: opts.maxRequestsPerDay }),
  });
  return { store, syncer, ...fake };
}

describe('Syncer', () => {
  it('never contacts Garmin from read paths unless fetchOnDemand is on', async () => {
    const { syncer, calls } = setup({ activities: [activity(1, '2026-10-07')] });
    const daily = await syncer.ensureDaily(['sleep'], '2026-10-01', '2026-10-08', 1000);
    expect(daily).toMatchObject({ source: 'cache', coverage: { complete: false, missing: { sleep: 8 } } });
    expect(await syncer.ensureActivities(undefined, undefined, 1000)).toEqual({ source: 'cache' });
    expect(await syncer.ensureWeighIns('2026-10-01', '2026-10-08', 1000)).toEqual({ source: 'cache' });
    expect(await syncer.ensureReference('gear', 1000)).toEqual({ source: 'cache' });
    expect(calls).toEqual({});
  });

  it('fetches missing days on read paths when fetchOnDemand is on', async () => {
    const { syncer, calls } = setup({ fetchOnDemand: true });
    expect((await syncer.ensureDaily(['sleep'], '2026-10-01', '2026-10-08', 1000)).source).toBe('live');
    expect((await syncer.ensureDaily(['sleep'], '2026-10-01', '2026-10-08', 1000)).source).toBe('cache');
    expect(calls.getSleep).toBe(8);
  });

  it('stores days once and only refreshes today and yesterday after the TTL', async () => {
    let now = NOW;
    const { syncer, calls } = setup({}, () => now);
    const first = await syncer.syncDaily(['daily_summary', 'training_status'], '2026-09-01', '2026-10-08');
    expect(first.requests).toBe(38 * 3 + 6);
    expect((await syncer.syncDaily(['daily_summary', 'training_status'], '2026-09-01', '2026-10-08')).requests).toBe(0);
    now += 20 * 60_000;
    const again = await syncer.syncDaily(['daily_summary'], '2026-09-01', '2026-10-08');
    expect(again.requests).toBe(2);
    expect(calls.getDailySummary).toBe(40);
  });

  it('fetches training metrics once per TTL when a training sync reaches today', async () => {
    let now = NOW;
    const { syncer, store, calls } = setup({}, () => now);
    expect(syncer.estimateDailyRequests(['training_status'], '2026-10-02', '2026-10-08')).toBe(7 * 2 + 6);
    const first = await syncer.syncDaily(['training_status'], '2026-10-02', '2026-10-08');
    expect(first).toMatchObject({ requests: 7 * 2 + 6, fetched: { training_metrics: 1, training_status: 7 } });
    expect(calls.getHillScore).toBe(1);
    expect(store.latestTrainingMetrics('2026-10-08')).toMatchObject({
      date: '2026-10-08',
      raw: { race_predictions: { time5K: 1260 }, max_metrics: [{ heatAltitudeAcclimation: { heatAcclimationPercentage: 40 } }] },
    });
    // Within the 1 h TTL nothing is refetched; ranges that end before today never fetch metrics.
    now += 30 * 60_000;
    expect(syncer.estimateDailyRequests(['training_status'], '2026-10-08', '2026-10-08')).toBe(0);
    expect((await syncer.syncDaily(['training_status'], '2026-09-01', '2026-09-07')).fetched.training_metrics).toBeUndefined();
    expect(syncer.estimateDailyRequests(['daily_summary'], '2026-10-08', '2026-10-08')).toBe(1);
    now += 31 * 60_000;
    expect(syncer.estimateDailyRequests(['training_status'], '2026-10-08', '2026-10-08')).toBe(2 + 6);
    await syncer.syncDaily(['training_status'], '2026-10-08', '2026-10-08');
    expect(calls.getRacePredictions).toBe(2);
  });

  it('stores missing training metrics as null and keeps earlier values on other errors', async () => {
    let fail: string | undefined = 'NOT_FOUND';
    let now = NOW;
    const { syncer, store } = setup(
      { failWith: (m) => (fail && m === 'getHillScore' ? Object.assign(new Error('x'), { code: fail }) : undefined) },
      () => now,
    );
    const first = await syncer.syncDaily(['training_status'], '2026-10-08', '2026-10-08');
    expect(first.errors).toEqual([]);
    expect(store.latestTrainingMetrics('2026-10-08')?.raw.hill_score).toBeNull();
    fail = undefined;
    now += 61 * 60_000;
    await syncer.syncDaily(['training_status'], '2026-10-08', '2026-10-08');
    fail = 'VALIDATION';
    now += 61 * 60_000;
    const third = await syncer.syncDaily(['training_status'], '2026-10-08', '2026-10-08');
    expect(third.errors.map((e) => e.item)).toEqual(['training_metrics:hill_score']);
    expect(store.latestTrainingMetrics('2026-10-08')?.raw.hill_score).toMatchObject({ hillScoreDTOList: [{ overallScore: 55 }] });
  });

  it('does not store training metrics after a fatal error', async () => {
    const err = Object.assign(new Error('expired'), { code: 'AUTH_EXPIRED' });
    const { syncer, store, calls } = setup({ failWith: () => err });
    const res = await syncer.syncDaily(['training_status'], '2026-10-02', '2026-10-08');
    expect(res.fatal?.code).toBe('AUTH_EXPIRED');
    expect(calls.getTrainingStatus).toBeUndefined();
    expect(store.latestTrainingMetrics('2026-10-08')).toBeUndefined();
  });

  it('remembers any synced activity range and fetches only gaps', async () => {
    const { syncer, store, calls } = setup({ activities: [activity(1, '2024-03-05'), activity(2, '2025-06-01'), activity(3, '2026-10-07')] });
    await syncer.syncActivities('2024-01-01', '2024-12-31');
    expect(store.queryActivities().map((a) => a.id)).toEqual([1]);
    expect((await syncer.syncActivities('2024-02-01', '2024-11-30')).requests).toBe(0);
    expect(syncer.activityGaps('2023-12-01', '2025-01-31')).toEqual([
      ['2023-12-01', '2023-12-31'],
      ['2025-01-01', '2025-01-31'],
    ]);
    await syncer.syncActivities('2023-12-01', '2025-12-31');
    expect(calls.listAllActivities).toBe(3);
    expect(store.queryActivities().map((a) => a.id)).toEqual([2, 1]);
    expect(syncer.activityGaps('2023-12-01', '2025-12-31')).toEqual([]);
  });

  it('refreshes the recent activity list after its TTL even when covered', async () => {
    let now = NOW;
    const { syncer, calls } = setup({ activities: [activity(1, '2026-10-07')] }, () => now);
    await syncer.syncActivities('2026-10-01', '2026-10-08');
    expect((await syncer.syncActivities('2026-10-01', '2026-10-08')).requests).toBe(0);
    now += 16 * 60_000;
    expect((await syncer.syncActivities('2026-10-01', '2026-10-08')).requests).toBe(1);
    expect(calls.listAllActivities).toBe(2);
  });

  it('removes stored activities deleted in Garmin Connect once Garmin confirms them gone', async () => {
    const { syncer, store, calls, remove } = setup({ activities: [activity(1, '2026-09-10'), activity(2, '2026-09-10'), activity(3, '2026-09-20')] });
    await syncer.syncActivities('2026-09-01', '2026-09-30');
    remove(2);
    const res = await syncer.syncActivities('2026-09-01', '2026-09-15', true);
    expect(res).toMatchObject({ requests: 2, removed: { activities: 1 }, errors: [] });
    expect(calls.getActivity).toBe(1);
    expect(store.queryActivities().map((a) => a.id)).toEqual([3, 1]);
    // Stored but unchanged ranges are not listed again, so nothing more is checked.
    expect((await syncer.syncActivities('2026-09-01', '2026-09-30')).requests).toBe(0);
  });

  it('keeps a stored activity missing from the list while Garmin still has it or cannot say', async () => {
    let fail: string | undefined;
    const { syncer, store } = setup({
      activities: [activity(1, '2026-09-10'), activity(2, '2026-09-10')],
      unlisted: [2],
      failWith: (m) => (fail && m === 'getActivity' ? Object.assign(new Error('x'), { code: fail }) : undefined),
    });
    store.upsertActivities([activity(2, '2026-09-10')], NOW);
    expect((await syncer.syncActivities('2026-09-01', '2026-09-30')).removed).toEqual({});
    fail = 'SERVER_ERROR';
    expect(await syncer.syncActivities('2026-09-01', '2026-09-30', true)).toMatchObject({ removed: {}, errors: [] });
    fail = 'AUTH_EXPIRED';
    expect((await syncer.syncActivities('2026-09-01', '2026-09-30', true)).fatal).toMatchObject({ code: 'AUTH_EXPIRED' });
    expect(store.queryActivities().map((a) => a.id)).toEqual([2, 1]);
  });

  it('removes nothing when the list fails or leaves out too many stored activities', async () => {
    let failList = false;
    const { syncer, store, calls } = setup({ activities: [activity(1, '2026-09-10')], failWith: (m) => (failList && m === 'listAllActivities' ? new Error('x') : undefined) });
    const extra = Array.from({ length: MAX_GONE_ACTIVITIES + 1 }, (_, i) => activity(100 + i, '2026-09-11'));
    store.upsertActivities(extra, NOW);
    failList = true;
    expect((await syncer.syncActivities('2026-09-01', '2026-09-30')).errors).toHaveLength(1);
    failList = false;
    expect((await syncer.syncActivities('2026-09-01', '2026-09-30')).removed).toEqual({});
    expect(calls.getActivity).toBeUndefined();
    expect(store.queryActivities()).toHaveLength(extra.length + 1);
  });

  it('syncs weigh-ins once per range', async () => {
    const { syncer, store } = setup();
    expect((await syncer.syncWeighIns('2026-01-01', '2026-03-31')).fetched).toEqual({ body_composition: 1 });
    expect((await syncer.syncWeighIns('2026-02-01', '2026-02-28')).requests).toBe(0);
    expect(store.getBodyComposition('2026-03-31', '2026-03-31')[0]).toMatchObject({ weight_kg: 75.3 });
  });

  it('keeps device settings on a passing failure, drops them on 404 and stops on auth errors', async () => {
    let fail: string | undefined;
    const { syncer, store } = setup({ failWith: (m) => (fail && m === 'getDeviceSettings' ? Object.assign(new Error('x'), { code: fail }) : undefined) });
    await syncer.syncReference();
    const settings = () => store.getDevices()[0]?.settings;
    expect(settings()).toMatchObject({ deviceId: 7 });
    fail = 'SERVER_ERROR';
    expect((await syncer.syncReference(true)).errors).toEqual([]);
    expect(settings()).toMatchObject({ deviceId: 7 });
    fail = 'NOT_FOUND';
    await syncer.syncReference(true);
    expect(settings()).toBeNull();
    fail = 'AUTH_EXPIRED';
    const res = await syncer.syncReference(true);
    expect(res.fatal).toMatchObject({ code: 'AUTH_EXPIRED' });
    expect(res.errors.map((e) => e.item)).toEqual(['devices']);
  });

  it('syncs reference data and links gear to stored activities', async () => {
    const { syncer, store, calls } = setup({ activities: [activity(2, '2026-10-07')] });
    await syncer.syncActivities('2026-10-01', '2026-10-08');
    const res = await syncer.syncReference();
    expect(calls.getCalendar).toBe(3);
    expect(res.fetched).toEqual({ profile: 1, gear: 1, devices: 1, workouts: 1, activity_types: 1 });
    expect(store.getActivity(2)?.gear_uuid).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(store.getDevices()[0]).toMatchObject({ name: 'FR965', last_sync_utc: '2026-10-08T06:00:00Z', settings: { deviceId: 7, measurementUnits: 'metric' } });
    expect(calls.getDeviceSettings).toBe(1);
    expect(res.requests).toBe(4 + (1 + 2) + (2 + 1) + 4 + 1);
    expect(store.getActivityTypes().map((t) => t.typeKey)).toEqual(['running', 'trail_running']);
    expect(store.referenceFetchedAt('activity_types')).toBe(NOW);
    expect(store.getSchedule('2026-10-01', '2026-12-31')).toHaveLength(3);
    expect(store.getCalendarEvents('2026-10-01', '2026-12-31').map((e) => e.date)).toEqual(['2026-10-20', '2026-11-20', '2026-12-20']);
    expect((await syncer.syncReference()).requests).toBe(0);
  });

  it('tracks calendar months and fetches only missing or unfinished ones', async () => {
    let now = NOW;
    const { syncer, store, calls } = setup({}, () => now);
    await syncer.syncReference();
    expect(syncer.calendarGap('2026-10-08', '2026-12-31')).toBeUndefined();
    expect(syncer.calendarGap('2026-08-15', '2027-02-10')).toEqual({ from: '2026-08-15', to: '2027-02-10' });
    expect(syncer.calendarGap('2026-10-01', '2027-01-31')).toEqual({ from: '2027-01-01', to: '2027-01-31' });
    expect(syncer.estimateCalendarRequests('2026-08-15', '2027-02-10')).toBe(4);
    const res = await syncer.syncCalendar('2026-08-15', '2027-02-10');
    expect(res).toMatchObject({ requests: 4, fetched: { calendar_months: 4 } });
    expect(calls.getCalendar).toBe(7);
    expect(store.getCalendarEvents('2026-08-01', '2027-02-28').map((e) => e.date)).toEqual([
      '2026-08-20', '2026-09-20', '2026-10-20', '2026-11-20', '2026-12-20', '2027-01-20', '2027-02-20',
    ]);
    expect(syncer.calendarGap('2026-08-15', '2027-02-10')).toBeUndefined();
    expect((await syncer.syncCalendar('2026-08-15', '2027-02-10')).requests).toBe(0);
    // After the calendar TTL (15 min): months fetched after they ended stay final, the rest is refetched -
    // and reported as a gap, so a read's auto sync picks up a race added to a cached future month.
    now += 10 * 60_000;
    expect(syncer.calendarGap('2026-08-15', '2027-02-10')).toBeUndefined();
    now += 10 * 60_000;
    expect(syncer.calendarGap('2026-08-01', '2026-09-30')).toBeUndefined();
    expect(syncer.calendarGap('2026-08-15', '2027-02-10')).toEqual({ from: '2026-10-01', to: '2027-02-10' });
    expect((await syncer.syncCalendar('2026-08-15', '2027-02-10')).requests).toBe(5);
    expect((await syncer.syncCalendar('2026-08-15', '2027-02-10', true, now + 1)).requests).toBe(7);
  });

  it('fetches calendar months on read paths only with fetchOnDemand', async () => {
    const off = setup();
    expect(await off.syncer.ensureCalendar('2027-03-01', '2027-03-31', 1000)).toEqual({ source: 'cache' });
    expect(off.calls).toEqual({});
    const on = setup({ fetchOnDemand: true });
    expect(await on.syncer.ensureCalendar('2027-03-01', '2027-04-15', 1000)).toEqual({ source: 'live' });
    expect(await on.syncer.ensureCalendar('2027-03-01', '2027-04-15', 1000)).toEqual({ source: 'cache' });
    expect(on.calls.getCalendar).toBe(2);
  });

  it('stops at the first fatal error', async () => {
    const err = Object.assign(new Error('expired'), { code: 'AUTH_EXPIRED' });
    const { syncer, calls } = setup({ failWith: () => err, fetchOnDemand: true });
    const res = await syncer.syncDaily(['daily_summary'], '2026-01-01', '2026-10-08');
    expect(res.fatal?.code).toBe('AUTH_EXPIRED');
    expect(calls.getDailySummary).toBeLessThanOrEqual(4);
    await expect(syncer.ensureDaily(['sleep'], '2026-10-01', '2026-10-08', 1000)).rejects.toThrow('expired');
  });

  it('treats auth codes from garmin-mcp-auth as fatal', async () => {
    const err = Object.assign(new Error('no tokens'), { code: 'AUTH_NOT_LOGGED_IN' });
    const { syncer } = setup({ failWith: () => err });
    expect((await syncer.syncDaily(['sleep'], '2026-10-01', '2026-10-08')).fatal?.code).toBe('AUTH_NOT_LOGGED_IN');
  });

  it('returns partial data when the budget runs out and keeps fetching in the background', async () => {
    const { syncer, store } = setup({ delayMs: 30, fetchOnDemand: true });
    const res = await syncer.ensureDaily(['sleep'], '2026-09-01', '2026-10-08', 20);
    expect(res.source).toBe('partial');
    await new Promise((r) => setTimeout(r, 600));
    expect(store.dailyFetchedAt('sleep', '2026-09-01', '2026-10-08').size).toBe(38);
  });

  it('withBudget reports whether work finished in time', async () => {
    expect(await withBudget(Promise.resolve(), 10)).toBe(true);
    expect(await withBudget(new Promise((r) => setTimeout(r, 50)), 5)).toBe(false);
  });
});

const INTRADAY_METHODS = ['getHeartRate', 'getStress', 'getRespiration', 'getSpo2', 'getSteps', 'getBodyBattery', 'getDailyEvents', 'getHydration'];
const intradayCalls = (calls: Record<string, number>) => Object.fromEntries(Object.entries(calls).filter(([m]) => INTRADAY_METHODS.includes(m)));
const MIN = 60_000;

describe('Syncer.lazyRequest', () => {
  it('counts the request, refuses it at the daily cap or in a pause, and pauses after a fatal error', async () => {
    const { syncer, store } = setup({ maxRequestsPerDay: 2 });
    let sent = 0;
    const fetch = async () => ++sent;
    expect(await syncer.lazyRequest('fit:1', fetch)).toEqual({ value: 1 });
    expect(store.getMeta(requestCounterKey('2026-10-08'))).toBe('1');
    const limited = Object.assign(new Error('429'), { code: 'RATE_LIMITED' });
    await expect(
      syncer.lazyRequest('fit:2', async () => {
        throw limited;
      }),
    ).rejects.toThrow('429');
    expect(store.getMeta(requestCounterKey('2026-10-08'))).toBe('2');
    const until = NOW + 6 * 60 * MIN;
    expect(await syncer.lazyRequest('fit:3', fetch)).toEqual({ blocked: { reason: 'paused', resume_at: until } });
    store.setMeta('sync:paused_until', '0');
    expect(await syncer.lazyRequest('fit:3', fetch)).toEqual({ blocked: { reason: 'budget', resume_at: Date.parse('2026-10-09T00:00:00Z') } });
    expect(sent).toBe(1);
  });
});

describe('Syncer.ensureIntraday', () => {
  it('fetches nothing unless asked to (default: fetchOnDemand) and reports what is missing', async () => {
    const { syncer, calls } = setup();
    expect(await syncer.ensureIntraday('2026-10-07', ['heart_rate', 'stress'], 1000)).toEqual({ source: 'cache', missing: ['heart_rate', 'stress'] });
    expect(syncer.staleIntraday('2026-10-07', ['heart_rate', 'stress'])).toEqual(['heart_rate', 'stress']);
    expect(calls).toEqual({});
  });

  it('fetches only the missing kinds, one request each, and counts them against the day', async () => {
    const { syncer, store, calls } = setup();
    expect(await syncer.ensureIntraday('2026-10-07', ['heart_rate', 'stress'], 1000, { fetch: true })).toEqual({ source: 'live', missing: [] });
    expect(await syncer.ensureIntraday('2026-10-07', ['heart_rate', 'stress', 'steps'], 1000, { fetch: true })).toEqual({ source: 'live', missing: [] });
    expect(await syncer.ensureIntraday('2026-10-07', ['heart_rate', 'stress', 'steps'], 1000, { fetch: true })).toEqual({ source: 'cache', missing: [] });
    expect(intradayCalls(calls)).toEqual({ getHeartRate: 1, getStress: 1, getSteps: 1 });
    expect(store.getMeta(requestCounterKey('2026-10-08'))).toBe('3');
    expect(store.getIntraday('2026-10-07', ['stress', 'heart_rate'])).toEqual([
      { kind: 'stress', raw: fixture('stress-day'), fetched_at: NOW },
      { kind: 'heart_rate', raw: fixture('heart-rate-day'), fetched_at: NOW },
    ]);
  });

  it('maps every kind to its client method', async () => {
    const { syncer, store, calls } = setup({ fetchOnDemand: true });
    await syncer.ensureIntraday('2026-10-07', INTRADAY_KINDS, 1000);
    expect(intradayCalls(calls)).toEqual(Object.fromEntries(INTRADAY_METHODS.map((m) => [m, 1])));
    expect(store.getIntraday('2026-10-07').map((r) => r.kind)).toEqual([...INTRADAY_KINDS]);
    expect(store.getIntraday('2026-10-07', ['body_battery_events'])[0]?.raw).toEqual(fixture('body-battery'));
  });

  it('refreshes today after 15 min and never refetches a day fetched after it ended', async () => {
    let now = NOW;
    const { syncer, calls } = setup({ fetchOnDemand: true }, () => now);
    await syncer.ensureIntraday('2026-10-08', ['heart_rate'], 1000);
    await syncer.ensureIntraday('2026-10-07', ['heart_rate'], 1000);
    now += 10 * MIN;
    expect((await syncer.ensureIntraday('2026-10-08', ['heart_rate'], 1000)).source).toBe('cache');
    now += 10 * MIN;
    expect((await syncer.ensureIntraday('2026-10-08', ['heart_rate'], 1000)).source).toBe('live');
    expect(calls.getHeartRate).toBe(3);
    // Next day: the series fetched while 2026-10-08 was today gets one final refresh, 2026-10-07 none.
    now = Date.parse('2026-10-09T08:00:00Z');
    expect(syncer.staleIntraday('2026-10-08', ['heart_rate'])).toEqual(['heart_rate']);
    expect(syncer.staleIntraday('2026-10-07', ['heart_rate'])).toEqual([]);
    await syncer.ensureIntraday('2026-10-08', ['heart_rate'], 1000);
    now = Date.parse('2026-12-01T08:00:00Z');
    expect(syncer.staleIntraday('2026-10-08', ['heart_rate'])).toEqual([]);
    expect(calls.getHeartRate).toBe(4);
    // A future day has nothing to fetch.
    expect(await syncer.ensureIntraday('2026-12-02', ['heart_rate'], 1000)).toEqual({ source: 'cache', missing: ['heart_rate'] });
  });

  it('stores a 404 as null for good and keeps other failures out of the store', async () => {
    const notFound = Object.assign(new Error('404'), { code: 'NOT_FOUND' });
    const boom = Object.assign(new Error('500'), { code: 'SERVER_ERROR' });
    const { syncer, store, calls } = setup({ fetchOnDemand: true, failWith: (m) => (m === 'getSpo2' ? notFound : m === 'getRespiration' ? boom : undefined) });
    expect(await syncer.ensureIntraday('2026-10-07', ['spo2', 'respiration', 'steps'], 1000)).toEqual({ source: 'partial', missing: ['respiration'] });
    expect(store.getIntraday('2026-10-07', ['spo2'])).toEqual([{ kind: 'spo2', raw: null, fetched_at: NOW }]);
    await syncer.ensureIntraday('2026-10-07', ['spo2', 'respiration', 'steps'], 1000);
    expect(intradayCalls(calls)).toEqual({ getSpo2: 1, getRespiration: 2, getSteps: 1 });
    expect(store.getMeta(requestCounterKey('2026-10-08'))).toBe('4');
  });

  it('does not start a fetch that would pass the daily request cap shared with the jobs', async () => {
    const { syncer, store, calls } = setup({ fetchOnDemand: true, maxRequestsPerDay: 10 });
    store.setMeta(requestCounterKey('2026-10-08'), '8');
    expect(await syncer.ensureIntraday('2026-10-07', ['heart_rate', 'stress', 'steps'], 1000)).toEqual({
      source: 'cache',
      missing: ['heart_rate', 'stress', 'steps'],
      blocked: { reason: 'budget', resume_at: Date.parse('2026-10-09T00:00:00Z') },
    });
    expect(intradayCalls(calls)).toEqual({});
    expect((await syncer.ensureIntraday('2026-10-07', ['heart_rate', 'stress'], 1000)).source).toBe('live');
    expect(store.getMeta(requestCounterKey('2026-10-08'))).toBe('10');
  });

  it('waits out a sync pause and pauses all syncing after a fatal error', async () => {
    const limited = Object.assign(new Error('429'), { code: 'RATE_LIMITED' });
    const { syncer, store, calls } = setup({ fetchOnDemand: true, failWith: (m) => (m === 'getStress' ? limited : undefined) });
    await expect(syncer.ensureIntraday('2026-10-07', ['stress'], 1000)).rejects.toThrow('429');
    const until = NOW + 6 * 60 * MIN;
    expect(store.getMeta('sync:paused_until')).toBe(String(until));
    expect(store.getMeta('sync:pause_reason')).toBe('RATE_LIMITED: 429');
    expect(await syncer.ensureIntraday('2026-10-07', ['heart_rate'], 1000)).toEqual({ source: 'cache', missing: ['heart_rate'], blocked: { reason: 'paused', resume_at: until } });
    expect(intradayCalls(calls)).toEqual({ getStress: 1 });
  });

  it('is left out of every sync scope', async () => {
    const { syncer, calls } = setup();
    await syncer.syncDaily(SCOPE_DAILY.all, '2026-10-01', '2026-10-08');
    await syncer.syncReference();
    expect(intradayCalls(calls)).toEqual({});
  });
});
