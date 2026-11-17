import { describe, expect, it } from 'vitest';
import { MAX_STAGE_SEGMENTS, sleepTimeline } from './sleep.js';
import { fixture } from './test-utils/fake.js';

const sleep = fixture('sleep') as Record<string, unknown>;
const hrv = fixture('hrv');

describe('sleepTimeline', () => {
  it('reads the recorded night in the user time zone', () => {
    const t = sleepTimeline(sleep, hrv, 'Europe/Warsaw');
    expect(t?.stages).toHaveLength(17);
    expect(t?.stages?.slice(0, 3)).toEqual([
      { from: '23:13', to: '23:32', stage: 'light' },
      { from: '23:32', to: '23:42', stage: 'deep' },
      { from: '23:42', to: '00:01', stage: 'light' },
    ]);
    expect(t?.stages?.at(-1)).toEqual({ from: '06:31', to: '06:48', stage: 'rem' });
    expect(t?.awakenings).toEqual({ count: 1, longest_min: 13, longest_at: '05:47', at: ['05:47'] });
    expect(t?.restless_moments).toBe(50);
    expect(t?.min_hr).toEqual({ bpm: 54, at: '02:20' });
    // 17 ms occurs twice (00:21 and 04:56); the first one is reported.
    expect(t?.hrv).toEqual({ min_ms: 17, min_at: '00:21', max_ms: 62, max_at: '06:46' });
    expect(t?.body_battery).toEqual({ start: 19, end: 64 });
    // The recorded account has no Pulse Ox during sleep.
    expect(t?.lowest_spo2).toBeUndefined();
    expect(sleepTimeline(sleep, hrv, 'UTC')?.stages?.[0]).toEqual({ from: '21:13', to: '21:32', stage: 'light' });
  });

  it('falls back to the HRV readings in the sleep JSON and to the counted restless moments', () => {
    const { restlessMomentsCount: _count, ...rest } = sleep;
    const t = sleepTimeline(rest, undefined, 'Europe/Warsaw');
    expect(t?.hrv).toEqual({ min_ms: 17, min_at: '00:21', max_ms: 62, max_at: '06:46' });
    expect(t?.restless_moments).toBe(50);
  });

  it('finds the lowest SpO2 with its time, or the nightly lowest without one', () => {
    const spo2 = [
      { epochTimestamp: '2026-10-09T23:00:00.0', spo2Reading: 95 },
      { epochTimestamp: '2026-10-10T01:30:00.0', spo2Reading: 88 },
      { epochTimestamp: '2026-10-10T02:00:00.0', spo2Reading: 0 },
    ];
    expect(sleepTimeline({ wellnessSpO2SleepDataDTOList: spo2 }, undefined, 'Europe/Warsaw')).toEqual({ lowest_spo2: { pct: 88, at: '03:30' } });
    expect(sleepTimeline({ dailySleepDTO: { lowestSpO2Value: 90 } }, undefined, 'UTC')).toEqual({ lowest_spo2: { pct: 90 } });
  });

  it(`merges a fragmented night into at most ${MAX_STAGE_SEGMENTS} segments and counts awakenings before merging`, () => {
    const start = Date.parse('2026-10-09T22:00:00Z');
    // 120 alternating segments: light 4 min, then deep, REM or a 1-minute awakening.
    const sleepLevels = Array.from({ length: 120 }, (_, i) => {
      const level = i % 2 === 0 ? 1 : [0, 2, 3][((i - 1) / 2) % 3];
      const from = start + i * 240_000;
      const to = from + (level === 3 ? 60_000 : 240_000);
      return { startGMT: new Date(from).toISOString().slice(0, 21), endGMT: new Date(to).toISOString().slice(0, 21), activityLevel: level };
    });
    const t = sleepTimeline({ sleepLevels }, undefined, 'UTC');
    expect(t?.stages?.length).toBeLessThanOrEqual(MAX_STAGE_SEGMENTS);
    expect(t?.stages?.[0]?.from).toBe('22:00');
    expect(t?.stages?.at(-1)?.to).toBe('05:57');
    expect(t?.awakenings?.count).toBe(20);
    expect(t?.awakenings?.longest_min).toBe(1);
    expect(t?.stages?.filter((s) => s.stage === 'awake')).toEqual([]);
  });

  it('has nothing to show for a night without series', () => {
    expect(sleepTimeline({ dailySleepDTO: { sleepTimeSeconds: 28_800 } }, undefined, 'UTC')).toBeUndefined();
    expect(sleepTimeline(null, null, 'UTC')).toBeUndefined();
  });
});
