import type { IntradayKind, IntradayRow } from 'garmin-mcp-store';
import { describe, expect, it } from 'vitest';
import { hourlyTable, intradayKinds } from './intraday.js';
import { fixture } from './test-utils/fake.js';

const FIXTURES: Record<Exclude<IntradayKind, 'daily_events'>, string> = {
  heart_rate: 'heart-rate-day',
  stress: 'stress-day',
  respiration: 'respiration-day',
  spo2: 'spo2-day',
  steps: 'steps-chart',
  body_battery_events: 'body-battery',
};

/** The recorded day (2026-10-10, Europe/Warsaw) as stored by `ensureIntraday`. */
function recordedDay(kinds: (keyof typeof FIXTURES)[] = Object.keys(FIXTURES) as (keyof typeof FIXTURES)[]): IntradayRow[] {
  return kinds.map((kind) => ({ kind, raw: fixture(FIXTURES[kind]), fetched_at: 0 }));
}

describe('intradayKinds', () => {
  it('maps hourly metrics to their series and adds Body Battery events for stress and Body Battery', () => {
    expect(intradayKinds(['steps', 'resting_hr'])).toEqual(['steps', 'heart_rate']);
    expect(intradayKinds(['body_battery', 'stress'])).toEqual(['stress', 'body_battery_events']);
    expect(intradayKinds(['sleep', 'hrv'])).toEqual([]);
  });
});

describe('hourlyTable', () => {
  const day = [{ date: '2026-10-10' as const, series: recordedDay() }];
  const all = hourlyTable(['resting_hr', 'stress', 'body_battery', 'steps', 'respiration', 'spo2'], day, '2026-10-10', '2026-10-10', 'Europe/Warsaw');

  it('aggregates the recorded day per local hour', () => {
    expect(all.rows).toHaveLength(24);
    expect(all.rows[0]).toMatchObject({ date: '2026-10-10', hour: '00:00' });
    expect(all.rows.find((r) => r.hour === '08:00')).toEqual({
      date: '2026-10-10',
      hour: '08:00',
      hr_avg_bpm: 88,
      hr_min_bpm: 75,
      hr_max_bpm: 97,
      stress_avg: 71,
      stress_max: 83,
      body_battery_start: 59,
      body_battery_end: 55,
      steps: 1793,
      respiration_brpm: 12.5,
    });
    // Too active to measure stress (-2) during the long activity: no stress fields, the rest stays.
    const midday = all.rows.find((r) => r.hour === '12:00');
    expect(midday?.stress_avg).toBeUndefined();
    expect(midday?.hr_avg_bpm).toBeTypeOf('number');
  });

  it('names the peak and lowest hour per metric', () => {
    expect(all.summary.stress).toEqual({ avg: 39, max: 71, max_at: '2026-10-10 08:00', min: 18, min_at: '2026-10-10 02:00', hours_with_data: 17 });
    expect(all.summary.resting_hr).toMatchObject({ avg: 98, max: 173, max_at: '2026-10-10 09:00', min: 54, min_at: '2026-10-10 02:00', hours_with_data: 24 });
    expect(all.summary.body_battery).toMatchObject({ max: 65, max_at: '2026-10-10 06:00', min: 6, min_at: '2026-10-10 20:00' });
    expect(all.summary.steps).toMatchObject({ total: 59_451, max: 9537, max_at: '2026-10-10 09:00' });
    expect(all.summary.steps?.min).toBeUndefined();
    // The recorded account has no Pulse Ox: no hourly SpO2.
    expect(all.summary.spo2).toEqual({ hours_with_data: 0 });
  });

  it('lists Body Battery events in local time', () => {
    expect(all.events).toEqual([
      { type: 'sleep', start: '2026-10-09 23:13', duration: '7:35:00', body_battery_impact: 46, feedback: undefined },
      { type: 'activity', start: '2026-10-10 09:00', duration: '6:33:00', body_battery_impact: -41, feedback: 'overreaching lactate threshold' },
    ]);
  });

  it('keeps only hours of the asked range and only the asked metrics', () => {
    const utc = hourlyTable(['steps'], [{ date: '2026-10-10', series: recordedDay(['steps', 'heart_rate', 'stress']) }], '2026-10-10', '2026-10-10', 'UTC');
    // The day starts at 22:00 UTC of the 9th: those two hours fall outside the range.
    expect(utc.rows).toHaveLength(22);
    expect(utc.rows.every((r) => Object.keys(r).toSorted().join() === 'date,hour,steps')).toBe(true);
    expect(Object.keys(utc.summary)).toEqual(['steps']);
  });

  it('reads SpO2 readings as [timestamp, value] rows', () => {
    const spo2: IntradayRow = {
      kind: 'spo2',
      fetched_at: 0,
      raw: { spO2SingleValues: [[Date.parse('2026-10-10T01:10:00Z'), 95], [Date.parse('2026-10-10T01:40:00Z'), 91], [Date.parse('2026-10-10T03:00:00Z'), 97], [Date.parse('2026-10-10T04:00:00Z'), -1]] },
    };
    const t = hourlyTable(['spo2'], [{ date: '2026-10-10', series: [spo2] }], '2026-10-10', '2026-10-10', 'UTC');
    expect(t.rows).toEqual([
      { date: '2026-10-10', hour: '01:00', spo2_pct: 93 },
      { date: '2026-10-10', hour: '03:00', spo2_pct: 97 },
    ]);
    expect(t.summary.spo2).toMatchObject({ avg: 95, min: 93, min_at: '2026-10-10 01:00', max: 97, max_at: '2026-10-10 03:00' });
  });

  it('answers nothing from series Garmin did not have (404 stored as null)', () => {
    const t = hourlyTable(['stress'], [{ date: '2026-10-10', series: [{ kind: 'stress', raw: null, fetched_at: 0 }] }], '2026-10-10', '2026-10-10', 'UTC');
    expect(t).toEqual({ rows: [], events: [], summary: { stress: { hours_with_data: 0 } } });
  });
});
