import { round } from './format.js';

/**
 * Badges and challenges of the account (`garmin://challenges`): how many badges are earned and
 * the {@link RECENT_BADGES} most recent ones, and the badge challenges in progress with how far
 * along they are. Values and targets stay in Garmin's unit (`unit_id`, Garmin's `badgeUnitId`):
 * the recordings do not say which unit an id stands for.
 */

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
/** `2026-10-01T00:00:00.0` → `2026-10-01`. */
const day = (v: unknown): string | undefined => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : undefined);

/** How many of the latest earned badges `garmin://challenges` lists. */
export const RECENT_BADGES = 10;

export interface EarnedBadge {
  name?: string;
  earned_on?: string;
  points?: number;
  /** Only for a badge earned more than once. */
  times_earned?: number;
}

export interface BadgeChallenge {
  name?: string;
  start?: string;
  end?: string;
  progress_pct?: number;
  value?: number;
  target?: number;
  unit_id?: number;
}

export interface BadgeSummary {
  /** Badges earned, each counted once. */
  count: number;
  /** The latest first. */
  recent: EarnedBadge[];
}

/** Garmin's earned badges (`/badge-service/badge/earned`); anything but a list is no badges. */
export function badgeSummary(raw: unknown, recent = RECENT_BADGES): BadgeSummary {
  const earned = (Array.isArray(raw) ? raw : []).flatMap((b) => {
    const o = obj(b);
    const at = typeof o?.badgeEarnedDate === 'string' ? o.badgeEarnedDate : undefined;
    return o && at ? [{ o, at }] : [];
  });
  earned.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return {
    count: earned.length,
    recent: earned.slice(0, recent).map(({ o }) => {
      const times = num(o.badgeEarnedNumber);
      return { name: str(o.badgeName), earned_on: day(o.badgeEarnedDate), points: num(o.badgePoints), times_earned: times !== undefined && times > 1 ? times : undefined };
    }),
  };
}

/** Garmin's badge challenges not completed yet (`/badgechallenge-service/badgeChallenge/non-completed`), in Garmin's order. */
export function challengeList(raw: unknown): BadgeChallenge[] {
  return (Array.isArray(raw) ? raw : []).flatMap((c) => {
    const o = obj(c);
    if (!o) return [];
    const value = num(o.badgeProgressValue);
    const target = num(o.badgeTargetValue);
    return [
      {
        name: str(o.badgeChallengeName),
        start: day(o.startDate),
        end: day(o.endDate),
        progress_pct: value !== undefined && target ? round(Math.min((value / target) * 100, 100), 0) : undefined,
        value: round(value, 1),
        target: round(target, 1),
        unit_id: num(o.badgeUnitId),
      },
    ];
  });
}
