/**
 * Strength sets that `update_activity` writes: the input schema, the sets the activity had before
 * (in the same shape, so they can be sent back unchanged) and Garmin's `exerciseSets` body.
 */
import { InputError } from 'garmin-mcp-config';
import { z } from 'zod';
import type { exerciseSchema } from './workouts/definition.js';

/**
 * The exercise as `create_workout` takes it (category and name keys), without its descriptions,
 * and the set without bounds: the tool list budget has no room for them, so `checkExerciseSets`
 * checks the values and names the field.
 */
const exerciseKeys = z.object({ category: z.string(), name: z.string().optional() }) satisfies z.ZodType<z.infer<typeof exerciseSchema>>;

export const exerciseSetSchema = z
  .object({
    exercise: exerciseKeys.optional(),
    reps: z.number().int().min(0).max(999).optional(),
    weight_kg: z.number().optional(),
    duration_s: z.number().optional(),
    rest_s: z.number().optional(),
  })
  .meta({ id: 'ExerciseSet' });

export type ExerciseSetInput = z.infer<typeof exerciseSetSchema>;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

/** "barbell back-squat" → BARBELL_BACK_SQUAT, as `create_workout` writes exercise keys. */
const exerciseKey = (value: string) => value.trim().toUpperCase().replaceAll(/[\s-]+/g, '_');

/** Garmin's `exerciseSets` items of a stored or fetched response; `[]` for none (or a 404). */
export function rawExerciseSets(raw: unknown): Obj[] {
  const list = obj(raw)?.exerciseSets;
  return Array.isArray(list) ? list.map(obj).filter((s): s is Obj => s !== undefined) : [];
}

const isRest = (set: Obj) => str(set.setType) === 'REST';

/** The exercise Garmin rates most likely for a set. */
function likeliest(set: Obj): { category: string; name?: string } | undefined {
  const best = (Array.isArray(set.exercises) ? set.exercises : [])
    .map(obj)
    .filter((e): e is Obj => e !== undefined && str(e.category) !== undefined)
    .toSorted((a, b) => (num(b.probability) ?? 0) - (num(a.probability) ?? 0))[0];
  if (!best) return undefined;
  const name = str(best.name);
  return { category: str(best.category) as string, ...(name && { name }) };
}

/**
 * Active sets of a Garmin `exerciseSets` response as `update_activity` takes them: a rest set
 * becomes `rest_s` of the set before it, a weight of 0 or less (Garmin's "none") is left out.
 */
export function exerciseSetsInput(raw: unknown): ExerciseSetInput[] {
  const out: ExerciseSetInput[] = [];
  for (const set of rawExerciseSets(raw)) {
    const duration = num(set.duration);
    if (isRest(set)) {
      const last = out.at(-1);
      if (last && duration !== undefined) last.rest_s = Math.round(duration);
      continue;
    }
    const grams = num(set.weight);
    const exercise = likeliest(set);
    const reps = num(set.repetitionCount);
    out.push({
      ...(exercise && { exercise }),
      ...(reps !== undefined && { reps }),
      ...(grams !== undefined && grams > 0 && { weight_kg: Math.round(grams / 100) / 10 }),
      ...(duration !== undefined && { duration_s: Math.round(duration * 10) / 10 }),
    });
  }
  return out;
}

/**
 * The sets with exercise keys upper-cased and checked against Garmin's catalogue (loaded on
 * first use). An unknown key fails with the field that holds it, before anything is written.
 */
export async function checkExerciseSets(sets: readonly ExerciseSetInput[], keepTiming: boolean): Promise<ExerciseSetInput[]> {
  if (sets.length === 0) throw new InputError('exercise_sets is empty', 'Give at least one set; the sets replace all sets of the activity.');
  const { EXERCISE_CATALOG } = await import('./exercise-catalog.js');
  return sets.map((set, i) => {
    const field = `exercise_sets[${i}]`;
    for (const [key, min, above] of [['weight_kg', 0, false], ['duration_s', 0, true], ['rest_s', 0, false]] as const) {
      const v = set[key];
      if (v !== undefined && (above ? v <= min : v < min)) throw new InputError(`${field}.${key} must be ${above ? 'above' : 'at least'} ${min}`);
    }
    for (const key of ['duration_s', 'rest_s'] as const) {
      if (keepTiming && set[key] !== undefined) {
        throw new InputError(`${field}.${key}: keep_timing keeps the times the watch recorded`, 'Leave duration_s and rest_s out, or set keep_timing to false to write new times.');
      }
    }
    if (!keepTiming && set.duration_s === undefined) {
      throw new InputError(`${field}.duration_s is required without keep_timing`, 'Give each set its length in seconds, or set keep_timing to true to keep the times the watch recorded.');
    }
    if (!set.exercise) return set;
    const category = exerciseKey(set.exercise.category);
    if (set.exercise.name !== undefined && exerciseKey(set.exercise.name) === '') throw new InputError(`${field}.exercise.name is empty`, 'Leave name out to give the category only.');
    const names = EXERCISE_CATALOG[category];
    if (!names) {
      throw new InputError(`${field}.exercise.category: unknown exercise category "${set.exercise.category}"`, `Categories: ${Object.keys(EXERCISE_CATALOG).join(', ')}`);
    }
    if (set.exercise.name === undefined) return { ...set, exercise: { category } };
    const name = exerciseKey(set.exercise.name);
    if (!names.includes(name)) {
      const words = name.split('_').filter((w) => w.length >= 3);
      const close = names.filter((n) => words.some((w) => n.includes(w)));
      const listed = (close.length > 0 ? close : names).slice(0, 40);
      const hint = names.length === 0 ? `${category} has no exercise names; leave name out.` : `Exercises of ${category}${close.length > 0 ? ' with a similar name' : ''}: ${listed.join(', ')}`;
      throw new InputError(`${field}.exercise.name: unknown exercise "${set.exercise.name}" in category ${category}`, hint);
    }
    return { ...set, exercise: { category, name } };
  });
}

const exercises = (set: ExerciseSetInput) => (set.exercise ? [{ category: set.exercise.category, name: set.exercise.name ?? null, probability: 100 }] : []);
const grams = (kg: number | undefined) => (kg === undefined ? null : Math.round(kg * 1000));

/** "2026-10-04T17:44:52.0" (Garmin's set start, UTC) moved by `seconds`. */
function shiftStart(start: string, seconds: number): string {
  const ms = Date.parse(`${start.replace(' ', 'T').replace(/\.\d+$/, '')}Z`) + Math.round(seconds * 1000);
  return `${new Date(ms).toISOString().slice(0, 19)}.0`;
}

/**
 * Garmin's `exerciseSets` items that replace `current`. With `keepTiming` every active set keeps
 * what the watch recorded (start, duration, rest sets after it) and takes the exercise, reps and
 * weight given for it (left out = kept); the number of sets must match. Without it the sets are
 * written anew from `start` (UTC, Garmin's format), each followed by a rest set when `rest_s` > 0.
 */
export function exerciseSetsBody(current: readonly Obj[], sets: readonly ExerciseSetInput[], keepTiming: boolean, start: string | undefined): Obj[] {
  if (keepTiming) {
    const active = current.filter((s) => !isRest(s)).length;
    if (active !== sets.length) {
      throw new InputError(
        `exercise_sets: ${sets.length} set${sets.length === 1 ? '' : 's'} given, the activity has ${active}; keep_timing needs one entry per recorded set`,
        'Read the sets with get_activity detail "exercise_sets" (or previous_exercise_sets) and give one entry per set, in order.',
      );
    }
    let i = 0;
    return current.map((set) => {
      if (isRest(set)) return set;
      const edit = sets[i++] as ExerciseSetInput;
      return {
        ...set,
        ...(edit.exercise && { exercises: exercises(edit) }),
        ...(edit.reps !== undefined && { repetitionCount: edit.reps }),
        ...(edit.weight_kg !== undefined && { weight: grams(edit.weight_kg) }),
      };
    });
  }
  const out: Obj[] = [];
  let offset = 0;
  const at = () => (start === undefined ? null : shiftStart(start, offset));
  for (const set of sets) {
    const duration = set.duration_s as number;
    out.push({ setType: 'ACTIVE', exercises: exercises(set), repetitionCount: set.reps ?? null, weight: grams(set.weight_kg), duration, startTime: at(), wktStepIndex: null, messageIndex: out.length });
    offset += duration;
    if (set.rest_s) {
      out.push({ setType: 'REST', exercises: [], repetitionCount: null, weight: null, duration: set.rest_s, startTime: at(), wktStepIndex: null, messageIndex: out.length });
      offset += set.rest_s;
    }
  }
  return out;
}
