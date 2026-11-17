import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { filterStream, streamSummary, type StreamSample } from './stream.js';

/** 10 min at 3⅓ m/s (5:00 /km) every 10 s; HR 140 in the first half and 150 in the second; Performance Condition from minute 6. */
const steady: StreamSample[] = Array.from({ length: 61 }, (_, i) => ({
  directTimestamp: 1_791_000_000_000 + i * 10_000,
  sumDuration: i * 10,
  sumDistance: (i * 10 * 10) / 3,
  directHeartRate: i <= 30 ? 140 : 150,
  directPower: 300,
  directDoubleCadence: i === 45 ? 0 : 170,
  directGroundContactTime: 250,
  directElevation: 100 + i,
  directAvailableStamina: 100 - i,
  directPerformanceCondition: i >= 36 ? (i >= 50 ? -1 : 2) : null,
}));

describe('stream summary', () => {
  it('splits the timer time into halves with time-weighted means', () => {
    const s = streamSummary(steady, 'halves', true);
    expect(s).toMatchObject({ bucket: 'halves', samples: 61 });
    expect(s?.buckets).toEqual([
      expect.objectContaining({ n: 1, from: '0:00', to: '5:00', distance_km: 1, avg_pace: '5:00 /km', avg_hr_bpm: 140, max_hr_bpm: 140, avg_power_w: 300, cadence_spm: 170, gct_ms: 250, elevation_change_m: 30, stamina_end_pct: 70 }),
      expect.objectContaining({ n: 2, from: '5:00', to: '10:00', distance_km: 1, avg_hr_bpm: 150, max_hr_bpm: 150, elevation_change_m: 30, stamina_end_pct: 40 }),
    ]);
    // Cadence 0 (standing) is left out of the mean, not averaged in.
    expect(s?.buckets[1]?.cadence_spm).toBe(170);
    expect(s?.performance_condition).toEqual({ first: 2, first_at: '6:00', end: -1, min: -1, max: 2 });
  });

  it('buckets per kilometre, per 5 minutes and per quarter', () => {
    expect(streamSummary(steady, 'km', true)?.buckets.map((b) => [b.n, b.distance_km, b.avg_pace])).toEqual([
      [1, 1, '5:00 /km'],
      [2, 1, '5:00 /km'],
    ]);
    expect(streamSummary(steady, '5min', true)?.buckets.map((b) => [b.from, b.to])).toEqual([
      ['0:00', '5:00'],
      ['5:00', '10:00'],
    ]);
    const q = streamSummary(steady, 'quarters', false)?.buckets;
    expect(q?.map((b) => b.to)).toEqual(['2:30', '5:00', '7:30', '10:00']);
    // Not a foot sport: speed instead of pace.
    expect(q?.[0]).toMatchObject({ avg_speed_kmh: 12 });
    expect(q?.[0]?.avg_pace).toBeUndefined();
  });

  it('needs two timed samples, and distance for kilometres', () => {
    expect(streamSummary(steady.slice(0, 1), 'halves', true)).toBeUndefined();
    expect(streamSummary(steady.map(({ sumDistance: _d, ...s }) => s), 'km', true)).toBeUndefined();
    // Without timer sums the timestamps place the samples.
    expect(streamSummary(steady.map(({ sumDuration: _t, ...s }) => s), 'halves', true)?.buckets).toHaveLength(2);
  });

  it('gives a row per climb with gain, grades, VAM and W/kg', () => {
    // A ride every 5 s: 2 km flat at 10 m/s and 150 W, 1.5 km at 6 % at 4 m/s and 280 W, 2 km flat.
    const ride: StreamSample[] = [];
    let t = 0;
    for (let d = 0; d <= 5500; t += 5) {
      const climbing = d >= 2000 && d < 3500;
      ride.push({ sumDuration: t, sumDistance: d, directElevation: 100 + Math.min(90, Math.max(0, (d - 2000) * 0.06)), directPower: climbing ? 280 : 150, directHeartRate: climbing ? 160 : 130 });
      d += climbing ? 20 : 50;
    }
    const s = streamSummary(ride, 'climbs', false, { weightKg: 70 });
    expect(s?.bucket).toBe('climbs');
    expect(s?.buckets).toHaveLength(1);
    const c = s?.buckets[0];
    expect(c).toMatchObject({ n: 1, avg_hr_bpm: expect.any(Number), elevation_gain_m: 90, max_grade_pct: 6 });
    expect(c?.start_km).toBeCloseTo(2, 1);
    expect(c?.distance_km).toBeCloseTo(1.5, 1);
    expect(c?.avg_speed_kmh).toBeCloseTo(14.4, 0);
    expect(c?.avg_grade_pct).toBeGreaterThan(5.6);
    // 90 m in about 375 s of the climb.
    expect(c?.vam_m_h).toBeGreaterThan(800);
    expect(c?.vam_m_h).toBeLessThan(900);
    expect(c?.avg_power_w).toBeGreaterThan(270);
    expect(c?.w_per_kg).toBeCloseTo((c?.avg_power_w ?? 0) / 70, 1);
    expect(c?.elevation_change_m).toBeUndefined();
    // Without a weight no W/kg; on the flat an empty list; without elevation nothing to read.
    expect(streamSummary(ride, 'climbs', false)?.buckets[0]?.w_per_kg).toBeUndefined();
    expect(streamSummary(ride.map((x) => ({ ...x, directElevation: 100 })), 'climbs', false)?.buckets).toEqual([]);
    expect(streamSummary(ride.map(({ directElevation: _e, ...x }) => x), 'climbs', false)).toBeUndefined();
  });

  it('aggregates a recorded trail run stream', () => {
    const raw = JSON.parse(fs.readFileSync(new URL('../../client/fixtures/activity-details.json', import.meta.url), 'utf8')) as {
      metricDescriptors: { metricsIndex: number; key: string }[];
      activityDetailMetrics: { metrics: (number | null)[] }[];
    };
    const keys = raw.metricDescriptors.toSorted((a, b) => a.metricsIndex - b.metricsIndex).map((d) => d.key);
    const samples = raw.activityDetailMetrics.map((m) => Object.fromEntries(keys.map((k, i) => [k, m.metrics[i] ?? null])));
    const halves = streamSummary(samples, 'halves', true);
    expect(halves?.buckets).toHaveLength(2);
    for (const b of halves?.buckets ?? []) {
      expect(b.avg_hr_bpm).toBeGreaterThan(80);
      expect(b.cadence_spm).toBeGreaterThan(100);
      expect(b.stride_m).toBeGreaterThan(0.5);
      expect(b.gct_ms).toBeGreaterThan(150);
      expect(b.avg_gap_pace).toMatch(/^\d+:\d\d \/km$/);
    }
    expect(halves?.performance_condition).toBeUndefined();
  });
});

describe('stream filter', () => {
  const keys = Object.keys(steady[0] ?? {});

  it('keeps the asked metrics plus timestamp and timer, and reports unknown ones', () => {
    const f = filterStream(keys, steady, { metrics: ['directHeartRate', 'directNoSuch'] });
    expect(f.keys).toEqual(['directTimestamp', 'sumDuration', 'directHeartRate']);
    expect(f.samples[0]).toEqual({ directTimestamp: 1_791_000_000_000, sumDuration: 0, directHeartRate: 140 });
    expect(f.unknown).toEqual(['directNoSuch']);
  });

  it('downsamples to one sample per given seconds of timer time', () => {
    const f = filterStream(keys, steady, { downsampleS: 60 });
    expect(f.samples.map((s) => s.sumDuration)).toEqual([0, 60, 120, 180, 240, 300, 360, 420, 480, 540, 600]);
    expect(f.keys).toEqual(keys);
    expect(filterStream(keys, steady, {}).samples).toHaveLength(61);
  });
});
