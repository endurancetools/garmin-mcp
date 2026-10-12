/**
 * Ready-made workouts as typed definitions. A preset only fills in a `WorkoutDefinition`;
 * `compileWorkout` turns it into Garmin JSON, so nothing here knows the Garmin format.
 */
import { z } from 'zod';
import {
  definitionErrorFromZod,
  exerciseSchema,
  targetSchema,
  type Duration,
  type ExecutableStep,
  type Target,
  type WorkoutDefinition,
  type WorkoutStep,
} from './definition.js';

const workoutName = z.string().min(1).max(80).optional().describe('Workout name; default is built from the parameters');
const minutes = (what: string, fallback: number) =>
  z.number().min(0).max(120).default(fallback).describe(`${what} in minutes; 0 leaves the step out`);
const seconds = (what: string) => z.number().int().positive().max(4 * 3600).describe(`${what} in seconds`);
const repeats = z.number().int().min(1).max(50);

const runIntervalsParams = z
  .object({
    workout_name: workoutName,
    repeats: repeats.describe('Number of work intervals'),
    work_seconds: seconds('Length of one work interval').optional().describe('Work interval by time; give this or work_meters'),
    work_meters: z.number().positive().max(42_195).optional().describe('Work interval by distance in metres; give this or work_seconds'),
    work_target: targetSchema.optional().describe('Intensity of the work intervals, e.g. a pace range or HR zone 4'),
    recovery_seconds: z.number().int().min(0).max(1800).default(90).describe('Recovery after each interval in seconds; 0 for none'),
    recovery_target: targetSchema.optional().describe('Intensity of the recoveries; default none'),
    warmup_min: minutes('Warm-up', 10),
    cooldown_min: minutes('Cool-down', 10),
  })
  .refine((p) => (p.work_seconds === undefined) !== (p.work_meters === undefined), {
    message: 'give exactly one of work_seconds or work_meters',
    path: ['work_seconds'],
  });

const walkRunParams = z.object({
  workout_name: workoutName,
  repeats: repeats.describe('Number of run/walk pairs'),
  run_seconds: seconds('Run part of each pair'),
  walk_seconds: seconds('Walk part of each pair'),
  run_target: targetSchema.optional().describe('Intensity of the run parts; default none'),
  walk_target: targetSchema.optional().describe('Intensity of the walk parts; default none'),
  warmup_min: minutes('Walking warm-up', 5),
  cooldown_min: minutes('Walking cool-down', 5),
});

const easyZ2Params = z.object({
  workout_name: workoutName,
  sport: z.enum(['running', 'walking', 'cycling']).default('running'),
  duration_min: z.number().positive().max(600).describe('Length of the easy part in minutes'),
  target: targetSchema
    .default({ type: 'hr_zone', zone: 2 })
    .describe('Intensity of the easy part; default HR zone 2. Use hr_range for personal bpm limits'),
  warmup_min: minutes('Warm-up', 0),
  cooldown_min: minutes('Cool-down', 0),
});

const circuitExercise = z
  .object({
    exercise: exerciseSchema,
    reps: z.number().int().positive().max(200).optional().describe('Repetitions per round; give this or seconds'),
    seconds: seconds('Work time per round').optional().describe('Work time per round; give this or reps'),
    weight_kg: z.number().positive().optional().describe('Load in kg'),
    notes: z.string().max(512).optional(),
  })
  .refine((e) => e.reps === undefined || e.seconds === undefined, {
    message: 'give reps or seconds, not both (neither: the exercise ends with the lap button)',
    path: ['reps'],
  });

const strengthCircuitParams = z.object({
  workout_name: workoutName,
  rounds: z.number().int().min(1).max(20).default(3).describe('How many times the whole circuit is done'),
  exercises: z.array(circuitExercise).min(1).max(20).describe('Exercises in circuit order'),
  rest_between_exercises_s: z.number().int().min(0).max(600).default(0).describe('Rest after each exercise except the last; 0 for none'),
  rest_between_rounds_s: z.number().int().min(0).max(1800).default(90).describe('Rest after each round; 0 for none'),
});

export const workoutPresetSchema = z
  .discriminatedUnion('name', [
    z.object({
      name: z.literal('run_intervals').describe('Warm-up, N x (work by time or distance + recovery), cool-down; running'),
      params: runIntervalsParams,
    }),
    z.object({
      name: z.literal('walk_run').describe('Walking warm-up, N x (run + walk), walking cool-down; running'),
      params: walkRunParams,
    }),
    z.object({
      name: z.literal('easy_z2').describe('One continuous easy block (default HR zone 2), optional warm-up and cool-down'),
      params: easyZ2Params,
    }),
    z.object({
      name: z.literal('strength_circuit').describe('Rounds of exercises (reps or time, optional load) with rests; strength training'),
      params: strengthCircuitParams,
    }),
  ])
  .describe(
    'Ready-made workout filled in from a few parameters. Example: {"name":"run_intervals","params":{"repeats":6,"work_meters":400,' +
      '"work_target":{"type":"pace","min_per_km_fast":"3:50","min_per_km_slow":"4:05"},"recovery_seconds":90}}',
  );

/** What a caller passes (defaults not applied yet). */
export type WorkoutPreset = z.input<typeof workoutPresetSchema>;
export type WorkoutPresetName = WorkoutPreset['name'];
export const WORKOUT_PRESET_NAMES = workoutPresetSchema.options.map((o) => o.shape.name.value) as WorkoutPresetName[];

// ------------------------------------------------------------------ helpers

const clock = (totalSeconds: number) => {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.round(totalSeconds % 60);
  return s === 0 ? `${m} min` : `${m}:${String(s).padStart(2, '0')}`;
};
const metres = (m: number) => (m >= 1000 ? `${Number((m / 1000).toFixed(2))} km` : `${m} m`);
const shortName = (text: string) => (text.length <= 80 ? text : `${text.slice(0, 79)}…`);

const time = (s: number): Duration => ({ type: 'time', seconds: s });

function step(kind: ExecutableStep['kind'], duration: Duration | undefined, target?: Target, notes?: string): ExecutableStep {
  const out: ExecutableStep = { kind };
  if (duration) out.duration = duration;
  if (target && target.type !== 'none') out.target = target;
  if (notes) out.notes = notes;
  return out;
}

/** Wrap `steps` around warm-up and cool-down steps of the given minutes (0 = none). */
function framed(warmupMin: number, steps: WorkoutStep[], cooldownMin: number, warmupNote?: string, cooldownNote?: string): WorkoutStep[] {
  return [
    ...(warmupMin > 0 ? [step('warmup', time(warmupMin * 60), undefined, warmupNote)] : []),
    ...steps,
    ...(cooldownMin > 0 ? [step('cooldown', time(cooldownMin * 60), undefined, cooldownNote)] : []),
  ];
}

/** A repeat of `count`, or the steps themselves when there is only one round. */
const repeated = (count: number, steps: WorkoutStep[]): WorkoutStep[] => (count > 1 ? [{ kind: 'repeat', count, steps }] : steps);

// ------------------------------------------------------------------ presets

function runIntervals(p: z.output<typeof runIntervalsParams>): WorkoutDefinition {
  const work: Duration = p.work_meters !== undefined ? { type: 'distance', meters: p.work_meters } : time(p.work_seconds ?? 0);
  const workLabel = p.work_meters !== undefined ? metres(p.work_meters) : clock(p.work_seconds ?? 0);
  const block: WorkoutStep[] = [step('interval', work, p.work_target)];
  if (p.recovery_seconds > 0) block.push(step('recovery', time(p.recovery_seconds), p.recovery_target));
  return {
    name: p.workout_name ?? shortName(`${p.repeats}x${workLabel}`),
    sport: 'running',
    steps: framed(p.warmup_min, repeated(p.repeats, block), p.cooldown_min),
  };
}

function walkRun(p: z.output<typeof walkRunParams>): WorkoutDefinition {
  const block = [step('interval', time(p.run_seconds), p.run_target, 'Run'), step('recovery', time(p.walk_seconds), p.walk_target, 'Walk')];
  return {
    name: p.workout_name ?? shortName(`Walk/run ${p.repeats}x ${clock(p.run_seconds)} run / ${clock(p.walk_seconds)} walk`),
    sport: 'running',
    steps: framed(p.warmup_min, repeated(p.repeats, block), p.cooldown_min, 'Walk', 'Walk'),
  };
}

function easyZ2(p: z.output<typeof easyZ2Params>): WorkoutDefinition {
  return {
    name: p.workout_name ?? shortName(`Easy ${p.sport} ${clock(p.duration_min * 60)}`),
    sport: p.sport,
    steps: framed(p.warmup_min, [step('interval', time(p.duration_min * 60), p.target, 'Easy, conversational')], p.cooldown_min),
  };
}

function strengthCircuit(p: z.output<typeof strengthCircuitParams>): WorkoutDefinition {
  const round: WorkoutStep[] = [];
  p.exercises.forEach((e, i) => {
    const duration: Duration | undefined =
      e.reps !== undefined ? { type: 'reps', count: e.reps } : e.seconds !== undefined ? time(e.seconds) : undefined;
    const work: ExecutableStep = { ...step('interval', duration, undefined, e.notes), exercise: e.exercise };
    if (e.weight_kg !== undefined) work.weight_kg = e.weight_kg;
    round.push(work);
    if (p.rest_between_exercises_s > 0 && i < p.exercises.length - 1) round.push(step('rest', time(p.rest_between_exercises_s)));
  });
  if (p.rounds > 1 && p.rest_between_rounds_s > 0) round.push(step('rest', time(p.rest_between_rounds_s)));
  return {
    name: p.workout_name ?? shortName(`Strength circuit ${p.rounds}x${p.exercises.length}`),
    sport: 'strength_training',
    steps: repeated(p.rounds, round),
  };
}

/**
 * Fill in the definition of a preset. Parameters are validated here (defaults applied),
 * so bad input fails with a WorkoutDefinitionError whose path starts at `preset`.
 */
export function presetDefinition(input: WorkoutPreset): WorkoutDefinition {
  const parsed = workoutPresetSchema.safeParse(input);
  if (!parsed.success) {
    throw definitionErrorFromZod(parsed.error, ['preset'], 'Fix this preset parameter and call create_workout again.');
  }
  const preset = parsed.data;
  switch (preset.name) {
    case 'run_intervals':
      return runIntervals(preset.params);
    case 'walk_run':
      return walkRun(preset.params);
    case 'easy_z2':
      return easyZ2(preset.params);
    case 'strength_circuit':
      return strengthCircuit(preset.params);
  }
}
