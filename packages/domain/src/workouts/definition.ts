/**
 * LLM-friendly workout definition. The MCP `create_workout` tool exposes this schema
 * (descriptions included); `compileWorkout` turns it into Garmin Connect JSON.
 */
import { GarminError } from 'garmin-mcp-config';
import { z } from 'zod';
import { SPORT_KEYS } from './garmin-constants.js';

const PACE = /^\d{1,2}:[0-5]\d$/;

export const paceString = z
  .string()
  .regex(PACE, 'pace must be m:ss per km, e.g. "4:30"')
  .refine((pace) => pace.replace(/[0:]/g, '') !== '', 'pace must be above 0:00')
  .meta({ id: 'Pace', description: 'Pace as minutes:seconds per kilometre, e.g. "4:30"' });

export const durationSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('time'), seconds: z.number().positive().describe('Step length in seconds') }),
    z.object({ type: z.literal('distance'), meters: z.number().positive().describe('Step length in metres') }),
    z.object({ type: z.literal('lap_button').describe('Step ends when the athlete presses the lap button') }),
    z.object({ type: z.literal('reps'), count: z.number().int().positive().describe('Repetitions (strength)') }),
    z.object({ type: z.literal('calories'), kcal: z.number().positive().describe('Step ends after this many kcal') }),
  ])
  .meta({ id: 'Duration', description: 'How the step ends. Omit for "lap button".' });

export const targetSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('none') }),
    z.object({
      type: z.literal('hr_zone'),
      zone: z.number().int().min(1).max(5).describe('Garmin heart-rate zone 1-5'),
    }),
    z.object({
      type: z.literal('hr_range'),
      min: z.number().int().min(30).max(250).describe('Lower bound in bpm'),
      max: z.number().int().min(30).max(250).describe('Upper bound in bpm'),
    }),
    z.object({
      type: z.literal('pace'),
      min_per_km_fast: paceString.describe('Fast end of the pace range, m:ss per km'),
      min_per_km_slow: paceString.describe('Slow end of the pace range, m:ss per km'),
    }),
    z.object({
      type: z.literal('power_zone'),
      zone: z.number().int().min(1).max(7).describe('Garmin power zone 1-7 (based on FTP)'),
    }),
    z.object({
      type: z.literal('power_range'),
      min: z.number().int().positive().describe('Lower bound in watts'),
      max: z.number().int().positive().describe('Upper bound in watts'),
    }),
    z.object({
      type: z.literal('cadence'),
      min: z.number().int().positive().describe('Lower bound in steps or revolutions per minute'),
      max: z.number().int().positive().describe('Upper bound in steps or revolutions per minute'),
    }),
  ])
  .meta({ id: 'Target', description: 'Intensity target. Omit for no target.' });

export const exerciseSchema = z
  .object({
    category: z.string().min(1).describe('Garmin exercise category, e.g. "BENCH_PRESS", "SQUAT", "PLANK"'),
    name: z
      .string()
      .min(1)
      .optional()
      .describe('Garmin exercise key within the category, e.g. "BARBELL_BENCH_PRESS"'),
  })
  .meta({ id: 'Exercise', description: 'Strength exercise from the Garmin catalogue' });

export const STEP_KINDS = ['warmup', 'cooldown', 'interval', 'recovery', 'rest', 'other'] as const;

export const executableStepSchema = z
  .object({
    kind: z.enum(STEP_KINDS).describe('Step role; use "interval" for the main work'),
    duration: durationSchema.optional(),
    target: targetSchema.optional(),
    notes: z.string().max(512).optional().describe('Text shown on the watch for this step'),
    exercise: exerciseSchema.optional(),
    weight_kg: z.number().positive().optional().describe('Target load for a strength step, in kg'),
  })
  .meta({ id: 'ExecutableStep' });

export interface RepeatStep {
  kind: 'repeat';
  count: number;
  steps: WorkoutStep[];
}
export type ExecutableStep = z.infer<typeof executableStepSchema>;
export type WorkoutStep = ExecutableStep | RepeatStep;

export const repeatStepSchema: z.ZodType<RepeatStep> = z
  .object({
    kind: z.literal('repeat'),
    count: z.number().int().min(1).max(99).describe('How many times to repeat the nested steps'),
    get steps(): z.ZodArray<z.ZodType<WorkoutStep>> {
      return z.array(stepSchema).min(1).describe('Steps repeated together; may contain further repeats');
    },
  })
  .meta({ id: 'RepeatStep' });

export const stepSchema: z.ZodType<WorkoutStep> = z.union([executableStepSchema, repeatStepSchema]).meta({ id: 'Step' });

export const workoutDefinitionSchema = z
  .object({
    name: z.string().min(1).max(80).describe('Workout name shown in Garmin Connect and on the watch'),
    sport: z.enum(SPORT_KEYS).describe('Sport of the workout'),
    description: z.string().max(1024).optional(),
    steps: z.array(stepSchema).min(1).describe('Ordered steps; nest with {"kind":"repeat"}'),
  })
  .describe(
    'Typed workout. Example: {"name":"6x400m","sport":"running","steps":[{"kind":"warmup","duration":{"type":"time","seconds":600}},' +
      '{"kind":"repeat","count":6,"steps":[{"kind":"interval","duration":{"type":"distance","meters":400},' +
      '"target":{"type":"pace","min_per_km_fast":"3:50","min_per_km_slow":"4:05"}},{"kind":"recovery","duration":{"type":"time","seconds":90}}]},' +
      '{"kind":"cooldown","duration":{"type":"lap_button"}}]}',
  );

export type WorkoutDefinition = z.infer<typeof workoutDefinitionSchema>;
export type Duration = z.infer<typeof durationSchema>;
export type Target = z.infer<typeof targetSchema>;

/**
 * A definition (or preset parameters) that cannot become a workout. `path` points at the
 * offending field, e.g. `steps[2].steps[0].target`; `hint` says how to fix it.
 */
export class WorkoutDefinitionError extends GarminError {
  constructor(
    message: string,
    readonly path: string,
    hint = 'Fix this field and call create_workout again.',
  ) {
    super('INVALID_INPUT', path ? `${path}: ${message}` : message, { hint });
  }
}

/** `['steps', 2, 'steps', 0, 'target']` → `steps[2].steps[0].target`. */
export function formatFieldPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((out, key) => {
    if (typeof key === 'number') return `${out}[${key}]`;
    const name = String(key);
    return out ? `${out}.${name}` : name;
  }, '');
}

interface FlatIssue {
  path: PropertyKey[];
  message: string;
}

/**
 * A step is a union of an executable step and a repeat, so zod reports a bad step as
 * "invalid union" at the step itself. Follow the branch whose error points deepest:
 * that is the branch the caller meant, and its path names the actual field.
 */
function deepestIssue(issue: z.core.$ZodIssue, prefix: PropertyKey[]): FlatIssue {
  const path = [...prefix, ...issue.path];
  if (issue.code === 'invalid_union' && issue.errors.length > 0) {
    const branches = issue.errors.flatMap((branch) => (branch[0] ? [deepestIssue(branch[0], path)] : []));
    if (branches.length > 0) return branches.reduce((best, b) => (b.path.length > best.path.length ? b : best));
  }
  return { path, message: issue.message };
}

/** Turn a zod failure into a WorkoutDefinitionError naming the first bad field. */
export function definitionErrorFromZod(error: z.ZodError, prefix: PropertyKey[] = [], hint?: string): WorkoutDefinitionError {
  const [first, ...rest] = error.issues;
  if (!first) return new WorkoutDefinitionError(error.message, formatFieldPath(prefix), hint);
  const issue = deepestIssue(first, prefix);
  const more = rest.length > 0 ? ` (and ${rest.length} more issue${rest.length > 1 ? 's' : ''})` : '';
  return new WorkoutDefinitionError(`${issue.message}${more}`, formatFieldPath(issue.path), hint);
}
