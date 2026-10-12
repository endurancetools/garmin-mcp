import { describe, expect, it } from 'vitest';
import { isDayFresh } from './freshness.js';

const tz = 'Europe/Warsaw';
const now = Date.parse('2026-10-08T10:00:00Z'); // 12:00 local
const min = 60_000;

describe('isDayFresh', () => {
  it('requires a row', () => expect(isDayFresh('sleep', '2026-01-01', undefined, now, tz)).toBe(false));

  it('uses a 15 min TTL for today and yesterday', () => {
    expect(isDayFresh('daily_summary', '2026-10-08', now - 10 * min, now, tz)).toBe(true);
    expect(isDayFresh('daily_summary', '2026-10-08', now - 20 * min, now, tz)).toBe(false);
    expect(isDayFresh('sleep', '2026-10-07', now - 20 * min, now, tz)).toBe(false);
  });

  it('gives training status and HRV for today one hour', () => {
    expect(isDayFresh('training_status', '2026-10-08', now - 50 * min, now, tz)).toBe(true);
    expect(isDayFresh('hrv', '2026-10-08', now - 70 * min, now, tz)).toBe(false);
  });

  it('never refreshes historical days fetched after they ended', () => {
    expect(isDayFresh('sleep', '2026-09-01', Date.parse('2026-09-05T00:00:00Z'), now, tz)).toBe(true);
  });

  it('refreshes once a historical day cached while it was still today', () => {
    expect(isDayFresh('sleep', '2026-09-01', Date.parse('2026-09-01T12:00:00Z'), now, tz)).toBe(false);
  });
});
