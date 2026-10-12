import { describe, expect, it } from 'vitest';
import { addRange, gaps } from './ranges.js';

describe('ranges', () => {
  it('merges overlapping and adjacent ranges', () => {
    let s = addRange([], '2026-01-10', '2026-01-20');
    s = addRange(s, '2026-01-01', '2026-01-05');
    s = addRange(s, '2026-01-21', '2026-01-25');
    expect(s).toEqual([
      ['2026-01-01', '2026-01-05'],
      ['2026-01-10', '2026-01-25'],
    ]);
    expect(addRange(s, '2026-01-06', '2026-01-09')).toEqual([['2026-01-01', '2026-01-25']]);
  });

  it('finds gaps inside a query range', () => {
    const s = addRange(addRange([], '2026-01-05', '2026-01-10'), '2026-01-20', '2026-01-25');
    expect(gaps(s, '2026-01-01', '2026-01-31')).toEqual([
      ['2026-01-01', '2026-01-04'],
      ['2026-01-11', '2026-01-19'],
      ['2026-01-26', '2026-01-31'],
    ]);
    expect(gaps(s, '2026-01-06', '2026-01-09')).toEqual([]);
    expect(gaps([], '2026-01-01', '2026-01-02')).toEqual([['2026-01-01', '2026-01-02']]);
  });
});
