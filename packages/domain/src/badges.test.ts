import { describe, expect, it } from 'vitest';
import { badgeSummary, challengeList } from './badges.js';
import { fixture } from './test-utils/fake.js';

describe('badges', () => {
  it('counts the recorded earned badges and lists the latest first', () => {
    const summary = badgeSummary(fixture('earned-badges'));
    expect(summary.count).toBe(5);
    expect(summary.recent[0]).toEqual({ name: 'anon-badgeName', earned_on: '2026-11-05', points: 4, times_earned: 7 });
    expect(summary.recent.map((b) => b.earned_on)).toEqual(['2026-11-05', '2026-11-01', '2026-10-31', '2026-10-27', '2026-10-27']);
    expect(summary.recent[2]).not.toHaveProperty('times_earned', expect.anything());
  });

  it('keeps the 10 latest, skips entries without an earned date and reads anything but a list as none', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ badgeName: `B${i}`, badgeEarnedDate: `2026-01-${String(i + 1).padStart(2, '0')}T08:00:00.0`, badgePoints: 1 }));
    const summary = badgeSummary([...many, { badgeName: 'not earned', badgeEarnedDate: null }, null]);
    expect(summary.count).toBe(12);
    expect(summary.recent).toHaveLength(10);
    expect(summary.recent[0]?.name).toBe('B11');
    expect(badgeSummary(null)).toEqual({ count: 0, recent: [] });
  });

  it('gives the recorded challenges in progress with how far along they are', () => {
    const list = challengeList(fixture('badge-challenges'));
    expect(list).toHaveLength(3);
    expect(list[0]).toEqual({ name: 'anon-badgeChallengeName', start: '2026-10-01', end: '2026-12-31', progress_pct: 58, value: 174785.9, target: 300000, unit_id: 1 });
    expect(list[2]).toMatchObject({ progress_pct: 0, value: 0, target: 675000 });
    expect(challengeList([{ badgeProgressValue: 12, badgeTargetValue: 10 }, { badgeProgressValue: 3, badgeTargetValue: 0 }])).toEqual([
      expect.objectContaining({ progress_pct: 100 }),
      expect.objectContaining({ progress_pct: undefined, value: 3, target: 0 }),
    ]);
    expect(challengeList({})).toEqual([]);
  });
});
