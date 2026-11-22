import { describe, expect, it } from 'vitest';
import { lapSummary, MIN_TYPED_SPLIT_S, splitSummaries, typedSplits } from './activity-extras.js';
import { fixture } from './test-utils/fake.js';

/** A raw typed split starting `at` seconds after 07:00:00, `duration` s long, at 3 m/s. */
const split = (type: string, at: number, duration: number, extra: Record<string, unknown> = {}) => {
  const t = new Date(Date.UTC(2026, 9, 7, 7, 0, at)).toISOString().slice(0, 19);
  return { type, startTimeLocal: `${t}.0`, startTimeGMT: `${t}.0`, duration, distance: duration * 3, averageHR: 150, maxHR: 160, ...extra };
};
const rows = (...splits: ReturnType<typeof split>[]) => typedSplits({ splits }, 'running');
const shape = (r: ReturnType<typeof rows>) => r.splits.map((s) => [s.type, s.start, s.duration]);

describe('typedSplits', () => {
  it('merges splits under two minutes', () => {
    expect(MIN_TYPED_SPLIT_S).toBe(120);
    expect(shape(rows(split('RWD_RUN', 0, 300), split('RWD_WALK', 300, 119)))).toEqual([['run', '07:00:00', '6:59']]);
    expect(shape(rows(split('RWD_RUN', 0, 300), split('RWD_WALK', 300, 120)))).toEqual([
      ['run', '07:00:00', '5:00'],
      ['walk', '07:05:00', '2:00'],
    ]);
  });

  it('merges a short split at the start into the next one, with its start and the longer type', () => {
    const r = rows(split('RWD_STAND', 0, 10, { distance: 0, averageHR: 90, maxHR: 100 }), split('RWD_RUN', 10, 290, { averageHR: 156, maxHR: 170, elevationGain: 12, elevationLoss: 4 }));
    expect(r.merged).toBe(1);
    expect(r.splits).toEqual([
      {
        type: 'run',
        start: '07:00:00',
        duration: '5:00',
        distance_km: 0.87,
        avg_pace: '5:45 /km',
        // (90 × 10 + 156 × 290) / 300
        avg_hr_bpm: 154,
        max_hr_bpm: 170,
        elevation_gain_m: 12,
        elevation_loss_m: 4,
      },
    ]);
  });

  it('merges several short splits in a row into the one before them', () => {
    const r = rows(
      split('RWD_RUN', 0, 300, { avgGradeAdjustedSpeed: 3 }),
      split('RWD_WALK', 300, 20, { avgGradeAdjustedSpeed: 1.5 }),
      split('RWD_STAND', 320, 10, { distance: 0, avgGradeAdjustedSpeed: 0 }),
      split('RWD_WALK', 330, 30, { avgGradeAdjustedSpeed: 1.5 }),
      split('RWD_RUN', 360, 200),
    );
    expect(r.merged).toBe(3);
    expect(shape(r)).toEqual([
      ['run', '07:00:00', '6:00'],
      ['run', '07:06:00', '3:20'],
    ]);
    // GAP over time: (3 × 300 + 1.5 × 50 + 0 × 10) / 360 m/s.
    expect(r.splits[0]?.avg_gap_pace).toBe('6:09 /km');
  });

  it('keeps the type of a group of short splits at the start when it is the longer one', () => {
    const r = rows(split('RWD_WALK', 0, 100), split('RWD_RUN', 100, 80), split('RWD_RUN', 180, 140));
    expect(r.merged).toBe(2);
    expect(shape(r)).toEqual([['walk', '07:00:00', '5:20']]);
  });

  it('neither merges climbs and intervals nor lets them stop the merging around them', () => {
    const r = rows(
      split('INTERVAL_ACTIVE', 0, 900),
      split('RWD_RUN', 0, 300),
      split('CLIMB_PRO_CYCLING_CLIMB', 280, 30, { averageGrade: 8, maxGrade: 12 }),
      split('CLIMB_PRO_CYCLING_CLIMB_SECTION', 280, 10),
      split('RWD_WALK', 300, 20),
      split('CLIMB_PRO_CYCLING_CLIMB', 310, 40),
      split('RWD_RUN', 320, 200),
    );
    expect(r.merged).toBe(1);
    expect(shape(r)).toEqual([
      ['interval_active', '07:00:00', '15:00'],
      ['run', '07:00:00', '5:20'],
      ['climb', '07:04:40', '0:30'],
      ['climb', '07:05:10', '0:40'],
      ['run', '07:05:20', '3:20'],
    ]);
    expect(r.splits[2]).toMatchObject({ avg_grade_pct: 8, max_grade_pct: 12 });
  });

  it('changes nothing when every split is two minutes or longer', () => {
    const splits = [split('RWD_RUN', 0, 600), split('RWD_WALK', 600, 120), split('RWD_STAND', 720, 150, { distance: 0 })];
    const r = rows(...splits);
    expect(r.merged).toBe(0);
    expect(r).toEqual(typedSplits({ splits }, 'running', 0));
    // Standing has no pace.
    expect(r.splits[2]).toEqual({ type: 'stand', start: '07:12:00', duration: '2:30', distance_km: 0, avg_hr_bpm: 150, max_hr_bpm: 160 });
  });

  it('merges the recorded trail run', () => {
    const r = typedSplits(fixture('activity-typed-splits'), 'trail_running');
    expect(r.merged).toBe(5);
    expect(r.splits.map((s) => s.type)).toEqual(['interval_active', 'run', 'climb', 'walk', 'walk', 'walk', 'climb', 'climb']);
  });
});

describe('lapSummary', () => {
  it('gives speed for a ride, groups laps without intensity and weights only laps with a value', () => {
    const laps = [
      { intensityType: 'ACTIVE', duration: 1800, distance: 15_000, averageHR: 140, maxHR: 150, averagePower: 200, avgGradeAdjustedSpeed: 8 },
      { intensityType: 'ACTIVE', duration: 600, distance: 6000, averagePower: 260 },
      { duration: 60, distance: 0 },
      'not a lap',
    ];
    expect(lapSummary(laps, 'road_biking')).toEqual([
      { intensity: 'active', laps: 2, duration: '40:00', distance_km: 21, avg_speed_kmh: 31.5, avg_hr_bpm: 140, max_hr_bpm: 150, avg_power_w: 215 },
      { intensity: undefined, laps: 1, duration: '1:00', distance_km: 0 },
    ]);
    expect(lapSummary(undefined, 'running')).toEqual([]);
  });
});

describe('splitSummaries', () => {
  it('gives each type its share of its family, and none to a type alone in its family', () => {
    const r = splitSummaries(
      [
        { splitType: 'RWD_RUN', noOfSplits: 3, duration: 3000, distance: 9000 },
        { splitType: 'RWD_WALK', noOfSplits: 2, duration: 1000, distance: 1000 },
        { splitType: 'INTERVAL_WARMUP', noOfSplits: 1, duration: 1000, distance: 2500 },
        { splitType: 'INTERVAL_ACTIVE', noOfSplits: 4, duration: 3000, distance: 7500 },
        { splitType: 'CLIMB_PRO_CYCLING_CLIMB', noOfSplits: 2, duration: 900, distance: 2000 },
      ],
      'running',
    );
    expect(r.map((s) => [s.type, s.time_pct, s.distance_pct])).toEqual([
      ['run', 75, 90],
      ['walk', 25, 10],
      ['interval_warmup', 25, 25],
      ['interval_active', 75, 75],
      ['climb', undefined, undefined],
    ]);
  });
});
