import { z } from 'zod';
import {
  END_CONDITIONS,
  SPORT_TYPES,
  STEP_TYPES,
  TARGET_TYPES,
  WEIGHT_UNIT_KILOGRAM,
  type GarminExecutableStep,
  type GarminRepeatGroup,
  type GarminStep,
  type GarminWorkout,
} from './garmin-constants.js';
import {
  definitionErrorFromZod,
  workoutDefinitionSchema,
  WorkoutDefinitionError,
  type Duration,
  type ExecutableStep,
  type Target,
  type WorkoutDefinition,
  type WorkoutStep,
} from './definition.js';
import { estimateWorkoutDuration } from './describe.js';

/** "4:30" per km → seconds per km. */
function paceSeconds(pace: string): number {
  const [m, s] = pace.split(':').map(Number) as [number, number];
  return m * 60 + s;
}

/** "4:30" per km → metres per second. */
export function paceToMetersPerSecond(pace: string): number {
  const seconds = paceSeconds(pace);
  if (seconds <= 0) throw new RangeError(`pace must be positive, got "${pace}"`);
  return 1000 / seconds;
}

const enumKey = (value: string) => value.trim().toUpperCase().replace(/[\s-]+/g, '_');

function durationFields(duration: Duration | undefined): Pick<GarminExecutableStep, 'endCondition' | 'endConditionValue'> {
  if (!duration) return { endCondition: END_CONDITIONS.lap_button };
  switch (duration.type) {
    case 'time':
      return { endCondition: END_CONDITIONS.time, endConditionValue: duration.seconds };
    case 'distance':
      return { endCondition: END_CONDITIONS.distance, endConditionValue: duration.meters };
    case 'lap_button':
      return { endCondition: END_CONDITIONS.lap_button };
    case 'reps':
      return { endCondition: END_CONDITIONS.reps, endConditionValue: duration.count };
    case 'calories':
      return { endCondition: END_CONDITIONS.calories, endConditionValue: duration.kcal };
  }
}

type TargetFields = Pick<GarminExecutableStep, 'targetType' | 'zoneNumber' | 'targetValueOne' | 'targetValueTwo'>;

function targetFields(target: Target | undefined, path: string): TargetFields {
  const range = (min: number, max: number, unit: string) => {
    if (min >= max) {
      throw new WorkoutDefinitionError(
        `min (${min}${unit}) must be lower than max (${max}${unit})`,
        path,
        'Put the lower bound in min and the higher one in max.',
      );
    }
    return { targetValueOne: min, targetValueTwo: max };
  };
  if (!target) return { targetType: TARGET_TYPES.no_target };
  switch (target.type) {
    case 'none':
      return { targetType: TARGET_TYPES.no_target };
    case 'hr_zone':
      return { targetType: TARGET_TYPES.heart_rate_zone, zoneNumber: target.zone };
    case 'hr_range':
      return { targetType: TARGET_TYPES.heart_rate_zone, ...range(target.min, target.max, ' bpm') };
    case 'pace': {
      const fast = paceToMetersPerSecond(target.min_per_km_fast);
      const slow = paceToMetersPerSecond(target.min_per_km_slow);
      if (fast <= slow) {
        throw new WorkoutDefinitionError(
          `min_per_km_fast (${target.min_per_km_fast}) must be faster than min_per_km_slow (${target.min_per_km_slow})`,
          path,
          'The fast end is the smaller time per km, e.g. min_per_km_fast "4:00" and min_per_km_slow "4:15".',
        );
      }
      // Garmin stores pace ranges as speeds, slow bound first (checked in Garmin Connect, E3-12).
      return { targetType: TARGET_TYPES.pace_zone, targetValueOne: slow, targetValueTwo: fast };
    }
    case 'power_zone':
      return { targetType: TARGET_TYPES.power_zone, zoneNumber: target.zone };
    case 'power_range':
      return { targetType: TARGET_TYPES.power_between, ...range(target.min, target.max, ' W') };
    case 'cadence':
      return { targetType: TARGET_TYPES.cadence, ...range(target.min, target.max, '') };
  }
}

// ------------------------------------------------------------------ outgoing JSON

/** A Garmin reference object (sport, step type, ...) that must be one of the rows of `table`. */
function knownRef<T extends Record<string, number | string>>(table: Record<string, T>, what: string) {
  const rows = Object.values(table);
  return z
    .record(z.string(), z.union([z.number(), z.string()]))
    .refine(
      (ref) => rows.some((row) => Object.keys(row).length === Object.keys(ref).length && Object.entries(row).every(([k, v]) => ref[k] === v)),
      { message: `unknown ${what}` },
    ) as unknown as z.ZodType<T>;
}

const sportRef = knownRef(SPORT_TYPES, 'sport type');
const stepTypeRef = knownRef(STEP_TYPES, 'step type');
const endConditionRef = knownRef(END_CONDITIONS, 'end condition');
const targetTypeRef = knownRef(TARGET_TYPES, 'target type');
const enumKeyString = z.string().regex(/^[A-Z0-9_]+$/, 'must be an upper-case Garmin key');

const garminExecutableStepSchema = z
  .strictObject({
    type: z.literal('ExecutableStepDTO'),
    stepOrder: z.number().int().positive(),
    stepType: stepTypeRef,
    description: z.string().max(512).optional(),
    endCondition: endConditionRef,
    endConditionValue: z.number().positive().optional(),
    targetType: targetTypeRef,
    zoneNumber: z.number().int().positive().optional(),
    targetValueOne: z.number().positive().optional(),
    targetValueTwo: z.number().positive().optional(),
    category: enumKeyString.optional(),
    exerciseName: enumKeyString.optional(),
    weightValue: z.number().positive().optional(),
    weightUnit: z
      .strictObject({ unitId: z.literal(WEIGHT_UNIT_KILOGRAM.unitId), unitKey: z.literal(WEIGHT_UNIT_KILOGRAM.unitKey), factor: z.literal(WEIGHT_UNIT_KILOGRAM.factor) })
      .optional(),
    childStepId: z.number().int().positive().optional(),
  })
  .superRefine((step, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    const lap = step.endCondition.conditionTypeKey === END_CONDITIONS.lap_button.conditionTypeKey;
    if (lap !== (step.endConditionValue === undefined)) fail('endConditionValue is required for every end condition except lap.button');
    const hasRange = step.targetValueOne !== undefined || step.targetValueTwo !== undefined;
    if ((step.targetValueOne === undefined) !== (step.targetValueTwo === undefined)) fail('targetValueOne and targetValueTwo go together');
    if (step.zoneNumber !== undefined && hasRange) fail('zoneNumber and target values are exclusive');
    const noTarget = step.targetType.workoutTargetTypeKey === TARGET_TYPES.no_target.workoutTargetTypeKey;
    if (noTarget === (step.zoneNumber !== undefined || hasRange)) fail('a target needs a zoneNumber or a range, no.target needs neither');
    if ((step.weightValue === undefined) !== (step.weightUnit === undefined)) fail('weightValue and weightUnit go together');
    if (step.exerciseName !== undefined && step.category === undefined) fail('exerciseName needs a category');
  });

const garminRepeatGroupSchema = z
  .strictObject({
    type: z.literal('RepeatGroupDTO'),
    stepOrder: z.number().int().positive(),
    stepType: z.strictObject({ stepTypeId: z.literal(STEP_TYPES.repeat.stepTypeId), stepTypeKey: z.literal(STEP_TYPES.repeat.stepTypeKey) }),
    numberOfIterations: z.number().int().min(1).max(99),
    smartRepeat: z.boolean(),
    endCondition: z.strictObject({
      conditionTypeId: z.literal(END_CONDITIONS.iterations.conditionTypeId),
      conditionTypeKey: z.literal(END_CONDITIONS.iterations.conditionTypeKey),
    }),
    endConditionValue: z.number().int().positive(),
    childStepId: z.number().int().positive(),
    get workoutSteps(): z.ZodArray<z.ZodType<GarminStep>> {
      return z.array(garminStepSchema).min(1);
    },
  })
  .refine((group) => group.numberOfIterations === group.endConditionValue, {
    message: 'numberOfIterations and endConditionValue must be equal',
  });

const garminStepSchema: z.ZodType<GarminStep> = z.union([garminExecutableStepSchema, garminRepeatGroupSchema]);

/**
 * Strict schema of the workout JSON `compileWorkout` sends to Garmin: only the fields
 * the compiler emits, every reference object taken from the Garmin tables, and the
 * pairs of fields that must appear together. Raw `garmin_json` input is not held to it.
 */
export const garminWorkoutSchema: z.ZodType<GarminWorkout> = z.strictObject({
  workoutName: z.string().min(1).max(80),
  description: z.string().max(1024).optional(),
  sportType: sportRef,
  estimatedDurationInSecs: z.number().int().positive().optional(),
  workoutSegments: z
    .array(z.strictObject({ segmentOrder: z.number().int().positive(), sportType: sportRef, workoutSteps: z.array(garminStepSchema).min(1) }))
    .min(1),
});

// ------------------------------------------------------------------ compiler

const DEFINITION_HINT = 'Fix this field in the definition and call create_workout again; the tool input schema lists the allowed values.';

/**
 * Compile a typed definition into Garmin Connect workout JSON (accepted by
 * POST workout-service/workout). Step orders run depth-first over the whole tree:
 * a repeat group takes one order and its children continue from there. Each repeat
 * group gets its own childStepId, shared with its direct children. The result is
 * checked against `garminWorkoutSchema` before it is returned.
 */
export function compileWorkout(input: WorkoutDefinition): GarminWorkout {
  const parsed = workoutDefinitionSchema.safeParse(input);
  if (!parsed.success) throw definitionErrorFromZod(parsed.error, [], DEFINITION_HINT);
  const def = parsed.data;
  const sport = SPORT_TYPES[def.sport];
  let order = 0;
  let groupId = 0;

  const compileExecutable = (step: ExecutableStep, path: string, childStepId: number | undefined): GarminExecutableStep => {
    order += 1;
    const out: GarminExecutableStep = {
      type: 'ExecutableStepDTO',
      stepOrder: order,
      stepType: STEP_TYPES[step.kind],
      ...durationFields(step.duration),
      ...targetFields(step.target, `${path}.target`),
    };
    if (step.notes) out.description = step.notes;
    if (step.exercise) {
      out.category = enumKey(step.exercise.category);
      if (step.exercise.name) out.exerciseName = enumKey(step.exercise.name);
    }
    if (step.weight_kg !== undefined) {
      out.weightValue = step.weight_kg * WEIGHT_UNIT_KILOGRAM.factor;
      out.weightUnit = { ...WEIGHT_UNIT_KILOGRAM };
    }
    if (childStepId !== undefined) out.childStepId = childStepId;
    return out;
  };

  const compileSteps = (steps: WorkoutStep[], path: string, childStepId?: number): GarminStep[] =>
    steps.map((step, i) => {
      const stepPath = `${path}[${i}]`;
      if (step.kind !== 'repeat') return compileExecutable(step, stepPath, childStepId);
      order += 1;
      groupId += 1;
      const group: GarminRepeatGroup = {
        type: 'RepeatGroupDTO',
        stepOrder: order,
        stepType: STEP_TYPES.repeat,
        numberOfIterations: step.count,
        smartRepeat: false,
        endCondition: END_CONDITIONS.iterations,
        endConditionValue: step.count,
        childStepId: groupId,
        workoutSteps: [],
      };
      group.workoutSteps = compileSteps(step.steps, `${stepPath}.steps`, groupId);
      return group;
    });

  const workoutSteps = compileSteps(def.steps, 'steps');
  const workout: GarminWorkout = {
    workoutName: def.name,
    sportType: { ...sport },
    workoutSegments: [{ segmentOrder: 1, sportType: { ...sport }, workoutSteps }],
  };
  if (def.description) workout.description = def.description;
  const estimate = estimateWorkoutDuration(workout).seconds;
  if (estimate > 0) workout.estimatedDurationInSecs = estimate;
  return garminWorkoutSchema.parse(workout);
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * True when `x` already looks like Garmin workout JSON (workoutName, sportType and
 * segments with steps), so a tool can accept raw Garmin JSON instead of a definition.
 */
export function isGarminWorkoutJson(x: unknown): x is GarminWorkout {
  if (!isRecord(x)) return false;
  if (typeof x.workoutName !== 'string' || !isRecord(x.sportType)) return false;
  if (!Array.isArray(x.workoutSegments) || x.workoutSegments.length === 0) return false;
  return x.workoutSegments.every((seg) => isRecord(seg) && Array.isArray(seg.workoutSteps));
}
