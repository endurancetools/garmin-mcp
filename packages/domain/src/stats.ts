import { addDays, type IsoDate } from 'garmin-mcp-config';
import { round } from './format.js';

export interface Point {
  date: IsoDate;
  value: number | null | undefined;
}

export function mean(values: readonly (number | null | undefined)[]): number | undefined {
  const xs = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined;
}

export function sum(values: readonly (number | null | undefined)[]): number | undefined {
  const xs = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return xs.length ? xs.reduce((a, b) => a + b, 0) : undefined;
}

export function stdev(values: readonly number[]): number | undefined {
  if (values.length < 2) return undefined;
  const m = mean(values) as number;
  return Math.sqrt(values.reduce((a, v) => a + (v - m) ** 2, 0) / (values.length - 1));
}

/** Least-squares slope per day. */
export function slopePerDay(points: readonly { x: number; y: number }[]): number | undefined {
  if (points.length < 3) return undefined;
  const mx = mean(points.map((p) => p.x)) as number;
  const my = mean(points.map((p) => p.y)) as number;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) ** 2;
  }
  return den === 0 ? undefined : num / den;
}

export type Direction = 'rising' | 'falling' | 'stable';

export interface Trend {
  latest?: number;
  latest_date?: IsoDate;
  avg_7d?: number;
  avg_28d?: number;
  /** Change of the 7-day average versus the 28-day average, in the metric's unit. */
  change_7d_vs_28d?: number;
  direction?: Direction;
  /** How many standard deviations the 7-day average is from the 28-day baseline. */
  deviation_from_baseline_sd?: number;
  samples: number;
}

/**
 * Trend of a daily series ending at `asOf`: 7- and 28-day means, direction from the
 * 28-day regression slope (relative threshold), and deviation from baseline.
 * `stableBand` is the relative 28-day change regarded as noise (default 2 %).
 */
export function trend(series: readonly Point[], asOf: IsoDate, stableBand = 0.02, digits = 1): Trend {
  const valid = series
    .filter((p): p is { date: IsoDate; value: number } => typeof p.value === 'number' && Number.isFinite(p.value) && p.date <= asOf)
    .toSorted((a, b) => a.date.localeCompare(b.date));
  const last = valid.at(-1);
  const from7 = addDays(asOf, -6);
  const from28 = addDays(asOf, -27);
  const w7 = valid.filter((p) => p.date >= from7).map((p) => p.value);
  const w28 = valid.filter((p) => p.date >= from28);
  const avg7 = mean(w7);
  const avg28 = mean(w28.map((p) => p.value));
  const base = Date.parse(`${from28}T00:00:00Z`);
  const slope = slopePerDay(w28.map((p) => ({ x: (Date.parse(`${p.date}T00:00:00Z`) - base) / 86_400_000, y: p.value })));
  let direction: Direction | undefined;
  if (slope !== undefined && avg28 !== undefined && avg28 !== 0) {
    const relChange = (slope * 27) / Math.abs(avg28);
    direction = Math.abs(relChange) < stableBand ? 'stable' : relChange > 0 ? 'rising' : 'falling';
  }
  const sd = stdev(w28.map((p) => p.value));
  return {
    latest: round(last?.value, digits),
    latest_date: last?.date,
    avg_7d: round(avg7, digits),
    avg_28d: round(avg28, digits),
    change_7d_vs_28d: avg7 !== undefined && avg28 !== undefined ? round(avg7 - avg28, digits) : undefined,
    direction,
    deviation_from_baseline_sd: sd && avg7 !== undefined && avg28 !== undefined ? round((avg7 - avg28) / sd, 2) : undefined,
    samples: valid.length,
  };
}
