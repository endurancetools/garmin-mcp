import { describe, expect, it } from 'vitest';
import { MAX_GAP_S, MAX_HOLD_S, MAX_SPAN_S, readFit } from './read.js';
import { encodeFit, FIT_EPOCH_S, fileId, gearChange, record, session, timer, type RecordInput } from './test-utils/encode.js';

const T0 = 1_763_370_000; // 2025-11-17T09:00:00Z
const ride = (n: number, from = 0, extra: Partial<RecordInput> = {}) =>
  Array.from({ length: n }, (_, i) =>
    record({ time_s: T0 + from + i, power_w: 200 + i, heart_rate_bpm: 140, cadence: 90, speed_m_s: 8.5, elevation_m: 120.4, ...extra }),
  );

describe('readFit', () => {
  it('decodes 1 Hz records with scaled speed and elevation', async () => {
    const { records, gear_changes } = await readFit(encodeFit([fileId(), timer(T0, true), ...ride(3)]));
    expect(records).toEqual([
      { time_s: T0, power_w: 200, heart_rate_bpm: 140, cadence: 90, speed_m_s: 8.5, elevation_m: 120.4 },
      { time_s: T0 + 1, power_w: 201, heart_rate_bpm: 140, cadence: 90, speed_m_s: 8.5, elevation_m: 120.4 },
      { time_s: T0 + 2, power_w: 202, heart_rate_bpm: 140, cadence: 90, speed_m_s: 8.5, elevation_m: 120.4 },
    ]);
    expect(gear_changes).toEqual([]);
  });

  it('reads enhanced speed and altitude, and a value the device did not record as null', async () => {
    const bytes = encodeFit([record({ time_s: T0, power_w: null, heart_rate_bpm: 150, speed_m_s: 3.25, elevation_m: -12.6, enhanced: true })]);
    expect((await readFit(bytes)).records).toEqual([
      { time_s: T0, power_w: null, heart_rate_bpm: 150, cadence: null, speed_m_s: 3.25, elevation_m: -12.6 },
    ]);
  });

  it(`repeats the previous record across a gap of up to ${MAX_HOLD_S} s and leaves a longer gap empty`, async () => {
    const short = [...ride(1), ...ride(1, 4, { power_w: 300 })];
    const { records } = await readFit(encodeFit(short));
    expect(records.map((r) => r.power_w)).toEqual([200, 200, 200, 200, 300]);

    const long = [...ride(1), ...ride(1, MAX_HOLD_S + 2, { power_w: 300 })];
    const powers = (await readFit(encodeFit(long))).records.map((r) => r.power_w);
    expect(powers).toHaveLength(MAX_HOLD_S + 3);
    expect(powers.slice(0, MAX_HOLD_S + 1)).toEqual(Array.from({ length: MAX_HOLD_S + 1 }, () => 200));
    expect(powers.slice(MAX_HOLD_S + 1)).toEqual([null, 300]);
  });

  it('leaves seconds with the timer stopped empty', async () => {
    const bytes = encodeFit([timer(T0, true), ...ride(2), timer(T0 + 1, false), timer(T0 + 4, true), ...ride(1, 4, { power_w: 250 })]);
    const { records } = await readFit(bytes);
    expect(records.map((r) => [r.time_s - T0, r.power_w, r.heart_rate_bpm])).toEqual([
      [0, 200, 140],
      [1, 201, 140],
      [2, null, null],
      [3, null, null],
      [4, 250, 140],
    ]);
  });

  it('keeps the last of several records in one second', async () => {
    const bytes = encodeFit([...ride(1), record({ time_s: T0, power_w: 999 })]);
    expect((await readFit(bytes)).records).toEqual([
      { time_s: T0, power_w: 999, heart_rate_bpm: null, cadence: null, speed_m_s: null, elevation_m: null },
    ]);
  });

  it('decodes front and rear gear changes in time order', async () => {
    const gears = { front_gear_num: 2, front_teeth: 50, rear_gear_num: 5, rear_teeth: 21 };
    const bytes = encodeFit([
      ...ride(10),
      gearChange(T0 + 7, 'front', { ...gears, front_gear_num: 1, front_teeth: 34 }),
      gearChange(T0 + 3, 'rear', gears),
    ]);
    expect((await readFit(bytes)).gear_changes).toEqual([
      { time_s: T0 + 3, derailleur: 'rear', front_gear_num: 2, front_teeth: 50, rear_gear_num: 5, rear_teeth: 21 },
      { time_s: T0 + 7, derailleur: 'front', front_gear_num: 1, front_teeth: 34, rear_gear_num: 5, rear_teeth: 21 },
    ]);
  });

  it('returns empty lists for a file without records', async () => {
    expect(await readFit(encodeFit([fileId()]))).toEqual({ records: [], gear_changes: [] });
  });

  it('rejects bytes that are not FIT and a file with a broken CRC', async () => {
    await expect(readFit(new TextEncoder().encode('<gpx></gpx>'))).rejects.toThrow(Error);
    const bytes = encodeFit(ride(3));
    bytes[20] = (bytes[20] ?? 0) ^ 0xff;
    await expect(readFit(bytes)).rejects.toThrow(Error);
  });

  describe('timestamps far outside the activity', () => {
    const gears = { front_gear_num: 2, front_teeth: 50, rear_gear_num: 5, rear_teeth: 21 };
    const FUTURE = T0 + 10 * 365 * 86_400;
    const timed = async (bytes: Uint8Array) => {
      const started = performance.now();
      const fit = await readFit(bytes);
      expect(performance.now() - started).toBeLessThan(500);
      return fit;
    };

    it.each([
      ['the FIT epoch', FIT_EPOCH_S],
      ['the far future', FUTURE],
    ])('drop a single record and gear shift at %s without a session message', async (_, at) => {
      const { records, gear_changes } = await timed(
        encodeFit([...ride(3), record({ time_s: at, power_w: 999 }), gearChange(at, 'rear', gears), gearChange(T0 + 1, 'rear', gears)]),
      );
      expect(records.map((r) => [r.time_s - T0, r.power_w])).toEqual([
        [0, 200],
        [1, 201],
        [2, 202],
      ]);
      expect(gear_changes.map((g) => g.time_s)).toEqual([T0 + 1]);
    });

    it('drop what lies outside the session window', async () => {
      // Two seconds an hour after the session: within MAX_GAP_S, so only the session tells them apart.
      const bytes = encodeFit([
        record({ time_s: FIT_EPOCH_S, power_w: 1 }),
        ...ride(3),
        ...ride(2, 3600),
        gearChange(T0 + 3600, 'rear', gears),
        session(T0, T0 + 2),
      ]);
      const { records, gear_changes } = await timed(bytes);
      expect(records.map((r) => r.time_s - T0)).toEqual([0, 1, 2]);
      expect(gear_changes).toEqual([]);
    });

    it('fall back to neighbours when the session window is broken itself', async () => {
      const { records } = await timed(encodeFit([...ride(3), record({ time_s: FUTURE, power_w: 999 }), session(FIT_EPOCH_S, FUTURE)]));
      expect(records.map((r) => r.time_s - T0)).toEqual([0, 1, 2]);
    });

    it(`reject records that still span more than ${MAX_SPAN_S / 86_400} days, without laying them out`, async () => {
      // One record an hour for eight days: no gap to split at, so nothing is an outlier.
      const hourly = Array.from({ length: 8 * 24 + 1 }, (_, h) => record({ time_s: T0 + h * 3600, power_w: 200 }));
      const started = performance.now();
      await expect(readFit(encodeFit(hourly))).rejects.toThrow(/span 8 days, more than the 7 days/);
      await expect(readFit(encodeFit([...hourly, session(T0, T0 + 8 * 86_400)]))).rejects.toThrow(/span 8 days/);
      expect(performance.now() - started).toBeLessThan(500);
      expect(MAX_GAP_S).toBeGreaterThan(3600);
    });
  });

  it('reads a view into a larger buffer', async () => {
    const bytes = encodeFit(ride(2));
    const padded = new Uint8Array(bytes.length + 8);
    padded.set(bytes, 4);
    expect((await readFit(padded.subarray(4, 4 + bytes.length))).records).toHaveLength(2);
  });
});
