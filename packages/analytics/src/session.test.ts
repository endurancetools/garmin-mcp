import type { ActivityRow, ImportedActivityRow, ThresholdParam } from 'garmin-mcp-store';
import { describe, expect, it } from 'vitest';
import {
  buildSessions,
  efficiencyFactor,
  efficiencyFactorGap,
  hrTss,
  intensityFactor,
  seilerZoneByHr,
  sessionFromActivity,
  sessionFromImported,
  sessionMetrics,
  type SessionContext,
  type SessionInput,
} from './session.js';
import type { ThresholdPoint } from './thresholds.js';

const row = (date: string, param: ThresholdParam, value: number): ThresholdPoint => ({ date, param, value });
const CTX: SessionContext = {
  thresholds: [row('2026-01-01', 'lthr_run', 170), row('2026-01-01', 'lthr_bike', 160), row('2026-01-01', 'rhr', 50)],
  daily: [],
};
const input = (extra: Partial<SessionInput> = {}): SessionInput => ({
  id: 1,
  date: '2026-05-04',
  type: 'running',
  duration_s: 3600,
  avg_hr: 150,
  source: 'db',
  ...extra,
});

function activity(extra: Partial<ActivityRow> = {}, raw: Record<string, unknown> = {}): ActivityRow {
  return {
    id: 42,
    start_time_utc: '2026-05-04T05:00:00Z',
    start_time_local: '2026-05-04T07:00:00',
    type: 'trail_running',
    name: 'Morning run',
    duration_s: 3000,
    distance_m: 10_000,
    avg_hr: 150,
    max_hr: 171,
    avg_power: 300,
    training_effect_aerobic: 3.14,
    training_effect_anaerobic: 0.96,
    training_load: 88.26,
    calories: 650.4,
    elevation_gain_m: 120.4,
    date: '2026-05-04',
    gear_uuid: null,
    fetched_at: 0,
    raw: { activityId: 42, ...raw } as ActivityRow['raw'],
    ...extra,
  };
}

describe('intensityFactor and hrTss', () => {
  it('scales HR between resting and threshold', () => {
    expect(intensityFactor(150, 50, 170)).toBeCloseTo(100 / 120, 10);
    expect(intensityFactor(170, 50, 170)).toBe(1);
    expect(hrTss(3600, 1)).toBe(100);
    expect(hrTss(1800, 0.5)).toBe(12.5);
  });

  it('is 0 without HR, at or below resting HR, or when LTHR ≤ RHR', () => {
    expect(intensityFactor(undefined, 50, 170)).toBe(0);
    expect(intensityFactor(50, 50, 170)).toBe(0);
    expect(intensityFactor(45, 50, 170)).toBe(0);
    expect(intensityFactor(150, 50, 50)).toBe(0);
    expect(intensityFactor(150, 60, 55)).toBe(0);
    expect(hrTss(undefined, 0.8)).toBe(0);
  });

  it('rounds IF to 3 places and hrTSS to 1, with hrTSS from the unrounded IF', () => {
    const s = sessionMetrics(input(), CTX);
    expect(s.if).toBe(0.833);
    expect(s.hrtss).toBe(69.4);
    expect(s.lthr_used).toBe(170);
    expect(s.rhr_used).toBe(50);
    const none = sessionMetrics(input({ avg_hr: undefined }), CTX);
    expect([none.if, none.hrtss]).toEqual([0, 0]);
  });
});

describe('thresholds of the session date and sport', () => {
  it('uses the LTHR of the sport, falling back to running', () => {
    expect(sessionMetrics(input({ type: 'road_biking' }), CTX).lthr_used).toBe(160);
    expect(sessionMetrics(input({ type: 'lap_swimming' }), CTX).lthr_used).toBe(170);
    expect(sessionMetrics(input({ type: 'strength_training' }), CTX).lthr_used).toBe(170);
  });

  it('takes the threshold valid on the session date', () => {
    const ctx = { ...CTX, thresholds: [...CTX.thresholds, row('2026-06-01', 'lthr_run', 175)] };
    expect(sessionMetrics(input({ date: '2026-05-31' }), ctx).lthr_used).toBe(170);
    expect(sessionMetrics(input({ date: '2026-06-01' }), ctx).lthr_used).toBe(175);
  });

  it('uses the 28-day resting HR mean when there are enough days', () => {
    const daily = Array.from({ length: 20 }, (_, i) => ({ date: `2026-04-${String(10 + i).padStart(2, '0')}`, resting_hr: i % 2 ? 44 : 45 }));
    const s = sessionMetrics(input(), { ...CTX, daily });
    expect(s.rhr_used).toBe(44.5);
    expect(s.if).toBe(round3((150 - 44.5) / (170 - 44.5)));
  });

  it('reports defaults once per build', () => {
    const { sessions, notes } = buildSessions([input({ id: 2 }), input({ id: 1, date: '2026-05-01' })], { thresholds: [], daily: [] });
    expect(sessions.map((s) => s.id)).toEqual([1, 2]);
    expect(sessions[0]?.lthr_used).toBe(170);
    expect(sessions[0]?.rhr_used).toBe(50);
    expect(notes).toHaveLength(2);
    expect(notes.join(' ')).toMatch(/LTHR.*170.*resting HR.*50/s);
  });
});

const round3 = (v: number) => Math.round(v * 1000) / 1000;

describe('efficiency factors', () => {
  it('running: speed in m/min per beat; GAP variant from the grade adjusted speed', () => {
    expect(efficiencyFactor('run', { avg_hr: 150, duration_s: 3000, distance_m: 10_000 })).toBeCloseTo(200 / 150, 10);
    expect(efficiencyFactorGap('run', 150, 3.5)).toBeCloseTo(1.4, 10);
  });

  it('cycling: normalized power per beat, nothing without NP', () => {
    expect(efficiencyFactor('bike', { avg_hr: 140, np_w: 200 })).toBeCloseTo(200 / 140, 10);
    expect(efficiencyFactor('bike', { avg_hr: 140 })).toBeUndefined();
    expect(efficiencyFactorGap('bike', 140, 3.5)).toBeUndefined();
  });

  it('undefined for other sports and for missing inputs', () => {
    expect(efficiencyFactor('swim', { avg_hr: 140, duration_s: 1800, distance_m: 2000 })).toBeUndefined();
    expect(efficiencyFactor('run', { duration_s: 3000, distance_m: 10_000 })).toBeUndefined();
    expect(efficiencyFactor('run', { avg_hr: 150, duration_s: 3000 })).toBeUndefined();
    expect(efficiencyFactor('run', { avg_hr: 150, distance_m: 10_000 })).toBeUndefined();
    expect(efficiencyFactor('run', { avg_hr: 0, duration_s: 3000, distance_m: 10_000 })).toBeUndefined();
    expect(efficiencyFactorGap('run', 150, undefined)).toBeUndefined();
  });

  it('rounds EF and EF-GAP to 3 places in the session row', () => {
    const s = sessionMetrics(input({ duration_s: 3000, distance_m: 10_000, gap_mps: 3.456 }), CTX);
    expect(s.ef).toBe(1.333);
    expect(s.ef_gap).toBe(1.382);
    expect(s.gap_mps).toBe(3.456);
  });
});

describe('seilerZoneByHr', () => {
  it('splits at LT1 and LTHR', () => {
    expect(seilerZoneByHr(140, 150, 170)).toBe(1);
    expect(seilerZoneByHr(150, 150, 170)).toBe(2);
    expect(seilerZoneByHr(169, 150, 170)).toBe(2);
    expect(seilerZoneByHr(170, 150, 170)).toBe(3);
  });
});

describe('sessionFromActivity', () => {
  it('reads columns, list-entry fields and RPE/feel from the summary detail', () => {
    const a = activity(
      {},
      {
        eventType: { typeKey: 'race' },
        movingDuration: 2950.4,
        elevationLoss: 118.6,
        normPower: 310.2,
        averageRunningCadenceInStepsPerMinute: 172.6,
        avgGradeAdjustedSpeed: 3.4,
        hrTimeInZone_1: 100.4,
        hrTimeInZone_2: 900,
        hrTimeInZone_3: 1200,
        hrTimeInZone_4: 700,
        hrTimeInZone_5: 100,
      },
    );
    const i = sessionFromActivity(a, { metadataDTO: { workoutRpe: 60, workoutFeel: 75 } });
    expect(i).toMatchObject({
      id: 42,
      date: '2026-05-04',
      start_local: '2026-05-04T07:00:00',
      type: 'trail_running',
      event_type: 'race',
      moving_s: 2950.4,
      elev_loss_m: 118.6,
      np_w: 310.2,
      avg_cadence: 172.6,
      gap_mps: 3.4,
      g_load: 88.26,
      rpe: 60,
      feel: 75,
      zones_s: [100.4, 900, 1200, 700, 100],
      source: 'db',
    });
    const s = sessionMetrics(i!, CTX);
    expect(s).toMatchObject({
      week: '2026-W19',
      sport: 'run',
      duration_s: 3000,
      moving_s: 2950,
      elev_gain_m: 120,
      elev_loss_m: 119,
      np_w: 310,
      avg_cadence: 173,
      calories: 650,
      g_load: 88.3,
      aerobic_te: 3.1,
      anaerobic_te: 1,
      z1_s: 100,
      z5_s: 100,
    });
  });

  it('falls back to biking cadence; no zones when Garmin gave none; no row without a date', () => {
    const i = sessionFromActivity(activity({ type: 'road_biking' }, { averageBikingCadenceInRevPerMinute: 88 }));
    expect(i?.avg_cadence).toBe(88);
    expect(i?.zones_s).toBeUndefined();
    expect(i?.rpe).toBeUndefined();
    const s = sessionMetrics(i!, CTX);
    expect(s.z1_s).toBeUndefined();
    expect(sessionFromActivity(activity({ date: null }))).toBeUndefined();
  });

  it('keeps a missing number undefined instead of NaN', () => {
    const s = sessionMetrics(sessionFromActivity(activity({ distance_m: null, avg_hr: null, calories: null }))!, CTX);
    expect(s.distance_m).toBeUndefined();
    expect(s.avg_hr).toBeUndefined();
    expect(s.calories).toBeUndefined();
    expect(s.ef).toBeUndefined();
    expect(s.hrtss).toBe(0);
  });
});

describe('sessionFromImported', () => {
  it('maps an imported CSV row with source import', () => {
    const r: ImportedActivityRow = {
      id: 'csv-0123456789',
      start_time_local: '2024-03-02 09:15:00',
      date: '2024-03-02',
      type: 'road_biking',
      name: 'Ride',
      duration_s: 7200,
      moving_s: 7000,
      distance_m: 60_000,
      elevation_gain_m: 500,
      elevation_loss_m: 490,
      avg_hr: 140,
      max_hr: 165,
      avg_power: 190,
      norm_power: 210,
      avg_cadence: 85,
      calories: 1500,
      training_effect_aerobic: 3,
      training_effect_anaerobic: null,
      source_file: 'Activities.csv',
      imported_at: 0,
    };
    const s = sessionMetrics(sessionFromImported(r), CTX);
    expect(s).toMatchObject({ id: 'csv-0123456789', sport: 'bike', np_w: 210, lthr_used: 160, source: 'import', ef: 1.5 });
    expect(s.anaerobic_te).toBeUndefined();
    expect(s.g_load).toBeUndefined();
    expect(s.z1_s).toBeUndefined();
  });
});
