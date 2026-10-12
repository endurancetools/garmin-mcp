import type { DailyRows } from 'garmin-mcp-store';
import { round } from './format.js';
import { mean } from './stats.js';

export interface EnergyDay {
  date: string;
  total_kcal?: number;
  resting_kcal?: number;
  active_kcal?: number;
}

/** Burned vs resting energy from daily summaries; no nutrition in v1. */
export function energyBalance(rows: readonly DailyRows['daily_summary'][]) {
  const days: EnergyDay[] = rows.map((r) => {
    const raw = (r.raw ?? {}) as { bmrKilocalories?: number };
    return {
      date: r.date,
      total_kcal: round(r.total_calories, 0),
      resting_kcal: round(raw.bmrKilocalories, 0),
      active_kcal: round(r.active_calories, 0),
    };
  });
  return {
    days,
    avg_total_kcal: round(mean(days.map((d) => d.total_kcal)), 0),
    avg_resting_kcal: round(mean(days.map((d) => d.resting_kcal)), 0),
    avg_active_kcal: round(mean(days.map((d) => d.active_kcal)), 0),
  };
}
