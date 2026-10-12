import { InputError } from 'garmin-mcp-config';
import { describe, expect, it } from 'vitest';
import { SyncJobRunner } from './job.js';
import { Store } from './store.js';
import { Syncer } from './sync.js';
import { activity, fakeClient } from './test-utils/fake-client.js';

const NOW = Date.parse('2026-10-08T12:00:00Z');

function setup(opts: { maxRequestsPerDay?: number; fail?: string } = {}) {
  let now = NOW;
  const clock = { get: () => now, advance: (ms: number) => (now += ms) };
  const store = Store.open(':memory:');
  const err = opts.fail ? Object.assign(new Error('nope'), { code: opts.fail }) : undefined;
  let failing = Boolean(err);
  const fake = fakeClient({ activities: [activity(1, '2026-09-20')], failWith: () => (failing ? err : undefined) });
  const syncer = new Syncer(fake.client, store, { timeZone: 'UTC', now: clock.get });
  const sleeps: number[] = [];
  const runner = new SyncJobRunner(syncer, store, {
    chunkDays: 7,
    pause: { minMs: 1000, maxMs: 11_000 },
    maxRequestsPerDay: opts.maxRequestsPerDay ?? 600,
    timeZone: 'UTC',
    now: clock.get,
    random: () => 0.5,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { store, runner, clock, sleeps, calls: fake.calls, heal: () => (failing = false) };
}

describe('SyncJobRunner', () => {
  it('syncs a range in chunks, newest first, pausing only between chunks', async () => {
    const { runner, store, sleeps } = setup();
    const chunks: string[] = [];
    const report = await runner.run({
      scope: 'all',
      from: '2026-09-18',
      to: '2026-10-08',
      onProgress: (p) => p.phase === 'daily' && p.chunk && chunks.push(`${p.chunk.from}..${p.chunk.to}`),
    });
    expect(report).toMatchObject({ status: 'done', chunks_done: 3, chunks_total: 3 });
    expect(chunks).toEqual(['2026-10-02..2026-10-08', '2026-09-25..2026-10-01', '2026-09-18..2026-09-24']);
    // random() = 0.5 lands in the middle of 1-11 s.
    expect(sleeps).toEqual([6000, 6000]);
    expect(report.fetched).toMatchObject({ activities: 1, body_composition: 1, daily_summary: 21, training_status: 21 });
    expect(store.dailyFetchedAt('hrv', '2026-09-18', '2026-10-08').size).toBe(21);
    expect(store.recentSyncs(1)[0]).toMatchObject({ mode: 'job', status: 'ok' });
    expect(runner.limits().requests_today).toBe(report.requests);
  });

  it('syncs calendar months of the range with the reference scope, also in the future', async () => {
    const { runner, store, calls, clock } = setup();
    const report = await runner.run({ scope: 'reference', from: '2027-01-01', to: '2027-02-28' });
    expect(report).toMatchObject({ status: 'done', to: '2027-02-28', fetched: { workouts: 1, calendar_months: 2 } });
    expect(calls.getCalendar).toBe(5);
    expect(store.getCalendarEvents('2027-01-01', '2027-02-28').map((e) => e.date)).toEqual(['2027-01-20', '2027-02-20']);
    expect((await runner.run({ scope: 'reference', from: '2027-01-01', to: '2027-02-28' })).requests).toBe(0);
    clock.advance(60_000);
    // The reference step refetches Oct-Dec; the calendar step adds only January.
    const forced = await runner.run({ scope: 'reference', from: '2026-10-01', to: '2027-01-31', force: true });
    expect(forced.fetched).toMatchObject({ workouts: 1, calendar_months: 1 });
    expect(calls.getCalendar).toBe(9);
  });

  it('does not start the calendar step when it would overshoot the daily budget', async () => {
    const { runner, calls } = setup({ maxRequestsPerDay: 20 });
    const report = await runner.run({ scope: 'reference', from: '2025-01-01', to: '2025-12-31' });
    expect(report).toMatchObject({ status: 'budget' });
    expect(calls.getCalendar).toBe(3);
  });

  it('keeps rejecting future-only ranges for scopes without a calendar', async () => {
    const { runner } = setup();
    await expect(runner.run({ scope: 'health', from: '2026-11-01', to: '2026-11-30' })).rejects.toThrow(InputError);
  });

  it('costs nothing and does not pause when re-run over stored data', async () => {
    const { runner, sleeps } = setup();
    await runner.run({ scope: 'health', from: '2026-08-01', to: '2026-09-30' });
    sleeps.length = 0;
    const again = await runner.run({ scope: 'health', from: '2026-08-01', to: '2026-09-30' });
    expect(again).toMatchObject({ status: 'done', requests: 0 });
    expect(sleeps).toEqual([]);
  });

  it('only syncs what the scope asks for', async () => {
    const { runner, calls } = setup();
    await runner.run({ scope: 'training', from: '2026-10-01', to: '2026-10-08' });
    expect(Object.keys(calls).toSorted()).toEqual([
      'getEnduranceScore',
      'getFitnessAge',
      'getHillScore',
      'getPersonalRecords',
      'getRacePredictions',
      'getTrainingReadiness',
      'getTrainingStatus',
      'getVo2Max',
    ]);
  });

  it('counts training metrics into the cost of the chunk that reaches today', async () => {
    const { runner, store } = setup({ maxRequestsPerDay: 19 });
    // 7 days x 2 requests fit into 19, but not with 6 more for the metrics.
    const r = await runner.run({ scope: 'training', from: '2026-10-02', to: '2026-10-08' });
    expect(r).toMatchObject({ status: 'budget', requests: 0 });
    expect(store.latestTrainingMetrics('2026-10-08')).toBeUndefined();
    const older = await runner.run({ scope: 'training', from: '2026-09-25', to: '2026-10-01' });
    expect(older).toMatchObject({ status: 'done', requests: 14 });
    expect(older.fetched.training_metrics).toBeUndefined();
  });

  it('stops at the daily budget and continues the next day where it stopped', async () => {
    const { runner, clock } = setup({ maxRequestsPerDay: 40 });
    const first = await runner.run({ scope: 'health', from: '2026-09-01', to: '2026-10-08' });
    expect(first).toMatchObject({ status: 'budget', remaining: { from: '2026-09-01' } });
    expect(new Date(first.resume_at ?? 0).toISOString()).toBe('2026-10-09T00:00:00.000Z');
    clock.advance(13 * 3_600_000);
    const second = await runner.run({ scope: 'health', from: '2026-09-01', to: '2026-10-07' });
    expect(second.status).toBe('budget');
    expect(second.requests).toBeGreaterThan(0);
    expect(runner.limits().requests_today).toBeLessThanOrEqual(40);
  });

  it('pauses every job for 6 hours after a rate limit', async () => {
    const { runner, clock, heal, calls } = setup({ fail: 'RATE_LIMITED' });
    const r = await runner.run({ scope: 'health', from: '2026-10-01', to: '2026-10-08' });
    expect(r).toMatchObject({ status: 'paused', reason: expect.stringContaining('RATE_LIMITED') });
    expect((r.resume_at ?? 0) - NOW).toBe(6 * 3_600_000);
    const before = { ...calls };
    expect((await runner.run({ scope: 'activities', from: '2026-10-01', to: '2026-10-08' })).status).toBe('paused');
    expect(calls).toEqual(before);
    heal();
    clock.advance(6 * 3_600_000 + 1);
    expect((await runner.run({ scope: 'health', from: '2026-10-01', to: '2026-10-08' })).status).toBe('done');
  });

  it('can be stopped between chunks', async () => {
    const { runner } = setup();
    const ac = new AbortController();
    const r = await runner.run({
      scope: 'health',
      from: '2026-09-01',
      to: '2026-10-08',
      signal: ac.signal,
      onProgress: (p) => p.phase === 'pause' && ac.abort(),
    });
    expect(r).toMatchObject({ status: 'aborted', chunks_done: 1, remaining: { from: '2026-09-01', to: '2026-10-01' } });
  });

  it('runs one job at a time and exposes its progress', async () => {
    const { runner } = setup();
    const a = runner.start({ scope: 'health', from: '2026-10-01', to: '2026-10-08' });
    const b = runner.start({ scope: 'all', from: '2020-01-01', to: '2026-10-08' });
    expect(a).toBe(b);
    expect(runner.current()?.request.scope).toBe('health');
    await a;
    expect(runner.current()).toBeUndefined();
  });
});
