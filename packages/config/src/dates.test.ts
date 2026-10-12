import { describe, expect, it } from 'vitest';
import { addDays, dateIn, eachDay, endOfMonth, isIsoDate, isoWeek, startOfWeek } from './dates.js';

describe('dates', () => {
  it('validates ISO dates', () => {
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-2-3')).toBe(false);
  });
  it('does calendar arithmetic', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(eachDay('2026-10-01', '2026-10-03')).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
    expect(startOfWeek('2026-10-08')).toBe('2026-10-05');
    expect(endOfMonth('2028-02-10')).toBe('2028-02-29');
    expect(isoWeek('2026-01-01')).toBe('2026-W01');
  });
  it('computes local dates in a zone', () => {
    const instant = new Date('2026-10-08T23:30:00Z');
    expect(dateIn('Europe/Warsaw', instant)).toBe('2026-10-09');
    expect(dateIn('America/New_York', instant)).toBe('2026-10-08');
  });
});
