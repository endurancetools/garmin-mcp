/**
 * Measurements written by `garmin log` (weight with body fat, blood pressure, water): when they were taken and
 * the checks of their values, before anything is sent to Garmin.
 */
import type { MeasuredAt } from 'garmin-mcp-client';
import { InputError, isIsoDate } from 'garmin-mcp-config';
import { localDateTime } from './manual-activity.js';

const WHEN = /^(\d{4}-\d{2}-\d{2})(?:[T ]([01]\d|2[0-3]):([0-5]\d))?$/;

/** The instant at which the wall clock in `timeZone` shows `local` ("2026-11-17T07:30:00"). */
export function localToUtc(timeZone: string, local: string): number {
  const asUtc = Date.parse(`${local}Z`);
  let t = asUtc;
  // Two rounds settle the zone offset, also when `local` and the first guess straddle a DST change.
  for (let i = 0; i < 2; i++) t = asUtc - (Date.parse(`${localDateTime(timeZone, t)}Z`) - t);
  return t;
}

/**
 * When a measurement was taken, from `--date`: now when left out; a bare date is now on today
 * and 12:00 on an earlier day; "YYYY-MM-DD HH:MM" (or with a T) is that local time in `timeZone`.
 * Never in the future.
 */
export function measuredAt(input: string | undefined, timeZone: string, now: number): MeasuredAt {
  const nowLocal = localDateTime(timeZone, now);
  if (input === undefined) return { local: nowLocal, utc: new Date(now) };
  const m = WHEN.exec(input.trim());
  const date = m?.[1];
  if (!m || !date || !isIsoDate(date)) throw new InputError(`date must be YYYY-MM-DD or "YYYY-MM-DD HH:MM", got "${input}"`);
  if (m[2] === undefined && date === nowLocal.slice(0, 10)) return { local: nowLocal, utc: new Date(now) };
  const local = `${date}T${m[2] ?? '12'}:${m[3] ?? '00'}:00`;
  if (local > nowLocal) throw new InputError(`${input} is in the future (now ${nowLocal.slice(0, 16).replace('T', ' ')} in ${timeZone})`);
  return { local, utc: new Date(localToUtc(timeZone, local)) };
}

function inRange(value: number, min: number, max: number, what: string, opts: { integer?: boolean } = {}): number {
  if (!Number.isFinite(value) || value < min || value > max || (opts.integer && !Number.isInteger(value))) {
    throw new InputError(`${what} must be ${opts.integer ? 'a whole number ' : ''}from ${min} to ${max}, got ${Number.isNaN(value) ? 'not a number' : value}`);
  }
  return value;
}

/** Body weight in kg, 20 to 400. */
export const checkWeightKg = (kg: number): number => inRange(kg, 20, 400, 'weight (kg)');

/** Body fat in percent of body weight, 1 to 75. */
export const checkFatPct = (pct: number): number => inRange(pct, 1, 75, 'body fat (%)');

/** Water in ml added to the day, 1 to 5000 per entry. */
export const checkWaterMl = (ml: number): number => inRange(ml, 1, 5000, 'water (ml)', { integer: true });

/** Pulse in bpm, 20 to 250. */
export const checkPulse = (bpm: number): number => inRange(bpm, 20, 250, 'pulse (bpm)', { integer: true });

/** "120/80" as systolic and diastolic mmHg, systolic higher. */
export function parseBloodPressure(reading: string): { systolic: number; diastolic: number } {
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(reading);
  if (!m) throw new InputError(`blood pressure must be systolic/diastolic, e.g. 120/80, got "${reading}"`);
  const systolic = inRange(Number(m[1]), 60, 300, 'systolic (mmHg)', { integer: true });
  const diastolic = inRange(Number(m[2]), 30, 200, 'diastolic (mmHg)', { integer: true });
  if (systolic <= diastolic) throw new InputError(`systolic must be higher than diastolic, got ${reading}`, 'Write the higher number first, e.g. 120/80.');
  return { systolic, diastolic };
}
