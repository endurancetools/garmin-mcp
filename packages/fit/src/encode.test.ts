import FitParser from 'fit-file-parser';
import { describe, expect, it } from 'vitest';
import { encodeFit, FIT_EPOCH_S, weightScaleFit } from './encode.js';
import { readFit } from './read.js';
import { fileId, record } from './test-utils/encode.js';

const parse = async (bytes: Uint8Array) =>
  (await new FitParser({ force: false, mode: 'list' }).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)) as unknown as Record<string, unknown>;

describe('encodeFit', () => {
  it('writes a file readFit and fit-file-parser accept, CRC included', async () => {
    const t = 1_763_370_000;
    const bytes = encodeFit([fileId(), record({ time_s: t, power_w: 250, heart_rate_bpm: 150 })]);
    expect((await readFit(bytes)).records).toEqual([{ time_s: t, power_w: 250, heart_rate_bpm: 150, cadence: null, speed_m_s: null, elevation_m: null }]);

    const broken = bytes.slice();
    broken[20] = (broken[20] ?? 0) ^ 0xff;
    await expect(readFit(broken)).rejects.toThrow(/CRC/i);
  });

  it('refuses a value that does not fit its base type instead of wrapping it', () => {
    expect(() => encodeFit([{ global: 30, fields: [[0, 'uint16', 70_000]] }])).toThrow('FIT field 0 of message 30: 70000 does not fit uint16');
    expect(() => encodeFit([{ global: 30, fields: [[1, 'uint16', -1]] }])).toThrow('does not fit uint16');
    expect(() => encodeFit([{ global: 30, fields: [[1, 'uint8', 1.5]] }])).toThrow('does not fit uint8');
  });
});

describe('weightScaleFit', () => {
  const at = new Date('2026-11-17T06:30:00Z');
  const createdAt = new Date('2026-11-17T08:00:05Z');

  it('writes a weight file with one weight_scale measurement', async () => {
    const parsed = await parse(weightScaleFit({ at, createdAt, weightKg: 72.4, fatPct: 18.35 }));
    expect(parsed.file_ids).toEqual([expect.objectContaining({ type: 'weight', time_created: createdAt })]);
    expect(parsed.weight_scale).toEqual(expect.objectContaining({ timestamp: at, weight: 72.4, percent_fat: 18.35 }));
    expect(parsed.device_infos).toEqual([expect.objectContaining({ timestamp: at })]);
  });

  it('leaves body fat out when not given', async () => {
    const parsed = await parse(weightScaleFit({ at, createdAt, weightKg: 80 }));
    const scale = parsed.weight_scale as Record<string, unknown>;
    expect(scale.weight).toBe(80);
    expect(scale.percent_fat).toBeUndefined();
  });

  it('counts the timestamp from the FIT epoch', () => {
    const bytes = weightScaleFit({ at, createdAt, weightKg: 72.4 });
    const fit = at.getTime() / 1000 - FIT_EPOCH_S;
    const le = [0, 1, 2, 3].map((i) => Math.floor(fit / 2 ** (8 * i)) % 256);
    // The weight_scale data message: local type, timestamp, weight 7240 (0x1c48).
    expect(Buffer.from(bytes).includes(Buffer.from([...le, 0x48, 0x1c]))).toBe(true);
  });
});
