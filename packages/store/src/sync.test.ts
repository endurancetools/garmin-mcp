import { describe, expect, it } from 'vitest';
import { Store } from './store.js';
import { Syncer, withBudget } from './sync.js';
import { activity, fakeClient } from './test-utils/fake-client.js';

const NOW = Date.parse('2026-10-08T12:00:00Z');

function setup(opts: Parameters<typeof fakeClient>[0] & { fetchOnDemand?: boolean } = {}, now = () => NOW) {
  const store = Store.open(':memory:');
  const fake = fakeClient(opts);
  const syncer = new Syncer(fake.client, store, { timeZone: 'UTC', now, fetchOnDemand: opts.fetchOnDemand ?? false });
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
    // After the reference TTL: months fetched after they ended stay final, the rest is refetched.
    now += 2 * 3_600_000;
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
