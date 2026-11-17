/**
 * A manual activity that `update_activity` adds when it is called without `id`: the checks of
 * its fields and the activity list row it leaves in the cache, so it shows up in
 * `get_activities` without a sync.
 */
import type { Activity, ActivitySummary } from 'garmin-mcp-client';
import { InputError, isIsoDate } from 'garmin-mcp-config';

/** `update_activity` fields that only describe a new activity (called without `id`). */
export const CREATE_ONLY_FIELDS = ['start', 'duration_min', 'distance_km'] as const;
/** `update_activity` fields that only change an existing activity (called with `id`). */
export const EDIT_ONLY_FIELDS = ['event_type', 'add_gear', 'remove_gear', 'exercise_sets', 'keep_timing'] as const;

export interface ManualActivityInput {
  type?: string;
  /** Local start, "2026-11-16T18:30" (seconds optional). */
  start?: string;
  duration_min?: number;
  distance_km?: number;
}

export interface ManualActivityFields {
  type: string;
  /** Local start with seconds, "2026-11-16T18:30:00". */
  startLocal: string;
  durationS: number;
  distanceM?: number;
}

const START = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

/** Fields given (not undefined) out of `names`. */
const given = (patch: object, names: readonly string[]) => names.filter((k) => (patch as Record<string, unknown>)[k] !== undefined);

/**
 * Refuses fields of the other mode: `start`, `duration_min` and `distance_km` with an `id`,
 * edit-only fields (event type, gear, strength sets) without one.
 */
export function checkEditMode(id: number | undefined, patch: object): void {
  if (id !== undefined) {
    const extra = given(patch, CREATE_ONLY_FIELDS);
    if (extra.length > 0) {
      throw new InputError(
        `${extra.join(', ')} only go with a new activity, which is added without id`,
        `To edit activity ${id} leave out ${extra.join(', ')}; to add a new activity leave out id.`,
      );
    }
    return;
  }
  const extra = given(patch, EDIT_ONLY_FIELDS);
  if (extra.length > 0) {
    throw new InputError(
      `${extra.join(', ')} only go with an existing activity: pass its id`,
      'Add the activity first without them, then edit it with the id from the answer.',
    );
  }
}

/** Local "YYYY-MM-DDTHH:MM:SS" of `instant` in `timeZone`. */
export function localDateTime(timeZone: string, instant: number): string {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(fmt.formatToParts(new Date(instant)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

/**
 * The checked fields of a new activity: `type`, `start` and `duration_min` are required, the
 * start is a past local time in `timeZone`, duration and distance are positive.
 */
export function checkManualActivity(input: ManualActivityInput, timeZone: string, now: number): ManualActivityFields {
  const missing = (['type', 'start', 'duration_min'] as const).filter((k) => input[k] === undefined);
  if (missing.length > 0) {
    throw new InputError(
      `A new activity needs ${missing.join(', ')}`,
      'To edit an activity pass its id from get_activities; to add one pass type, start (local time, YYYY-MM-DDTHH:MM) and duration_min.',
    );
  }
  const { type, start, duration_min: minutes, distance_km: km } = input as Required<Pick<ManualActivityInput, 'type' | 'start' | 'duration_min'>> & ManualActivityInput;
  const m = START.exec(start);
  if (!m || !isIsoDate(m[1] as string)) throw new InputError(`start must be a local time YYYY-MM-DDTHH:MM, got "${start}"`);
  const startLocal = `${m[1]}T${m[2]}:${m[3]}:${m[4] ?? '00'}`;
  const nowLocal = localDateTime(timeZone, now);
  if (startLocal > nowLocal) {
    throw new InputError(`start ${start} is in the future (now ${nowLocal.slice(0, 16)} in ${timeZone})`, 'Only activities that already happened can be added; for a plan use create_workout and schedule_workouts.');
  }
  if (!(minutes > 0) || !Number.isFinite(minutes)) throw new InputError(`duration_min must be more than 0, got ${minutes}`);
  if (km !== undefined && (!(km > 0) || !Number.isFinite(km))) throw new InputError(`distance_km must be more than 0, got ${km}`, 'Leave distance_km out for an activity without distance.');
  return { type, startLocal, durationS: Math.round(minutes * 60), ...(km !== undefined && { distanceM: Math.round(km * 1000) }) };
}

/** Default name of a new activity: its type in words, "trail_running" → "Trail Running". */
export function activityTypeName(typeKey: string): string {
  return typeKey
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * An activity list row built from the single-activity answer, so a new activity is in the
 * cache before the next sync; the sync replaces it with Garmin's own list row.
 */
export function activityListRow(a: Activity): ActivitySummary {
  const sum = a.summaryDTO ?? {};
  return {
    activityId: a.activityId,
    activityName: a.activityName,
    description: a.description,
    startTimeLocal: sum.startTimeLocal,
    startTimeGMT: sum.startTimeGMT,
    activityType: a.activityTypeDTO,
    eventType: a.eventTypeDTO,
    distance: sum.distance,
    duration: sum.duration,
    movingDuration: sum.movingDuration,
    elapsedDuration: sum.elapsedDuration,
    averageHR: sum.averageHR,
    maxHR: sum.maxHR,
    calories: sum.calories,
    // The list calls the access control rule `privacy`.
    ...(a.accessControlRuleDTO !== undefined && { privacy: a.accessControlRuleDTO }),
  };
}
