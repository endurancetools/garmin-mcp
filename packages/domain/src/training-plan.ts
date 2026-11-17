import type { CalendarEvent } from './calendar.js';
import { round } from './format.js';

/**
 * A training plan (Garmin Coach adaptive, or phased) as `list_workouts` shows it, read
 * defensively from the plan response (recorded shape: `adaptive-plan` fixture, E8-2). The
 * plan has the tasks of the current week only (`taskList`), so a plan workout further ahead
 * has no description; its workouts have no library `workoutId`, so `get_workout` has no steps.
 */

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const day = (v: unknown): string | undefined => str(v)?.slice(0, 10);
/** `AEROBIC_BASE` → "aerobic base". */
const words = (v: unknown): string | undefined => str(v)?.toLowerCase().replaceAll('_', ' ');

export interface PlanPhase {
  name?: string;
  from?: string;
  to?: string;
}

export interface TrainingPlanBlock {
  name?: string;
  /** `adaptive` (Garmin Coach, adapts to how training goes) or `phased`. */
  kind: 'adaptive' | 'phased';
  sport?: string;
  from?: string;
  to?: string;
  phase?: PlanPhase;
  target_event?: { date?: string; title?: string; race?: true; distance_km?: number };
}

/** Name of the plan, for the rows of its workouts. */
export function planName(raw: unknown): string | undefined {
  return str(obj(raw)?.name);
}

function phases(raw: Obj): Obj[] {
  const list = Array.isArray(raw.adaptivePlanPhases) ? raw.adaptivePlanPhases : Array.isArray(raw.planPhases) ? raw.planPhases : [];
  return list.map(obj).filter((p): p is Obj => p !== undefined);
}

/**
 * The plan block: name, kind, sport, dates, the phase `today` falls in (else the one Garmin
 * marks current) and the target event: the date of the `TARGET_EVENT_DAY` phase, with the
 * title and distance of the goal race (`primary`) from the cached calendar events when there is one.
 */
export function trainingPlanBlock(raw: unknown, adaptive: boolean, today: string, events: readonly CalendarEvent[]): TrainingPlanBlock {
  const p = obj(raw) ?? {};
  const all = phases(p);
  const current =
    all.find((ph) => {
      const from = day(ph.startDate);
      const to = day(ph.endDate);
      return from !== undefined && to !== undefined && from <= today && today <= to;
    }) ?? all.find((ph) => ph.currentPhase === true);
  const targetDate = day(all.find((ph) => ph.trainingPhase === 'TARGET_EVENT_DAY')?.startDate);
  const goal = events.find((e) => e.primary && (targetDate === undefined || e.date === targetDate));
  const category = str(p.trainingPlanCategory);
  return {
    name: planName(p),
    kind: category === 'FBT_ADAPTIVE' || (category === undefined && adaptive) ? 'adaptive' : 'phased',
    sport: words(obj(p.trainingType)?.typeKey),
    from: day(p.startDate),
    to: day(p.endDate),
    phase: current && { name: words(current.trainingPhase), from: day(current.startDate), to: day(current.endDate) },
    target_event: goal
      ? { date: goal.date, title: goal.title, race: goal.race, distance_km: goal.distance_km }
      : targetDate !== undefined
        ? { date: targetDate }
        : undefined,
  };
}

/** One task of the plan's week (`taskList[]`). */
interface PlanTask {
  date?: string;
  uuid?: string;
  rest: boolean;
  line: string;
}

function tasks(raw: unknown): PlanTask[] {
  const list = obj(raw)?.taskList;
  if (!Array.isArray(list)) return [];
  return list.map(obj).flatMap((t) => {
    if (!t) return [];
    const w = obj(t.taskWorkout) ?? {};
    const rest = w.restDay === true;
    const duration = num(w.estimatedDurationInSecs);
    const distance = num(w.estimatedDistanceInMeters);
    const label = str(w.trainingEffectLabel);
    const parts = rest
      ? ['rest day']
      : [
          duration !== undefined && duration > 0 ? `${Math.round(duration / 60)} min` : undefined,
          distance !== undefined && distance > 0 ? `${round(distance / 1000, 1)} km` : undefined,
          label !== undefined && label !== 'INVALID' ? words(label) : undefined,
          t.keyWorkout === true ? 'key workout' : undefined,
        ];
    return [{ date: day(t.calendarDate) ?? day(w.scheduledDate), uuid: str(w.workoutUuid), rest, line: parts.filter((x) => x !== undefined).join(', ') }];
  });
}

/**
 * One line on a plan workout of the calendar (`date`, `workoutUuid`) from the plan's week, e.g.
 * "30 min, 5.5 km, aerobic base": the task with the same workout uuid, else the only workout
 * task (not a rest day) on that date. Undefined outside the week the plan lists.
 */
export function planWorkoutLine(raw: unknown, date: string | null | undefined, uuid: string | null | undefined): string | undefined {
  const week = tasks(raw).filter((t) => !t.rest);
  const byUuid = uuid ? week.find((t) => t.uuid === uuid) : undefined;
  const sameDay = week.filter((t) => t.date === date);
  const task = byUuid ?? (sameDay.length === 1 ? sameDay[0] : undefined);
  return task?.line || undefined;
}
