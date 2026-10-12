import { InputError } from 'garmin-mcp-config';
import { describe, expect, it } from 'vitest';
import type { ActivityRow, DailyRows } from 'garmin-mcp-store';
import { periodActivitySummary } from './activities.js';
import { calendarEvent } from './calendar.js';
import { compact, hms, pacePerKm } from './format.js';
import { healthTable } from './health.js';
import { formState, trainingLoadSeries } from './load.js';
import { decodeCursor, encodeCursor, pageBySize } from './paging.js';
import { trend } from './stats.js';
import { statusLabel, trainingOverview } from './training.js';
import { unzip } from './zip.js';
import { makeZip } from './test-utils/zip.js';

const day = (i: number) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);

describe('format', () => {
  it('formats durations and pace', () => {
    expect(hms(3725)).toBe('1:02:05');
    expect(hms(65)).toBe('1:05');
    expect(pacePerKm(1000 / 300)).toBe('5:00 /km');
  });
  it('compacts empty values recursively', () => {
    expect(compact({ a: 1, b: null, c: '', d: [], e: { f: undefined }, g: [null, 2], h: 0 })).toEqual({ a: 1, g: [2], h: 0 });
  });
});

describe('training load', () => {
  it('converges to a constant daily load and computes TSB from the previous day', () => {
    const acts = Array.from({ length: 300 }, (_, i) => ({ date: day(i), training_load: 100 }));
    const series = trainingLoadSeries(acts, day(299), day(299));
    expect(series).toHaveLength(1);
    expect(series[0]?.ctl).toBeGreaterThan(99);
    expect(series[0]?.atl).toBeCloseTo(100, 0);
    expect(Math.abs(series[0]?.tsb ?? 99)).toBeLessThan(1);
  });

  it('shows fatigue after a load block and freshness after rest', () => {
    const block = Array.from({ length: 60 }, (_, i) => ({ date: day(i), training_load: i >= 50 ? 250 : 80 }));
    const tired = trainingLoadSeries(block, day(59), day(59))[0];
    expect(tired && tired.atl > tired.ctl).toBe(true);
    expect(tired && formState(tired)).toBe('overreaching');
    const rested = trainingLoadSeries(block, day(75), day(75))[0];
    expect(rested && formState(rested)).toBe('fresh');
  });

  it('labels Garmin status phrases', () => expect(statusLabel('PRODUCTIVE_1')).toBe('productive'));

  it('explains that form bands are scaled to CTL, not Coggan\'s absolute TSB bands', () => {
    const note = trainingOverview([], [{ date: day(0), training_load: 80 }], day(0), day(0), false).note;
    expect(note).toContain('garmin_load_model.form uses TSB bands scaled to CTL');
    expect(note).toContain('not Coggan\'s absolute TSB bands, because Garmin training load is on an EPOC scale');
  });
});

describe('trend', () => {
  it('detects direction and averages', () => {
    const rising = Array.from({ length: 28 }, (_, i) => ({ date: day(i), value: 50 + i }));
    const t = trend(rising, day(27));
    expect(t).toMatchObject({ latest: 77, avg_7d: 74, direction: 'rising', samples: 28 });
    const flat = Array.from({ length: 28 }, (_, i) => ({ date: day(i), value: 50 + (i % 2) * 0.1 }));
    expect(trend(flat, day(27)).direction).toBe('stable');
    expect(trend([], day(0)).samples).toBe(0);
  });
});

const dailyRow = (date: string, steps: number, im: number): DailyRows['daily_summary'] => ({
  date,
  fetched_at: 0,
  raw: {},
  steps,
  resting_hr: 50,
  avg_stress: 30,
  body_battery_high: 90,
  body_battery_low: 20,
  total_calories: 2500,
  active_calories: 500,
  intensity_minutes: im,
  avg_spo2: 96,
  avg_respiration: 14,
});

describe('healthTable', () => {
  const rows = { daily: Array.from({ length: 14 }, (_, i) => dailyRow(day(4 + i), 10_000 + i * 100, 30)), sleep: [], hrv: [] };

  it('builds a day table with units in field names', () => {
    const t = healthTable(['steps', 'resting_hr'], rows, day(4), day(5), 'day');
    expect(t.rows).toEqual([
      { date: day(4), steps: 10_000, resting_hr_bpm: 50 },
      { date: day(5), steps: 10_100, resting_hr_bpm: 50 },
    ]);
    expect(t.summary.steps).toMatchObject({ avg: 10_050, total: 20_100, days_with_data: 2 });
  });

  it('aggregates ISO weeks, summing intensity minutes', () => {
    // 2026-01-05 is a Monday.
    const t = healthTable(['intensity_minutes', 'steps'], rows, day(4), day(17), 'week');
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0]).toMatchObject({ week: '2026-W02', week_start: '2026-01-05', days: 7, intensity_min_total: 210 });
    expect(t.rows[0]?.steps_avg).toBe(10_300);
  });

  it('reads floors and min/max HR from the raw daily summary and HRV status/baseline from the hrv table', () => {
    const hrvRow = (date: string, ms: number, status: string | null): DailyRows['hrv'] => ({
      date,
      fetched_at: 0,
      raw: {},
      last_night_avg: ms,
      weekly_avg: 60,
      status,
      baseline_low: 54,
      baseline_high: 70,
    });
    const raw = (floors: number) => ({ floorsAscended: floors, minHeartRate: 45, maxHeartRate: 160 + floors });
    const src = {
      daily: [day(4), day(5), day(6)].map((d, i) => ({ ...dailyRow(d, 10_000, 30), raw: raw(8 + i) })),
      sleep: [],
      hrv: [hrvRow(day(4), 62, 'BALANCED'), hrvRow(day(5), 50, 'UNBALANCED'), hrvRow(day(6), 52, null)],
    };

    const t = healthTable(['floors', 'resting_hr', 'hrv'], src, day(4), day(5), 'day');
    expect(t.rows).toEqual([
      { date: day(4), floors: 8, resting_hr_bpm: 50, hr_min_bpm: 45, hr_max_bpm: 168, hrv_ms: 62, hrv_status: 'balanced', hrv_baseline_low_ms: 54, hrv_baseline_high_ms: 70 },
      { date: day(5), floors: 9, resting_hr_bpm: 50, hr_min_bpm: 45, hr_max_bpm: 169, hrv_ms: 50, hrv_status: 'unbalanced', hrv_baseline_low_ms: 54, hrv_baseline_high_ms: 70 },
    ]);
    expect(t.summary.floors).toMatchObject({ avg: 8.5, total: 17, days_with_data: 2 });
    expect(t.summary.hrv).toMatchObject({ avg: 56, min: 50, max: 62 });

    // 2026-01-05 is a Monday: all three days fall into one ISO week.
    const w = healthTable(['floors', 'resting_hr', 'hrv'], src, day(4), day(6), 'week');
    expect(w.rows[0]).toMatchObject({ days: 3, floors_avg: 9, hr_max_bpm_avg: 169, hrv_status_last: 'unbalanced', hrv_baseline_low_ms_avg: 54 });
  });

  it('leaves floors and min/max HR empty when the raw summary lacks them', () => {
    const t = healthTable(['floors', 'resting_hr'], { daily: [dailyRow(day(4), 10_000, 30)], sleep: [], hrv: [] }, day(4), day(4), 'day');
    expect(t.rows).toEqual([{ date: day(4), floors: undefined, resting_hr_bpm: 50, hr_min_bpm: undefined, hr_max_bpm: undefined }]);
    expect(t.summary.floors).toMatchObject({ days_with_data: 0 });
  });

  it('returns the daily distance in km next to steps, per day and averaged per week', () => {
    const src = {
      daily: [day(4), day(5), day(6)].map((d, i) => ({ ...dailyRow(d, 10_000, 30), raw: { totalDistanceMeters: 8_000 + i * 1_234 } })),
      sleep: [],
      hrv: [],
    };

    const t = healthTable(['steps'], src, day(4), day(5), 'day');
    expect(t.rows).toEqual([
      { date: day(4), steps: 10_000, distance_km: 8 },
      { date: day(5), steps: 10_000, distance_km: 9.23 },
    ]);

    // 2026-01-05 is a Monday: all three days fall into one ISO week.
    const w = healthTable(['steps'], src, day(4), day(6), 'week');
    expect(w.rows[0]).toMatchObject({ days: 3, steps_avg: 10_000, distance_km_avg: 9.23 });

    const empty = healthTable(['steps'], { daily: [dailyRow(day(4), 10_000, 30)], sleep: [], hrv: [] }, day(4), day(4), 'day');
    expect(empty.rows[0]).toHaveProperty('distance_km', undefined);
  });
});

const act = (id: number, date: string, type: string, extra: Partial<ActivityRow> = {}): ActivityRow => ({
  id,
  date,
  start_time_local: `${date}T07:00:00`,
  start_time_utc: `${date}T05:00:00Z`,
  type,
  name: `${type} ${date}`,
  duration_s: 3600,
  distance_m: 10_000,
  avg_hr: 140,
  max_hr: 170,
  avg_power: null,
  training_effect_aerobic: 3,
  training_effect_anaerobic: 1,
  training_load: 100,
  calories: 600,
  elevation_gain_m: 50,
  gear_uuid: null,
  raw: { activityId: id, hrTimeInZone_1: 600, hrTimeInZone_2: 3000 },
  fetched_at: 0,
  ...extra,
});

describe('periodActivitySummary', () => {
  it('summarises volume per sport, zones, rest days and the longest effort', () => {
    const s = periodActivitySummary(
      [act(1, '2026-01-05', 'running'), act(2, '2026-01-05', 'cycling', { duration_s: 7200, distance_m: 50_000 }), act(3, '2026-01-07', 'running')],
      '2026-01-05',
      '2026-01-11',
    );
    expect(s).toMatchObject({ sessions: 3, active_days: 2, rest_days: 5, total_distance_km: 70, total_training_load: 300 });
    expect(s.by_sport.map((x) => [x.sport, x.sessions])).toEqual([
      ['running', 2],
      ['cycling', 1],
    ]);
    expect(s.longest?.id).toBe(2);
    expect(s.hr_zones?.[1]).toMatchObject({ zone: 2, pct: 83 });
  });
});

describe('calendarEvent', () => {
  it('converts distance goals to km and drops what Garmin leaves blank', () => {
    expect(calendarEvent({ id: 1, date: '2026-11-01', title: ' 10 mile ', completionTarget: { value: 10, unit: 'mile', unitType: 'distance' }, isRace: false, location: ' ' })).toEqual({
      id: 1,
      date: '2026-11-01',
      title: '10 mile',
      distance_km: 16.09,
    });
    expect(compact(calendarEvent({ date: '2026-11-02', completionTarget: { value: 3600, unit: 'second', unitType: 'time' }, eventTimeLocal: null }))).toEqual({ date: '2026-11-02' });
    expect(compact(calendarEvent({ completionTarget: { value: 5, unit: 'furlong', unitType: 'distance' } }))).toEqual({});
    expect(compact(calendarEvent(null))).toEqual({});
  });
});

describe('paging', () => {
  it('round-trips cursors and rejects garbage', () => {
    expect(decodeCursor(encodeCursor(40))).toBe(40);
    expect(decodeCursor(undefined)).toBe(0);
    expect(() => decodeCursor('nope')).toThrow(InputError);
  });
  it('caps pages by serialized size', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ i, pad: 'x'.repeat(100) }));
    const first = pageBySize(items, 0, 1000);
    expect(first.page.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(first.page))).toBeLessThanOrEqual(1000);
    const all = [];
    for (let o: number | undefined = 0; o !== undefined; ) {
      const p: { page: unknown[]; next?: number } = pageBySize(items, o, 1000);
      all.push(...p.page);
      o = p.next;
    }
    expect(all).toHaveLength(100);
  });
});

describe('unzip', () => {
  it('extracts a deflated entry', () => {
    const fit = new Uint8Array(Buffer.from('.FIT file body '.repeat(50)));
    const [entry] = unzip(makeZip('123_ACTIVITY.fit', fit));
    expect(entry?.name).toBe('123_ACTIVITY.fit');
    expect(Buffer.from(entry?.data ?? []).equals(Buffer.from(fit))).toBe(true);
  });
});
