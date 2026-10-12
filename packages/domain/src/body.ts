import type { IsoDate } from 'garmin-mcp-config';
import type { BodyCompositionRow } from 'garmin-mcp-store';
import { round } from './format.js';
import { trend, type Trend } from './stats.js';

export interface BodyCompositionSummary {
  measurements: { time_utc: string; date: string; sample_pk?: number; weight_kg?: number; body_fat_pct?: number; muscle_mass_kg?: number; bmi?: number }[];
  latest?: { date: string; weight_kg?: number; body_fat_pct?: number };
  change_kg?: number;
  weight_trend?: Trend;
  body_fat_trend?: Trend;
}

/** Measurements in kg plus weight and body-fat trends (`get_body_composition`). */
export function bodyComposition(rows: readonly BodyCompositionRow[], to: IsoDate, history: readonly BodyCompositionRow[] = rows): BodyCompositionSummary {
  const sorted = rows.toSorted((a, b) => a.sample_time_utc.localeCompare(b.sample_time_utc));
  // One value per day (the last measurement) for trends.
  const perDay = (xs: readonly BodyCompositionRow[], f: (r: BodyCompositionRow) => number | null) => {
    const m = new Map<string, number>();
    for (const r of xs.toSorted((a, b) => a.sample_time_utc.localeCompare(b.sample_time_utc))) {
      const v = f(r);
      if (v !== null) m.set(r.date, v);
    }
    return [...m.entries()].map(([date, value]) => ({ date, value }));
  };
  const first = sorted.find((r) => r.weight_kg !== null);
  const last = sorted.findLast((r) => r.weight_kg !== null);
  return {
    measurements: sorted.map((r) => ({
      time_utc: r.sample_time_utc,
      date: r.date,
      sample_pk: r.sample_pk ?? undefined,
      weight_kg: round(r.weight_kg, 1),
      body_fat_pct: round(r.body_fat_pct, 1),
      muscle_mass_kg: round(r.muscle_mass_kg, 1),
      bmi: round(r.bmi, 1),
    })),
    latest: last && { date: last.date, weight_kg: round(last.weight_kg, 1), body_fat_pct: round(last.body_fat_pct, 1) },
    change_kg: first && last && first !== last ? round((last.weight_kg ?? 0) - (first.weight_kg ?? 0), 1) : undefined,
    weight_trend: trend(perDay(history, (r) => r.weight_kg), to, 0.005),
    body_fat_trend: trend(perDay(history, (r) => r.body_fat_pct), to, 0.02),
  };
}
