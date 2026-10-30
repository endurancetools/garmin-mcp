/**
 * Turn Garmin workout JSON (GET workout-service/workout/{id}) into a compact, readable
 * structure for the LLM. Tolerant: unknown fields are ignored and malformed ones dropped.
 */
import { z } from 'zod';

const opt = <T extends z.ZodType>(schema: T) => schema.nullish().catch(undefined);
const num = opt(z.number());
const str = opt(z.string());

interface LooseStep {
  type?: string | null;
  stepOrder?: number | null;
  stepType?: { stepTypeKey?: string | null } | null;
  endCondition?: { conditionTypeKey?: string | null } | null;
  endConditionValue?: number | null;
  targetType?: { workoutTargetTypeKey?: string | null } | null;
  zoneNumber?: number | null;
  targetValueOne?: number | null;
  targetValueTwo?: number | null;
  secondaryTargetType?: { workoutTargetTypeKey?: string | null } | null;
  secondaryZoneNumber?: number | null;
  secondaryTargetValueOne?: number | null;
  secondaryTargetValueTwo?: number | null;
  description?: string | null;
  category?: string | null;
  exerciseName?: string | null;
  weightValue?: number | null;
  weightUnit?: { unitKey?: string | null; factor?: number | null } | null;
  numberOfIterations?: number | null;
  workoutSteps?: LooseStep[] | null;
}

const targetRef = opt(z.looseObject({ workoutTargetTypeKey: str }));

const looseStepSchema: z.ZodType<LooseStep> = z.looseObject({
  type: str,
  stepOrder: num,
  stepType: opt(z.looseObject({ stepTypeKey: str })),
  endCondition: opt(z.looseObject({ conditionTypeKey: str })),
  endConditionValue: num,
  targetType: targetRef,
  zoneNumber: num,
  targetValueOne: num,
  targetValueTwo: num,
  secondaryTargetType: targetRef,
  secondaryZoneNumber: num,
  secondaryTargetValueOne: num,
  secondaryTargetValueTwo: num,
  description: str,
  category: str,
  exerciseName: str,
  weightValue: num,
  weightUnit: opt(z.looseObject({ unitKey: str, factor: num })),
  numberOfIterations: num,
  get workoutSteps() {
    return opt(z.array(looseStepSchema));
  },
});

const looseWorkoutSchema = z.looseObject({
  workoutId: opt(z.union([z.number(), z.string()])),
  workoutName: str,
  description: str,
  sportType: opt(z.looseObject({ sportTypeKey: str })),
  estimatedDurationInSecs: num,
  estimatedDuration: num,
  estimatedDistanceInMeters: num,
  estimatedDistance: num,
  workoutSegments: opt(
    z.array(
      z.looseObject({
        segmentOrder: num,
        sportType: opt(z.looseObject({ sportTypeKey: str })),
        workoutSteps: opt(z.array(looseStepSchema)),
      }),
    ),
  ),
});

export interface ReadableWorkout {
  id?: number | string;
  name?: string;
  sport?: string;
  description?: string;
  estimated_duration_s?: number;
  estimated_distance_m?: number;
  step_count: number;
  /** One line per step, e.g. "1. Warmup 10:00", "2. Repeat 6x:", "  2.1 Interval 400 m @ pace 3:50-4:05 /km". */
  steps: string[];
}

export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${Number((meters / 1000).toFixed(2))} km`;
}

/** Metres per second → "m:ss" per `per` metres. */
function formatPace(mps: number, per = 1000): string {
  return mps > 0 ? formatDuration(per / mps) : '?';
}

const humanize = (key: string) => {
  const words = key.replace(/[._]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const range = (a: number | null | undefined, b: number | null | undefined, fmt: (v: number) => string) => {
  if (a == null && b == null) return undefined;
  if (a == null || b == null) return fmt((a ?? b) as number);
  return `${fmt(Math.min(a, b))}-${fmt(Math.max(a, b))}`;
};

function describeTarget(
  key: string | null | undefined,
  zone: number | null | undefined,
  one: number | null | undefined,
  two: number | null | undefined,
  sport: string | undefined,
): string | undefined {
  if (!key || key === 'no.target') return undefined;
  const swim = sport?.includes('swim') ?? false;
  const r = (fmt: (v: number) => string) => range(one, two, fmt);
  switch (key) {
    case 'heart.rate.zone':
      return zone != null ? `HR Z${zone}` : `HR ${r((v) => String(Math.round(v))) ?? '?'} bpm`;
    case 'power.zone':
      return zone != null ? `power Z${zone}` : `power ${r((v) => String(Math.round(v))) ?? '?'} W`;
    case 'power.between':
      return `power ${r((v) => String(Math.round(v))) ?? '?'} W`;
    case 'cadence':
      return `cadence ${r((v) => String(Math.round(v))) ?? '?'} rpm`;
    case 'pace.zone': {
      if (zone != null) return `pace zone ${zone}`;
      // Faster speed = lower pace number, so swap to print fast-slow.
      const per = swim ? 100 : 1000;
      const lo = one ?? two;
      const hi = two ?? one;
      if (lo == null || hi == null) return 'pace';
      const fast = Math.max(lo, hi);
      const slow = Math.min(lo, hi);
      const text = fast === slow ? formatPace(fast, per) : `${formatPace(fast, per)}-${formatPace(slow, per)}`;
      return `pace ${text} /${swim ? '100 m' : 'km'}`;
    }
    case 'speed.zone':
      return zone != null ? `speed zone ${zone}` : `speed ${r((v) => (v * 3.6).toFixed(1)) ?? '?'} km/h`;
    default: {
      const values = zone != null ? `zone ${zone}` : r((v) => String(Number(v.toFixed(2))));
      return values ? `${humanize(key).toLowerCase()} ${values}` : humanize(key).toLowerCase();
    }
  }
}

function describeEnd(step: LooseStep): string | undefined {
  const key = step.endCondition?.conditionTypeKey;
  const v = step.endConditionValue;
  switch (key) {
    case undefined:
    case null:
      return undefined;
    case 'lap.button':
      return 'until lap button';
    case 'time':
      return v != null ? formatDuration(v) : undefined;
    case 'distance':
      return v != null ? formatDistance(v) : undefined;
    case 'reps':
      return v != null ? `${Math.round(v)} reps` : undefined;
    case 'calories':
      return v != null ? `${Math.round(v)} kcal` : undefined;
    case 'heart.rate':
      return v != null ? `until HR ${Math.round(v)} bpm` : undefined;
    case 'power':
      return v != null ? `until ${Math.round(v)} W` : undefined;
    case 'iterations':
      return undefined;
    default:
      return v != null ? `${humanize(key).toLowerCase()} ${v}` : humanize(key).toLowerCase();
  }
}

function describeExercise(step: LooseStep): string | undefined {
  const name = step.exerciseName || step.category;
  if (!name) return undefined;
  let text = humanize(name);
  if (step.weightValue != null) {
    const unit = step.weightUnit?.unitKey;
    const factor = step.weightUnit?.factor;
    if (unit === 'kilogram' || unit == null) {
      const kg = factor ? step.weightValue / factor : step.weightValue;
      text += ` ${Number(kg.toFixed(2))} kg`;
    } else {
      text += ` ${step.weightValue} ${unit}`;
    }
  }
  return text;
}

const isRepeat = (step: LooseStep) => step.type === 'RepeatGroupDTO' || step.stepType?.stepTypeKey === 'repeat';

function describeStep(step: LooseStep, label: string, indent: string, sport: string | undefined, out: string[]): void {
  if (isRepeat(step)) {
    const n = step.numberOfIterations ?? step.endConditionValue;
    out.push(`${indent}${label}. Repeat ${n != null ? `${Math.round(n)}x` : ''}:`.replace(' :', ':'));
    (step.workoutSteps ?? []).forEach((child, i) => describeStep(child, `${label}.${i + 1}`, `${indent}  `, sport, out));
    return;
  }
  const parts = [humanize(step.stepType?.stepTypeKey ?? 'step')];
  const exercise = describeExercise(step);
  if (exercise) parts.push(exercise);
  const end = describeEnd(step);
  if (end) parts.push(end);
  const targets = [
    describeTarget(step.targetType?.workoutTargetTypeKey, step.zoneNumber, step.targetValueOne, step.targetValueTwo, sport),
    describeTarget(
      step.secondaryTargetType?.workoutTargetTypeKey,
      step.secondaryZoneNumber,
      step.secondaryTargetValueOne,
      step.secondaryTargetValueTwo,
      sport,
    ),
  ].filter(Boolean);
  let line = `${indent}${label}. ${parts.join(' ')}`;
  if (targets.length) line += ` @ ${targets.join(', ')}`;
  if (step.description) line += ` - ${step.description}`;
  out.push(line);
}

export interface DurationEstimate {
  /** Whole seconds of the steps that can be timed, repeats multiplied by their count. */
  seconds: number;
  /**
   * Steps left out because they have neither a time nor a distance with a pace range
   * (lap button, reps, calories, distance at HR, pace zone or no target). Labelled like
   * the lines of `describeWorkout`: "3" for the third top-level step, "2.1" inside a repeat.
   */
  skipped: string[];
}

/** Seconds of one step, or undefined when it cannot be timed. */
function stepSeconds(step: LooseStep): number | undefined {
  const value = step.endConditionValue;
  if (value == null || value <= 0) return undefined;
  const end = step.endCondition?.conditionTypeKey;
  if (end === 'time') return value;
  const [one, two] = [step.targetValueOne, step.targetValueTwo];
  if (end !== 'distance' || step.targetType?.workoutTargetTypeKey !== 'pace.zone' || one == null || two == null || one <= 0 || two <= 0) return undefined;
  // Middle of the range in time per distance, not in speed: 4:00 and 6:00 /km give 5:00 /km.
  return (value * (1 / one + 1 / two)) / 2;
}

/**
 * Estimated duration of Garmin workout JSON: time steps count as they are, distance steps
 * with a pace range are run at its middle, repeats multiply their steps. Anything else
 * cannot be timed and is listed in `skipped`.
 */
export function estimateWorkoutDuration(garminJson: unknown): DurationEstimate {
  const parsed = looseWorkoutSchema.safeParse(garminJson);
  if (!parsed.success) throw new TypeError('Not a Garmin workout object');
  const skipped: string[] = [];
  const walk = (steps: LooseStep[], label: (i: number) => string): number =>
    steps.reduce((sum, step, i) => {
      if (isRepeat(step)) {
        const count = step.numberOfIterations ?? step.endConditionValue ?? 1;
        return sum + count * walk(step.workoutSteps ?? [], (j) => `${label(i)}.${j + 1}`);
      }
      const seconds = stepSeconds(step);
      if (seconds === undefined) skipped.push(label(i));
      return sum + (seconds ?? 0);
    }, 0);
  // Top-level labels run on across segments, as in `describeWorkout`.
  const steps = (parsed.data.workoutSegments ?? []).flatMap((seg) => seg.workoutSteps ?? []);
  return { seconds: Math.round(walk(steps, (i) => String(i + 1))), skipped };
}

/**
 * The lines of {@link describeWorkout} by the step index a recorded lap carries
 * (`wktStepIndex`): the FIT numbering, depth first from 0, where a repeat comes after the
 * steps it repeats. For "1. 5 km, 2. lap button, 3. Repeat 12x: 3.1 100 m, 3.2 recovery,
 * 4. 2 km" the laps say 0, 1, 2, 3, ... and 5; 4 is the repeat. Checked against recordings
 * of single-sport workouts; across multisport segments the numbering is assumed to run on.
 */
export function workoutStepsByIndex(garminJson: unknown): Map<number, string> {
  const parsed = looseWorkoutSchema.safeParse(garminJson);
  if (!parsed.success) throw new TypeError('Not a Garmin workout object');
  const w = parsed.data;
  const segments = w.workoutSegments ?? [];
  const sport = w.sportType?.sportTypeKey ?? segments[0]?.sportType?.sportTypeKey ?? undefined;
  const out = new Map<number, string>();
  const walk = (step: LooseStep, label: string, segSport: string | undefined) => {
    if (isRepeat(step)) (step.workoutSteps ?? []).forEach((child, i) => walk(child, `${label}.${i + 1}`, segSport));
    const lines: string[] = [];
    describeStep({ ...step, workoutSteps: [] }, label, '', segSport, lines);
    out.set(out.size, (lines[0] ?? label).replace(/:$/, ''));
  };
  let count = 0;
  for (const seg of segments) {
    for (const step of seg.workoutSteps ?? []) {
      count += 1;
      walk(step, String(count), seg.sportType?.sportTypeKey ?? sport);
    }
  }
  return out;
}

export function describeWorkout(garminJson: unknown): ReadableWorkout {
  const parsed = looseWorkoutSchema.safeParse(garminJson);
  if (!parsed.success) throw new TypeError('Not a Garmin workout object');
  const w = parsed.data;
  const segments = w.workoutSegments ?? [];
  const sport = w.sportType?.sportTypeKey ?? segments[0]?.sportType?.sportTypeKey ?? undefined;
  const lines: string[] = [];
  let count = 0;
  segments.forEach((seg, si) => {
    const segSport = seg.sportType?.sportTypeKey ?? sport;
    const indent = segments.length > 1 ? '  ' : '';
    if (segments.length > 1) lines.push(`Segment ${si + 1}${segSport ? ` (${segSport})` : ''}:`);
    (seg.workoutSteps ?? []).forEach((step) => {
      count += 1;
      describeStep(step, String(count), indent, segSport, lines);
    });
  });

  const out: ReadableWorkout = { step_count: count, steps: lines };
  if (w.workoutId != null) out.id = w.workoutId;
  if (w.workoutName) out.name = w.workoutName;
  if (sport) out.sport = sport;
  if (w.description) out.description = w.description;
  const duration = w.estimatedDurationInSecs ?? w.estimatedDuration ?? estimateWorkoutDuration(w).seconds;
  if (duration) out.estimated_duration_s = Math.round(duration);
  const distance = w.estimatedDistanceInMeters ?? w.estimatedDistance;
  if (distance) out.estimated_distance_m = distance;
  return out;
}
