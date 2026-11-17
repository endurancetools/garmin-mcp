// Messages of synthetic activity files for tests, written with the package's FIT encoder.

import { FIT_EPOCH_S, type FitMessage } from '../encode.js';

export const fileId = (): FitMessage => ({ global: 0, fields: [[0, 'enum', 4]] });

export interface RecordInput {
  time_s: number;
  power_w?: number | null;
  heart_rate_bpm?: number | null;
  cadence?: number | null;
  speed_m_s?: number | null;
  elevation_m?: number | null;
  /** `enhanced_speed`/`enhanced_altitude` (32 bit) instead of `speed`/`altitude`. */
  enhanced?: boolean;
}

export function record(r: RecordInput): FitMessage {
  const speed = r.speed_m_s == null ? null : Math.round(r.speed_m_s * 1000);
  const altitude = r.elevation_m == null ? null : Math.round((r.elevation_m + 500) * 5);
  return {
    global: 20,
    fields: [
      [253, 'uint32', r.time_s - FIT_EPOCH_S],
      [7, 'uint16', r.power_w],
      [3, 'uint8', r.heart_rate_bpm],
      [4, 'uint8', r.cadence],
      r.enhanced ? [73, 'uint32', speed] : [6, 'uint16', speed],
      r.enhanced ? [78, 'uint32', altitude] : [2, 'uint16', altitude],
    ],
  };
}

/** Timer start (event_type 0) or stop_all (4). */
export const timer = (time_s: number, running: boolean): FitMessage => ({
  global: 21,
  fields: [
    [253, 'uint32', time_s - FIT_EPOCH_S],
    [0, 'enum', 0],
    [1, 'enum', running ? 0 : 4],
  ],
});

/**
 * Session (global 18): its end as the timestamp, start_time and total_elapsed_time (ms). An
 * elapsed time beyond 32 bits wraps around, as a broken device would write it.
 */
export const session = (start_s: number, end_s: number): FitMessage => ({
  global: 18,
  fields: [
    [253, 'uint32', end_s - FIT_EPOCH_S],
    [2, 'uint32', start_s - FIT_EPOCH_S],
    [7, 'uint32', ((end_s - start_s) * 1000) % 2 ** 32],
  ],
});

/** Event 42/43 (front/rear gear change), event_type marker, `data` = gear_change_data. */
export function gearChange(
  time_s: number,
  derailleur: 'front' | 'rear',
  g: { front_gear_num: number; front_teeth: number; rear_gear_num: number; rear_teeth: number },
): FitMessage {
  const data = g.rear_gear_num + g.rear_teeth * 2 ** 8 + g.front_gear_num * 2 ** 16 + g.front_teeth * 2 ** 24;
  return {
    global: 21,
    fields: [
      [253, 'uint32', time_s - FIT_EPOCH_S],
      [0, 'enum', derailleur === 'front' ? 42 : 43],
      [1, 'enum', 3],
      [3, 'uint32', data],
    ],
  };
}
