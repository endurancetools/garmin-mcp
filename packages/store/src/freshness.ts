import { addDays, dateIn, type IsoDate } from 'garmin-mcp-config';
import type { DailyKind } from './store.js';

const MIN = 60_000;

/** Cache TTLs. */
export const TTL = {
  recentDay: 15 * MIN,
  trainingToday: 60 * MIN,
  activityList: 15 * MIN,
  reference: 60 * MIN,
} as const;

/**
 * Is the cached row for `date` still good?
 *
 * - today and yesterday: 15 min (training status and HRV for today: 1 h);
 * - older days: never refreshed automatically, provided the row was fetched after
 *   the day had ended. A day cached while it was still "today" gets one final
 *   refresh; after that historical data is treated as immutable.
 */
export function isDayFresh(
  kind: DailyKind,
  date: IsoDate,
  fetchedAt: number | undefined,
  now: number,
  timeZone: string,
): boolean {
  if (fetchedAt === undefined) return false;
  const today = dateIn(timeZone, new Date(now));
  if (date >= addDays(today, -1)) {
    const ttl = date === today && (kind === 'training_status' || kind === 'hrv') ? TTL.trainingToday : TTL.recentDay;
    return now - fetchedAt < ttl;
  }
  return dateIn(timeZone, new Date(fetchedAt)) > date;
}

export function isFresh(fetchedAt: number | undefined, ttl: number, now: number): boolean {
  return fetchedAt !== undefined && now - fetchedAt < ttl;
}
