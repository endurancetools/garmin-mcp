import { describe, expect, it } from 'vitest';
import { checkPulse, checkWaterMl, checkWeightKg, localToUtc, measuredAt, parseBloodPressure } from './measurements.js';

/** 2026-11-17 09:15 in Warsaw (UTC+1). */
const NOW = Date.parse('2026-11-17T08:15:00Z');
const WAW = 'Europe/Warsaw';

describe('measuredAt', () => {
  it('is now without a date and on a bare today', () => {
    const now = { local: '2026-11-17T09:15:00', utc: new Date(NOW) };
    expect(measuredAt(undefined, WAW, NOW)).toEqual(now);
    expect(measuredAt('2026-11-17', WAW, NOW)).toEqual(now);
  });

  it('is 12:00 on an earlier bare day and the given local time otherwise, in the account zone', () => {
    expect(measuredAt('2026-11-10', WAW, NOW)).toEqual({ local: '2026-11-10T12:00:00', utc: new Date('2026-11-10T11:00:00Z') });
    expect(measuredAt('2026-07-01 07:05', WAW, NOW)).toEqual({ local: '2026-07-01T07:05:00', utc: new Date('2026-07-01T05:05:00Z') });
    expect(measuredAt('2026-11-17T06:00', 'UTC', NOW)).toEqual({ local: '2026-11-17T06:00:00', utc: new Date('2026-11-17T06:00:00Z') });
  });

  it('refuses the future and other formats', () => {
    expect(() => measuredAt('2026-11-17 10:00', WAW, NOW)).toThrow('is in the future (now 2026-11-17 09:15 in Europe/Warsaw)');
    expect(() => measuredAt('2026-11-18', WAW, NOW)).toThrow('is in the future');
    expect(() => measuredAt('17.11.2026', WAW, NOW)).toThrow('date must be YYYY-MM-DD');
    expect(() => measuredAt('2026-02-30', WAW, NOW)).toThrow('date must be YYYY-MM-DD');
  });
});

describe('localToUtc', () => {
  it('finds the instant across daylight saving changes', () => {
    expect(new Date(localToUtc(WAW, '2026-03-29T01:30:00')).toISOString()).toBe('2026-03-29T00:30:00.000Z');
    expect(new Date(localToUtc(WAW, '2026-03-29T03:30:00')).toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(new Date(localToUtc('America/New_York', '2026-11-17T07:00:00')).toISOString()).toBe('2026-11-17T12:00:00.000Z');
  });
});

describe('measurement checks', () => {
  it('reads blood pressure as systolic/diastolic', () => {
    expect(parseBloodPressure('120/80')).toEqual({ systolic: 120, diastolic: 80 });
    expect(parseBloodPressure(' 135 / 85 ')).toEqual({ systolic: 135, diastolic: 85 });
    expect(() => parseBloodPressure('80/120')).toThrow('systolic must be higher than diastolic');
    expect(() => parseBloodPressure('120-80')).toThrow('e.g. 120/80');
    expect(() => parseBloodPressure('400/80')).toThrow('systolic (mmHg) must be a whole number from 60 to 300, got 400');
  });

  it('keeps weight, water and pulse in plausible ranges', () => {
    expect(checkWeightKg(72.4)).toBe(72.4);
    expect(() => checkWeightKg(724)).toThrow('weight (kg) must be from 20 to 400, got 724');
    expect(checkWaterMl(500)).toBe(500);
    expect(() => checkWaterMl(2.5)).toThrow('water (ml) must be a whole number');
    expect(checkPulse(62)).toBe(62);
    expect(() => checkPulse(Number.NaN)).toThrow('got not a number');
  });
});
