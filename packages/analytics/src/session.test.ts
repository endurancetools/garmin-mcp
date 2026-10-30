import { round } from 'garmin-mcp-domain';
import type { ActivityRow, ImportedActivityRow, ThresholdParam } from 'garmin-mcp-store';
import { describe, expect, it } from 'vitest';
import {
  buildSessions,
  decoupling,
  efficiencyFactor,
  efficiencyFactorGap,
  hikeGap,
  hrTss,
  hrZonesCandidate,
  intensityFactor,
  lapsFrom,
  NO_CSS_NOTE,
  NO_FTP_NOTE,
  NO_THRESHOLD_PACE_NOTE,
  paceCandidate,
  powerCandidate,
  resolveLoad,
  rpeCandidate,
  seilerZoneByHr,
  sessionFromActivity,
  sessionFromImported,
  sessionMetrics,
  swimPaceCandidate,
  type Lap,
  type SessionContext,
  type SessionInput,
} from './session.js';
import { RPE_LOAD_CALIBRATION } from './load.js';
import { zoneBounds, type ProfileZoneFloors, type ThresholdPoint } from './thresholds.js';

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
    expect([none.tss, none.if, none.load_source, none.hrtss]).toEqual([undefined, undefined, 'none', 0]);
  });
});

describe('thresholds of the session date and sport', () => {
  it('uses the LTHR of the sport, falling back to running', () => {
    expect(sessionMetrics(input({ type: 'road_biking' }), CTX).lthr_used).toBe(160);
    expect(sessionMetrics(input({ type: 'lap_swimming' }), CTX).lthr_used).toBe(170);
    expect(sessionMetrics(input({ type: 'strength_training' }), CTX).lthr_used).toBe(170);
  });

  it('nordic and row use the running LTHR and LT1', () => {
    for (const type of ['cross_country_skiing', 'snowshoeing', 'indoor_rowing']) {
      expect(sessionMetrics(input({ type }), CTX)).toMatchObject({ lthr_used: 170, lt1_used: 153 });
    }
    expect(sessionMetrics(input({ type: 'skate_skiing' }), CTX).sport).toBe('nordic');
    expect(sessionMetrics(input({ type: 'rowing' }), CTX).sport).toBe('row');
  });

  it('reports the LT1 of the sport next to the LTHR', () => {
    expect(sessionMetrics(input(), CTX).lt1_used).toBe(153);
    expect(sessionMetrics(input({ type: 'road_biking' }), CTX).lt1_used).toBe(144);
    expect(sessionMetrics(input({ type: 'lap_swimming' }), CTX).lt1_used).toBe(153);
    const own = { ...CTX, thresholds: [...CTX.thresholds, row('2026-01-01', 'lt1_hr', 150)] };
    expect(sessionMetrics(input(), own).lt1_used).toBe(150);
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

describe('load sources: power, then pace, then heart rate', () => {
  const FULL: SessionContext = {
    ...CTX,
    thresholds: [...CTX.thresholds, row('2026-01-01', 'ftp_w', 250), row('2026-01-01', 'run_threshold_pace_s_per_km', 250)],
  };
  const ride = (extra: Partial<SessionInput> = {}) => input({ type: 'road_biking', np_w: 200, ...extra });
  const run = (extra: Partial<SessionInput> = {}) => input({ gap_mps: 3.5, ...extra });

  it('power: IF = NP / FTP, TSS = h × IF² × 100 (Coggan)', () => {
    expect(powerCandidate(200, 250, 3600)).toEqual({ source: 'power', tss: 64.00000000000001, if: 0.8 });
    const s = sessionMetrics(ride(), FULL);
    expect(s).toMatchObject({ tss: 64, if: 0.8, load_source: 'power', hrtss: 82.6 });
  });

  it('pace: IF = GAP / threshold speed, rTSS = h × IF² × 100', () => {
    const c = paceCandidate(3.5, 250, 3600);
    expect(c?.if).toBeCloseTo(0.875, 10);
    expect(c?.tss).toBeCloseTo(76.5625, 10);
    const s = sessionMetrics(run(), FULL);
    expect(s).toMatchObject({ tss: 76.6, if: 0.875, load_source: 'pace', hrtss: 69.4 });
  });

  it('heart rate: hrTSS when the sport has no power or pace candidate', () => {
    expect(sessionMetrics(input(), FULL)).toMatchObject({ tss: 69.4, if: 0.833, load_source: 'hr', hrtss: 69.4 });
    // power counts for cycling only, pace for running only
    expect(sessionMetrics(run({ np_w: 300 }), { ...FULL, thresholds: [...CTX.thresholds, row('2026-01-01', 'ftp_w', 250)] }).load_source).toBe('hr');
    expect(sessionMetrics(ride({ np_w: undefined, gap_mps: 8 }), FULL).load_source).toBe('hr');
    expect(sessionMetrics(input({ type: 'lap_swimming' }), FULL).load_source).toBe('hr');
  });

  it('a missing threshold falls through to heart rate, with a note', () => {
    const notes: string[] = [];
    expect(sessionMetrics(ride(), CTX, (n) => notes.push(n))).toMatchObject({ tss: 82.6, load_source: 'hr' });
    expect(sessionMetrics(run(), CTX, (n) => notes.push(n))).toMatchObject({ tss: 69.4, load_source: 'hr' });
    expect(notes).toEqual([NO_FTP_NOTE, NO_THRESHOLD_PACE_NOTE]);
    const quiet: string[] = [];
    sessionMetrics(input(), CTX, (n) => quiet.push(n));
    expect(quiet).toEqual([]);
  });

  it('zero is no load: NP 0, GAP 0 or a stress rounding to 0 fall through; nothing left is absent, never 0', () => {
    expect(sessionMetrics(ride({ np_w: 0 }), FULL).load_source).toBe('hr');
    expect(sessionMetrics(run({ gap_mps: 0 }), FULL).load_source).toBe('hr');
    expect(powerCandidate(200, 0, 3600)).toBeUndefined();
    expect(paceCandidate(3.5, 250, 0)).toBeUndefined();
    expect(resolveLoad([{ source: 'power', tss: 0.04, if: 0.1 }, { source: 'hr', tss: 50, if: 0.7 }])).toEqual({ tss: 50, if: 0.7, load_source: 'hr' });
    expect(resolveLoad([{ source: 'power', tss: Number.NaN, if: 1 }, { source: 'hr', tss: -3, if: 1 }])).toEqual({ load_source: 'none' });
    expect(resolveLoad([undefined])).toEqual({ load_source: 'none' });
    const none = sessionMetrics(ride({ np_w: undefined, avg_hr: undefined }), FULL);
    expect(none).toMatchObject({ load_source: 'none', hrtss: 0 });
    expect(none.tss).toBeUndefined();
    expect(none.if).toBeUndefined();
  });

  it('takes FTP and threshold pace valid on the session date', () => {
    const ctx = { ...FULL, thresholds: [...FULL.thresholds, row('2026-06-01', 'ftp_w', 200), row('2026-06-01', 'run_threshold_pace_s_per_km', 1000 / 3.5)] };
    expect(sessionMetrics(ride({ date: '2026-05-31' }), ctx).tss).toBe(64);
    expect(sessionMetrics(ride({ date: '2026-06-01' }), ctx)).toMatchObject({ tss: 100, if: 1 });
    expect(sessionMetrics(run({ date: '2026-06-01' }), ctx)).toMatchObject({ tss: 100, if: 1 });
  });
});

describe('load source: swim pace from CSS (sTSS)', () => {
  // TrainingPeaks' example: CSS 75 m/min (80 s per 100 m), 1 600 m in 23:10 of moving time.
  const WITH_CSS: SessionContext = { ...CTX, thresholds: [...CTX.thresholds, row('2026-01-01', 'css_s_per_100m', 80)] };
  const swim = (extra: Partial<SessionInput> = {}) =>
    input({ type: 'lap_swimming', distance_m: 1600, moving_s: 23 * 60 + 10, duration_s: 1800, avg_hr: 140, ...extra });

  it('IF = speed / CSS speed, sTSS = moving h × IF³ × 100 (article: IF 0.92, sTSS ≈ 30)', () => {
    const c = swimPaceCandidate(1600, 1390, 80);
    expect(c?.source).toBe('swim_pace');
    expect(c?.if).toBeCloseTo(1600 / 1390 / 1.25, 10);
    expect(c?.tss).toBeCloseTo((1390 / 3600) * (1600 / 1390 / 1.25) ** 3 * 100, 10);
    const s = sessionMetrics(swim(), WITH_CSS);
    expect(s).toMatchObject({ tss: 30.2, if: 0.921, load_source: 'swim_pace' });
    expect(round(s.if, 2)).toBe(0.92);
    // the heart-rate candidate stays on the session for source "hrtss"
    expect(s.hrtss).toBe(round(hrTss(1800, intensityFactor(140, 50, 170)), 1));
  });

  it('the cube: an hour at 1.1 × CSS speed scores 133.1, not 121 as with the square', () => {
    const fast = swimPaceCandidate(3960, 3600, 100);
    expect(fast?.if).toBeCloseTo(1.1, 10);
    expect(fast?.tss).toBeCloseTo(133.1, 6);
  });

  it('without CSS, distance or moving time a swim uses heart rate, as before', () => {
    const notes: string[] = [];
    expect(sessionMetrics(swim(), CTX, (n) => notes.push(n)).load_source).toBe('hr');
    expect(notes).toEqual([NO_CSS_NOTE]);
    const quiet: string[] = [];
    expect(sessionMetrics(swim({ moving_s: undefined }), WITH_CSS, (n) => quiet.push(n)).load_source).toBe('hr');
    expect(sessionMetrics(swim({ moving_s: undefined }), CTX, (n) => quiet.push(n)).load_source).toBe('hr');
    expect(sessionMetrics(swim({ distance_m: 0 }), WITH_CSS).load_source).toBe('hr');
    expect(quiet).toEqual([]);
    expect(swimPaceCandidate(1600, 1390, 0)).toBeUndefined();
  });

  it('CSS counts for the swim group only and is taken on the session date', () => {
    expect(sessionMetrics(input({ distance_m: 1600, moving_s: 1390 }), WITH_CSS).load_source).toBe('hr');
    const ctx = { ...WITH_CSS, thresholds: [...WITH_CSS.thresholds, row('2026-06-01', 'css_s_per_100m', 1390 / 16)] };
    expect(sessionMetrics(swim({ date: '2026-05-31' }), ctx).tss).toBe(30.2);
    expect(sessionMetrics(swim({ date: '2026-06-01' }), ctx)).toMatchObject({ if: 1, tss: round((1390 / 3600) * 100, 1) });
  });
});

describe('heart rate from the time in zones (hrTSS by zones)', () => {
  const DEFAULT = { zone1Floor: 94, zone2Floor: 134, zone3Floor: 154, zone4Floor: 163, zone5Floor: 174, maxHeartRateUsed: 185 };
  const CYCLING = { zone1Floor: 90, zone2Floor: 120, zone3Floor: 140, zone4Floor: 150, zone5Floor: 160, maxHeartRateUsed: 175 };
  const floors: ProfileZoneFloors = { DEFAULT, CYCLING };
  const ZONES: SessionContext = { ...CTX, floors };
  // 20 min of warm-up and cool-down plus 4 × 3 min of recovery in zone 1, 5 × 3 min in zone 5; average HR 135.
  const intervals = input({ duration_s: 2820, avg_hr: 135, zones_s: [1920, 0, 0, 0, 900] });

  it('IF_z from the middle of each zone (zone 5 up to HRmax), hrTSS = Σ hours_z × IF_z² × 100', () => {
    const c = hrZonesCandidate([1920, 0, 0, 0, 900], zoneBounds(DEFAULT), 50, 170);
    const if1 = (114 - 50) / 120;
    const if5 = (179.5 - 50) / 120;
    expect(c?.source).toBe('hr');
    expect(c?.tss).toBeCloseTo(((1920 * if1 ** 2 + 900 * if5 ** 2) / 3600) * 100, 10);
    expect(c?.if).toBeCloseTo(Math.sqrt((1920 * if1 ** 2 + 900 * if5 ** 2) / 2820), 10);
    // a zone whose middle is at or below RHR adds time but no stress
    expect(hrZonesCandidate([3600, 0, 0, 0, 0], zoneBounds(DEFAULT), 120, 170)).toEqual({ source: 'hr', tss: 0, if: 0 });
  });

  it('no candidate without time in zones, without bounds, or when LTHR ≤ RHR', () => {
    expect(hrZonesCandidate(undefined, zoneBounds(DEFAULT), 50, 170)).toBeUndefined();
    expect(hrZonesCandidate([0, 0, 0, 0, 0], zoneBounds(DEFAULT), 50, 170)).toBeUndefined();
    expect(hrZonesCandidate([600, 0, 0, 0, 0], undefined, 50, 170)).toBeUndefined();
    expect(hrZonesCandidate([600, 0, 0, 0, 0], zoneBounds(DEFAULT), 170, 170)).toBeUndefined();
  });

  it('intervals 5 × 3 min in zone 5 with recoveries in zone 1 score clearly more than from the average HR', () => {
    const zones = sessionMetrics(intervals, ZONES);
    const avg = sessionMetrics(intervals, CTX);
    expect(zones).toMatchObject({ hr_method: 'zones', load_source: 'hr', tss: 44.3, if: 0.752, hrtss: 44.3 });
    expect(avg).toMatchObject({ hr_method: 'avg', load_source: 'hr', tss: 39.3, if: 0.708, hrtss: 39.3 });
    expect(zones.hrtss).toBeGreaterThan(avg.hrtss * 1.1);
  });

  it('a steady session scores almost the same as from the average HR', () => {
    const steady = input({ avg_hr: 145, zones_s: [120, 3360, 120, 0, 0] });
    const zones = sessionMetrics(steady, ZONES);
    const avg = sessionMetrics(steady, CTX);
    expect(zones.hr_method).toBe('zones');
    expect(Math.abs(zones.hrtss - avg.hrtss) / avg.hrtss).toBeLessThan(0.05);
  });

  it('falls back to the average HR without zones, without profile bounds, or with hr_method avg', () => {
    expect(sessionMetrics(input(), ZONES)).toMatchObject({ hr_method: 'avg', hrtss: 69.4 });
    expect(sessionMetrics(intervals, { ...CTX, floors: {} })).toMatchObject({ hr_method: 'avg', hrtss: 39.3 });
    expect(sessionMetrics(intervals, { ...ZONES, hr_method: 'avg' })).toMatchObject({ hr_method: 'avg', hrtss: 39.3 });
    expect(sessionMetrics(input({ avg_hr: undefined, zones_s: undefined }), ZONES)).toMatchObject({ hr_method: 'avg', hrtss: 0, load_source: 'none' });
  });

  it('cycling uses the CYCLING bounds with the cycling LTHR, other sports the DEFAULT ones', () => {
    const ride = input({ type: 'road_biking', duration_s: 3600, avg_hr: 145, zones_s: [0, 0, 0, 3600, 0] });
    // zone 4 of CYCLING is 150-160: IF = (155 - 50) / (160 - 50)
    expect(sessionMetrics(ride, ZONES).hrtss).toBe(round(((155 - 50) / 110) ** 2 * 100, 1));
    expect(sessionMetrics(ride, { ...ZONES, floors: { DEFAULT } }).hrtss).toBe(round(((168.5 - 50) / 110) ** 2 * 100, 1));
  });

  it('power and pace still come before the zone-based heart rate', () => {
    const full: SessionContext = { ...ZONES, thresholds: [...CTX.thresholds, row('2026-01-01', 'run_threshold_pace_s_per_km', 250)] };
    expect(sessionMetrics({ ...intervals, gap_mps: 3.5 }, full)).toMatchObject({ load_source: 'pace', hr_method: 'zones', hrtss: 44.3 });
  });
});

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

  it('hiking: grade adjusted speed in m/min per beat, only with GAP, distance and elevation', () => {
    const hike = { avg_hr: 120, duration_s: 7200, distance_m: 8000, elev_gain_m: 600, gap_mps: 1.5 };
    expect(efficiencyFactor('hike', hike)).toBeCloseTo(0.75, 10);
    expect(hikeGap(hike)).toBe(1.5);
    expect(efficiencyFactorGap('hike', 120, hikeGap(hike))).toBeCloseTo(0.75, 10);
    expect(efficiencyFactor('hike', { ...hike, gap_mps: undefined })).toBeUndefined();
    expect(efficiencyFactor('hike', { ...hike, elev_gain_m: undefined })).toBeUndefined();
    expect(efficiencyFactor('hike', { ...hike, distance_m: undefined })).toBeUndefined();
    expect(hikeGap({ ...hike, elev_gain_m: undefined })).toBeUndefined();
  });

  it('undefined for other sports and for missing inputs', () => {
    expect(efficiencyFactor('swim', { avg_hr: 140, duration_s: 1800, distance_m: 2000 })).toBeUndefined();
    expect(efficiencyFactor('nordic', { avg_hr: 140, duration_s: 3600, distance_m: 12_000 })).toBeUndefined();
    expect(efficiencyFactor('row', { avg_hr: 140, duration_s: 3600, distance_m: 12_000 })).toBeUndefined();
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

describe('load source: session RPE last (Foster)', () => {
  const strength = (extra: Partial<SessionInput> = {}) => input({ type: 'strength_training', avg_hr: undefined, rpe: 6, ...extra });

  it('RPE × minutes × 0.23, no IF; the default calibration lives in load.ts', () => {
    expect(rpeCandidate(6, 3600)).toEqual({ source: 'rpe', tss: 6 * 60 * RPE_LOAD_CALIBRATION });
    expect(RPE_LOAD_CALIBRATION).toBe(0.23);
    const s = sessionMetrics(strength({ duration_s: 2700 }), CTX);
    expect(s).toMatchObject({ tss: 62.1, load_source: 'rpe', hrtss: 0, rpe: 6 });
    expect(s.if).toBeUndefined();
  });

  it('strength without heart rate gets a load only from RPE', () => {
    expect(sessionMetrics(strength({ rpe: undefined }), CTX)).toMatchObject({ load_source: 'none' });
    expect(sessionMetrics(strength(), CTX)).toMatchObject({ tss: 82.8, load_source: 'rpe' });
  });

  it('comes after every measured source: heart rate, power and pace win', () => {
    expect(sessionMetrics(input({ rpe: 9 }), CTX)).toMatchObject({ tss: 69.4, load_source: 'hr' });
    const full: SessionContext = { ...CTX, thresholds: [...CTX.thresholds, row('2026-01-01', 'ftp_w', 250)] };
    expect(sessionMetrics(input({ type: 'road_biking', np_w: 200, avg_hr: undefined, rpe: 9 }), full)).toMatchObject({ tss: 64, load_source: 'power' });
    // a measured source that gives 0 falls through to RPE
    expect(sessionMetrics(input({ avg_hr: 40, rpe: 5 }), CTX)).toMatchObject({ tss: 69, load_source: 'rpe', hrtss: 0 });
  });

  it('the calibration is overridable through the context', () => {
    expect(sessionMetrics(strength(), { ...CTX, rpe_calibration: 0.2 })).toMatchObject({ tss: 72, load_source: 'rpe' });
    expect(sessionMetrics(strength(), { ...CTX, rpe_calibration: 0 })).toMatchObject({ load_source: 'none' });
  });

  it('RPE outside CR-10 1–10, or no duration, is no candidate', () => {
    expect(rpeCandidate(0, 3600)).toBeUndefined();
    expect(rpeCandidate(11, 3600)).toBeUndefined();
    expect(rpeCandidate(Number.NaN, 3600)).toBeUndefined();
    expect(rpeCandidate(5, 0)).toBeUndefined();
    expect(rpeCandidate(5, undefined)).toBeUndefined();
    expect(sessionMetrics(strength({ rpe: 60 }), CTX).load_source).toBe('none');
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
      rpe: 6,
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

  it('reads RPE/feel from summaryDTO first (as get_activity does), RPE 10–100 as CR-10', () => {
    const both = { summaryDTO: { directWorkoutRpe: 70, directWorkoutFeel: 25 }, metadataDTO: { workoutRpe: 30, workoutFeel: 100 } };
    expect(sessionFromActivity(activity(), both)).toMatchObject({ rpe: 7, feel: 25 });
    expect(sessionFromActivity(activity(), { summaryDTO: { directWorkoutRpe: 100 } })?.rpe).toBe(10);
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

describe('running dynamics of a session', () => {
  it('reads them from the activity list entry, dropping zeros, stride in metres', () => {
    const raw = { avgGroundContactTime: 276.3, avgGroundContactBalance: 49.72, avgVerticalOscillation: 8.6, avgVerticalRatio: 8.87, avgStrideLength: 96.91, avgRespirationRate: 32.7 };
    expect(sessionMetrics(sessionFromActivity(activity({}, raw)) ?? input(), CTX)).toMatchObject({
      gct_ms: 276,
      gct_balance_left_pct: 49.7,
      vertical_oscillation_cm: 8.6,
      vertical_ratio_pct: 8.9,
      stride_m: 0.97,
      avg_respiration_brpm: 32.7,
    });
    const none = sessionMetrics(sessionFromActivity(activity({}, { avgGroundContactTime: 0, avgStrideLength: 0 })) ?? input(), CTX);
    expect(none.gct_ms).toBeUndefined();
    expect(none.stride_m).toBeUndefined();
  });
});

describe('aerobic decoupling (Pa:Hr, Pw:Hr)', () => {
  /** 6 × 10 min at a constant 200 W with HR rising from 130 to 140. */
  const steadyRide: Lap[] = [130, 132, 134, 136, 138, 140].map((hr) => ({ duration_s: 600, avg_hr: hr, avg_power_w: 200 }));
  const ride = (extra: Partial<SessionInput> = {}) => input({ type: 'road_biking', avg_hr: 135, laps: steadyRide, ...extra });

  it('constant power with rising heart rate gives a positive percentage: (EF1 − EF2) / EF1', () => {
    // Halves: HR 132 and 138 at 200 W → (200/132 − 200/138) / (200/132) = 1 − 132/138.
    expect(decoupling(steadyRide, 'avg_power_w')).toBeCloseTo((1 - 132 / 138) * 100, 6);
    expect(sessionMetrics(ride(), CTX).decoupling_pct).toBe(4.3);
  });

  it('steady heart rate gives 0, a lap across the middle counts in both halves by its time', () => {
    const flat: Lap[] = [0, 1, 2, 3].map(() => ({ duration_s: 900, avg_hr: 140, gap_mps: 3 }));
    expect(decoupling(flat, 'gap_mps')).toBe(0);
    // 3 laps of 20 min: the middle lap is split 10 / 10 min; halves HR (130·20 + 140·10)/30 and (140·10 + 150·20)/30.
    const three: Lap[] = [130, 140, 150].map((hr) => ({ duration_s: 1200, avg_hr: hr, gap_mps: 3 }));
    const four = [...three, { duration_s: 0.000001, avg_hr: 150, gap_mps: 3 }];
    const h1 = (130 * 20 + 140 * 10) / 30;
    const h2 = (140 * 10 + 150 * 20) / 30;
    expect(decoupling(four, 'gap_mps')).toBeCloseTo((1 - h1 / h2) * 100, 3);
  });

  it('running uses the grade adjusted speed of each lap', () => {
    const laps: Lap[] = [3.2, 3.2, 3.1, 3.0].map((gap) => ({ duration_s: 900, avg_hr: 145, gap_mps: gap }));
    const s = sessionMetrics(input({ duration_s: 3600, avg_hr: 145, laps }), CTX);
    expect(s.decoupling_pct).toBe(round((1 - 3.05 / 3.2) * 100, 1));
  });

  it('no field when shorter than 60 min, at or above LTHR, without laps, with too few laps or in a sport without the metric', () => {
    expect(sessionMetrics(ride({ duration_s: 3599 }), CTX).decoupling_pct).toBeUndefined();
    expect(sessionMetrics(ride({ avg_hr: 160 }), CTX).decoupling_pct).toBeUndefined(); // lthr_bike 160
    expect(sessionMetrics(ride({ laps: undefined }), CTX).decoupling_pct).toBeUndefined();
    expect(sessionMetrics(ride({ laps: steadyRide.slice(0, 3) }), CTX).decoupling_pct).toBeUndefined();
    expect(sessionMetrics(ride({ type: 'lap_swimming' }), CTX).decoupling_pct).toBeUndefined();
    expect(sessionMetrics(ride({ type: 'hiking' }), CTX).decoupling_pct).toBeUndefined();
  });

  it('running reports Pw:Hr next to Pa:Hr, or instead of it when its laps have no grade adjusted speed, and names the basis', () => {
    const laps: Lap[] = [3.2, 3.2, 3.1, 3.0].map((gap, i) => ({ duration_s: 900, avg_hr: 145, gap_mps: gap, avg_power_w: [300, 300, 290, 290][i] }));
    expect(sessionMetrics(input({ duration_s: 3600, avg_hr: 145, laps }), CTX)).toMatchObject({
      decoupling_pct: round((1 - 3.05 / 3.2) * 100, 1),
      decoupling_basis: 'pa_hr',
      decoupling_pw_pct: round((1 - 290 / 300) * 100, 1),
    });
    const powerOnly = sessionMetrics(input({ laps: steadyRide }), CTX);
    expect(powerOnly).toMatchObject({ decoupling_pct: 4.3, decoupling_basis: 'pw_hr' });
    expect(powerOnly.decoupling_pw_pct).toBeUndefined();
    expect(sessionMetrics(ride(), CTX)).toMatchObject({ decoupling_pct: 4.3, decoupling_basis: 'pw_hr' });
    expect(sessionMetrics(ride(), CTX).decoupling_pw_pct).toBeUndefined();
  });

  it('ef_power for runs with power: normalized power, else average power, per beat', () => {
    expect(sessionMetrics(input({ avg_hr: 150, np_w: 300, avg_power_w: 290 }), CTX).ef_power).toBe(2);
    expect(sessionMetrics(input({ avg_hr: 145, avg_power_w: 290 }), CTX).ef_power).toBe(2);
    expect(sessionMetrics(input({ avg_hr: 150 }), CTX).ef_power).toBeUndefined();
    expect(sessionMetrics(input({ type: 'road_biking', avg_hr: 140, np_w: 200 }), CTX).ef_power).toBeUndefined();
  });

  it('nordic and row use power like the bike', () => {
    expect(sessionMetrics(ride({ type: 'skate_ski' }), CTX).decoupling_pct).toBe(4.3);
    expect(sessionMetrics(ride({ type: 'rowing' }), CTX).decoupling_pct).toBe(4.3);
  });

  it('lapsFrom reads lapDTOs of the splits detail; sessionFromActivity passes them', () => {
    expect(lapsFrom(undefined)).toBeUndefined();
    expect(lapsFrom({ lapDTOs: [] })).toEqual([]);
    expect(lapsFrom({ lapDTOs: [{ duration: 320.5, averageHR: 148, avgGradeAdjustedSpeed: 3.236, averagePower: 361 }, { duration: 0, averageHR: 150 }] })).toEqual([
      { duration_s: 320.5, avg_hr: 148, gap_mps: 3.236, avg_power_w: 361 },
    ]);
    expect(sessionFromActivity(activity(), undefined, { lapDTOs: [{ duration: 600, averageHR: 140 }] })?.laps).toEqual([{ duration_s: 600, avg_hr: 140 }]);
    expect(sessionFromActivity(activity())?.laps).toBeUndefined();
  });
});
