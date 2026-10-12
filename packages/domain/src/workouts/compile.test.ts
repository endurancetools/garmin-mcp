import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileWorkout, garminWorkoutSchema, isGarminWorkoutJson, paceToMetersPerSecond } from './compile.js';
import { WorkoutDefinitionError, workoutDefinitionSchema, type WorkoutDefinition } from './definition.js';
import { estimateWorkoutDuration } from './describe.js';
import type { GarminStep, GarminWorkout } from './garmin-constants.js';

const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures/workouts');
const recorded = (name: string): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

// Garmin reference objects, written out as they appear in workout JSON.
const RUNNING = { sportTypeId: 1, sportTypeKey: 'running' };
const STRENGTH = { sportTypeId: 5, sportTypeKey: 'strength_training' };
const WARMUP = { stepTypeId: 1, stepTypeKey: 'warmup' };
const COOLDOWN = { stepTypeId: 2, stepTypeKey: 'cooldown' };
const INTERVAL = { stepTypeId: 3, stepTypeKey: 'interval' };
const RECOVERY = { stepTypeId: 4, stepTypeKey: 'recovery' };
const REST = { stepTypeId: 5, stepTypeKey: 'rest' };
const REPEAT = { stepTypeId: 6, stepTypeKey: 'repeat' };
const LAP = { conditionTypeId: 1, conditionTypeKey: 'lap.button' };
const TIME = { conditionTypeId: 2, conditionTypeKey: 'time' };
const DISTANCE = { conditionTypeId: 3, conditionTypeKey: 'distance' };
const ITERATIONS = { conditionTypeId: 7, conditionTypeKey: 'iterations' };
const REPS = { conditionTypeId: 10, conditionTypeKey: 'reps' };
const NO_TARGET = { workoutTargetTypeId: 1, workoutTargetTypeKey: 'no.target' };
const HR_ZONE = { workoutTargetTypeId: 4, workoutTargetTypeKey: 'heart.rate.zone' };
const PACE_ZONE = { workoutTargetTypeId: 6, workoutTargetTypeKey: 'pace.zone' };
const KG = { unitId: 8, unitKey: 'kilogram', factor: 1000 } as const;
/** Garmin keeps pace as speed in m/s: "3:40" per km is 1000 / 220. */
const speed = (secondsPerKm: number) => 1000 / secondsPerKm;

const hills: WorkoutDefinition = {
  name: 'Hill sprints',
  sport: 'running',
  description: 'Short hills, full recoveries',
  steps: [
    { kind: 'warmup', duration: { type: 'time', seconds: 600 }, target: { type: 'hr_range', min: 110, max: 135 } },
    {
      kind: 'repeat',
      count: 2,
      steps: [
        {
          kind: 'repeat',
          count: 4,
          steps: [
            {
              kind: 'interval',
              duration: { type: 'distance', meters: 200 },
              target: { type: 'pace', min_per_km_fast: '3:30', min_per_km_slow: '3:40' },
              notes: 'Fast',
            },
            { kind: 'recovery', duration: { type: 'time', seconds: 60 } },
          ],
        },
        { kind: 'rest', duration: { type: 'time', seconds: 180 }, target: { type: 'hr_zone', zone: 1 } },
      ],
    },
    { kind: 'cooldown' },
  ],
};

const hillsJson: GarminWorkout = {
  workoutName: 'Hill sprints',
  description: 'Short hills, full recoveries',
  sportType: RUNNING,
  // 200 m at 3:35 /km, the middle of the 3:30-3:40 range, takes 43 s; the lap-button cool-down adds nothing.
  estimatedDurationInSecs: 600 + 2 * (4 * (43 + 60) + 180),
  workoutSegments: [
    {
      segmentOrder: 1,
      sportType: RUNNING,
      workoutSteps: [
        {
          type: 'ExecutableStepDTO',
          stepOrder: 1,
          stepType: WARMUP,
          endCondition: TIME,
          endConditionValue: 600,
          targetType: HR_ZONE,
          targetValueOne: 110,
          targetValueTwo: 135,
        },
        {
          type: 'RepeatGroupDTO',
          stepOrder: 2,
          stepType: REPEAT,
          numberOfIterations: 2,
          smartRepeat: false,
          endCondition: ITERATIONS,
          endConditionValue: 2,
          childStepId: 1,
          workoutSteps: [
            {
              type: 'RepeatGroupDTO',
              stepOrder: 3,
              stepType: REPEAT,
              numberOfIterations: 4,
              smartRepeat: false,
              endCondition: ITERATIONS,
              endConditionValue: 4,
              childStepId: 2,
              workoutSteps: [
                {
                  type: 'ExecutableStepDTO',
                  stepOrder: 4,
                  stepType: INTERVAL,
                  description: 'Fast',
                  endCondition: DISTANCE,
                  endConditionValue: 200,
                  targetType: PACE_ZONE,
                  targetValueOne: speed(220),
                  targetValueTwo: speed(210),
                  childStepId: 2,
                },
                {
                  type: 'ExecutableStepDTO',
                  stepOrder: 5,
                  stepType: RECOVERY,
                  endCondition: TIME,
                  endConditionValue: 60,
                  targetType: NO_TARGET,
                  childStepId: 2,
                },
              ],
            },
            {
              type: 'ExecutableStepDTO',
              stepOrder: 6,
              stepType: REST,
              endCondition: TIME,
              endConditionValue: 180,
              targetType: HR_ZONE,
              zoneNumber: 1,
              childStepId: 1,
            },
          ],
        },
        { type: 'ExecutableStepDTO', stepOrder: 7, stepType: COOLDOWN, endCondition: LAP, targetType: NO_TARGET },
      ],
    },
  ],
};

const squats: WorkoutDefinition = {
  name: 'Heavy squats',
  sport: 'strength_training',
  steps: [
    {
      kind: 'interval',
      duration: { type: 'reps', count: 5 },
      exercise: { category: 'squat', name: 'barbell back squat' },
      weight_kg: 102.5,
      notes: 'Belt on',
    },
    { kind: 'rest', duration: { type: 'time', seconds: 180 } },
  ],
};

const squatsJson: GarminWorkout = {
  workoutName: 'Heavy squats',
  sportType: STRENGTH,
  estimatedDurationInSecs: 180,
  workoutSegments: [
    {
      segmentOrder: 1,
      sportType: STRENGTH,
      workoutSteps: [
        {
          type: 'ExecutableStepDTO',
          stepOrder: 1,
          stepType: INTERVAL,
          description: 'Belt on',
          endCondition: REPS,
          endConditionValue: 5,
          targetType: NO_TARGET,
          category: 'SQUAT',
          exerciseName: 'BARBELL_BACK_SQUAT',
          weightValue: 102_500,
          weightUnit: KG,
        },
        { type: 'ExecutableStepDTO', stepOrder: 2, stepType: REST, endCondition: TIME, endConditionValue: 180, targetType: NO_TARGET },
      ],
    },
  ],
};

/** Keep only what a step says about the session, dropping step numbering and group bookkeeping. */
function content(steps: readonly unknown[]): unknown[] {
  return steps.map((raw) => {
    const s = raw as Record<string, unknown>;
    if (s.type === 'RepeatGroupDTO') {
      return { type: s.type, numberOfIterations: s.numberOfIterations, workoutSteps: content(s.workoutSteps as unknown[]) };
    }
    const pick = (k: string) => (s[k] === null || s[k] === undefined ? {} : { [k]: s[k] });
    const ref = (k: string, ...keys: string[]) => {
      const v = s[k] as Record<string, unknown> | null | undefined;
      return v ? { [k]: Object.fromEntries(keys.map((key) => [key, v[key]])) } : {};
    };
    return {
      type: s.type,
      ...ref('stepType', 'stepTypeId', 'stepTypeKey'),
      ...pick('description'),
      ...ref('endCondition', 'conditionTypeId', 'conditionTypeKey'),
      ...pick('endConditionValue'),
      ...ref('targetType', 'workoutTargetTypeId', 'workoutTargetTypeKey'),
      ...pick('zoneNumber'),
      ...pick('targetValueOne'),
      ...pick('targetValueTwo'),
    };
  });
}
const segmentSteps = (w: Record<string, unknown> | GarminWorkout) =>
  (w.workoutSegments as { workoutSteps: GarminStep[] }[])[0]!.workoutSteps;

describe('compileWorkout: expected Garmin JSON', () => {
  it('nested repeats, pace range, HR range and HR zone', () => {
    expect(compileWorkout(hills)).toStrictEqual(hillsJson);
  });

  it('strength step with exercise keys and load in grams', () => {
    expect(compileWorkout(squats)).toStrictEqual(squatsJson);
  });
});

describe('compileWorkout against recorded Garmin workouts', () => {
  it('reproduces the steps of a workout read back from Garmin, numbering included', () => {
    const fromGarmin = recorded('sample-garmin-get-workout.json');
    const compiled = compileWorkout({
      name: 'Tempo 3x8min',
      sport: 'running',
      description: 'Threshold session',
      steps: [
        { kind: 'warmup', duration: { type: 'time', seconds: 900 }, target: { type: 'hr_zone', zone: 2 } },
        {
          kind: 'repeat',
          count: 3,
          steps: [
            {
              kind: 'interval',
              duration: { type: 'time', seconds: 480 },
              target: { type: 'pace', min_per_km_fast: '4:40', min_per_km_slow: '4:50' },
              notes: 'Comfortably hard',
            },
            { kind: 'recovery', duration: { type: 'distance', meters: 400 } },
          ],
        },
        { kind: 'cooldown', target: { type: 'hr_range', min: 120, max: 140 } },
      ],
    });
    // Garmin's own estimate also counts the 400 m step that has no target; ours leaves it out.
    const { estimatedDurationInSecs: _ours, ...rest } = compiled;
    expect(fromGarmin).toMatchObject(rest);
  });

  it('reproduces the content of a walk/run workout Garmin accepted', () => {
    const accepted = recorded('captured-poc-walk-run.json');
    const zone3 = { type: 'hr_zone', zone: 3 } as const;
    const compiled = compileWorkout({
      name: accepted.workoutName as string,
      sport: 'running',
      description: accepted.description as string,
      steps: [
        { kind: 'warmup', duration: { type: 'time', seconds: 600 }, notes: 'Warmup 10 min' },
        {
          kind: 'repeat',
          count: 7,
          steps: [
            { kind: 'interval', duration: { type: 'time', seconds: 60 }, target: zone3, notes: 'Run 60s Z3' },
            { kind: 'recovery', duration: { type: 'time', seconds: 180 }, target: zone3, notes: 'Walk 180s Z3' },
          ],
        },
        { kind: 'cooldown', duration: { type: 'time', seconds: 480 }, notes: 'Cooldown 8 min' },
      ],
    });
    expect(compiled.workoutName).toBe(accepted.workoutName);
    expect(compiled.sportType).toEqual(accepted.sportType);
    expect(content(segmentSteps(compiled))).toEqual(content(segmentSteps(accepted)));
  });
});

describe('compileWorkout: definition errors', () => {
  const run = (steps: unknown[]) => () => compileWorkout({ name: 'x', sport: 'running', steps } as WorkoutDefinition);
  const caught = (fn: () => unknown): WorkoutDefinitionError => {
    try {
      fn();
    } catch (err) {
      if (err instanceof WorkoutDefinitionError) return err;
      throw err;
    }
    throw new Error('expected a WorkoutDefinitionError');
  };

  it('points at the target of a nested step and says how to fix it', () => {
    const err = caught(
      run([
        { kind: 'warmup' },
        { kind: 'interval' },
        { kind: 'repeat', count: 3, steps: [{ kind: 'interval', target: { type: 'hr_range', min: 160, max: 150 } }] },
      ]),
    );
    expect(err.path).toBe('steps[2].steps[0].target');
    expect(err.message).toBe('steps[2].steps[0].target: min (160 bpm) must be lower than max (150 bpm)');
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.hint).toMatch(/lower bound in min/);
  });

  it('rejects inverted pace and cadence ranges', () => {
    const pace = caught(run([{ kind: 'interval', target: { type: 'pace', min_per_km_fast: '5:00', min_per_km_slow: '4:30' } }]));
    expect(pace.message).toMatch(/^steps\[0\]\.target: .*must be faster/);
    expect(pace.hint).toMatch(/smaller time per km/);
    expect(caught(run([{ kind: 'interval', target: { type: 'cadence', min: 90, max: 90 } }])).message).toMatch(/lower than/);
  });

  it('reports schema violations with the path of the field, not of the whole step', () => {
    const badPace = caught(
      run([{ kind: 'repeat', count: 2, steps: [{ kind: 'interval', target: { type: 'pace', min_per_km_fast: '4.30', min_per_km_slow: '5:00' } }] }]),
    );
    expect(badPace.path).toBe('steps[0].steps[0].target.min_per_km_fast');
    expect(badPace.message).toMatch(/m:ss per km/);
    expect(badPace.hint).toMatch(/create_workout/);
    expect(caught(run([{ kind: 'repeat', count: 0, steps: [{ kind: 'warmup' }] }])).path).toBe('steps[0].count');
    expect(caught(run([{ kind: 'interval', target: { type: 'hr_zone', zone: 6 } }])).path).toBe('steps[0].target.zone');
    expect(caught(run([])).path).toBe('steps');
    expect(caught(() => compileWorkout({ name: 'x', sport: 'curling', steps: [{ kind: 'warmup' }] } as never)).path).toBe('sport');
  });
});

describe('garminWorkoutSchema', () => {
  const firstStep = (w: GarminWorkout) => w.workoutSegments[0]!.workoutSteps[0] as unknown as Record<string, unknown>;
  const withFirstStep = (patch: Record<string, unknown>): unknown => {
    const w = structuredClone(squatsJson);
    Object.assign(firstStep(w), patch);
    return w;
  };

  it('accepts what the compiler produces', () => {
    expect(garminWorkoutSchema.safeParse(hillsJson).success).toBe(true);
    expect(garminWorkoutSchema.safeParse(squatsJson).success).toBe(true);
  });

  it('rejects fields and values the compiler never sends', () => {
    expect(garminWorkoutSchema.safeParse({ ...squatsJson, workoutId: 1 }).success).toBe(false);
    expect(garminWorkoutSchema.safeParse(withFirstStep({ stepId: 1 })).success).toBe(false);
    expect(garminWorkoutSchema.safeParse(withFirstStep({ stepType: { stepTypeId: 3, stepTypeKey: 'warmup' } })).success).toBe(false);
    expect(garminWorkoutSchema.safeParse({ ...squatsJson, sportType: { sportTypeId: 1, sportTypeKey: 'swimming' } }).success).toBe(false);
  });

  it('rejects fields that must come in pairs', () => {
    expect(garminWorkoutSchema.safeParse(withFirstStep({ endConditionValue: undefined })).success).toBe(false);
    expect(garminWorkoutSchema.safeParse(withFirstStep({ weightUnit: undefined })).success).toBe(false);
    expect(garminWorkoutSchema.safeParse(withFirstStep({ targetType: HR_ZONE })).success).toBe(false);
    expect(garminWorkoutSchema.safeParse(withFirstStep({ targetType: HR_ZONE, targetValueOne: 120 })).success).toBe(false);
    const group = structuredClone(hillsJson);
    (group.workoutSegments[0]!.workoutSteps[1] as unknown as Record<string, unknown>).endConditionValue = 3;
    expect(garminWorkoutSchema.safeParse(group).success).toBe(false);
  });
});

describe('estimated duration of a compiled workout', () => {
  it('runs distance steps at the middle of the pace range and multiplies nested repeats', () => {
    // 200 m at 3:30-3:40 /km takes 43 s.
    expect(estimateWorkoutDuration(compileWorkout(hills))).toEqual({ seconds: 600 + 2 * (4 * (43 + 60) + 180), skipped: ['3'] });
  });

  it('takes the middle of the pace in time per km, not of the speeds', () => {
    // 4:00 and 6:00 per km: 1 km at 5:00, not at the average speed (4:48).
    const def: WorkoutDefinition = {
      name: 'Wide',
      sport: 'running',
      steps: [{ kind: 'interval', duration: { type: 'distance', meters: 1000 }, target: { type: 'pace', min_per_km_fast: '4:00', min_per_km_slow: '6:00' } }],
    };
    expect(estimateWorkoutDuration(compileWorkout(def))).toEqual({ seconds: 300, skipped: [] });
  });

  it('lists every step it cannot time, with labels as in the readable steps', () => {
    const def: WorkoutDefinition = {
      name: 'Mixed',
      sport: 'running',
      steps: [
        { kind: 'warmup', duration: { type: 'time', seconds: 300 } },
        {
          kind: 'repeat',
          count: 3,
          steps: [
            { kind: 'interval', duration: { type: 'distance', meters: 1000 }, target: { type: 'hr_zone', zone: 4 } },
            { kind: 'recovery', duration: { type: 'distance', meters: 200 } },
            { kind: 'rest', duration: { type: 'time', seconds: 60 } },
          ],
        },
        { kind: 'other', duration: { type: 'calories', kcal: 50 } },
        { kind: 'cooldown', duration: { type: 'lap_button' } },
      ],
    };
    const compiled = compileWorkout(def);
    expect(estimateWorkoutDuration(compiled)).toEqual({ seconds: 300 + 3 * 60, skipped: ['2.1', '2.2', '3', '4'] });
    expect(compiled.estimatedDurationInSecs).toBe(480);
  });

  it('leaves estimatedDurationInSecs out when no step can be timed', () => {
    const def: WorkoutDefinition = { name: 'Open', sport: 'running', steps: [{ kind: 'interval', duration: { type: 'distance', meters: 5000 } }] };
    const compiled = compileWorkout(def);
    expect(estimateWorkoutDuration(compiled)).toEqual({ seconds: 0, skipped: ['1'] });
    expect(compiled).not.toHaveProperty('estimatedDurationInSecs');
  });
});

describe('workout helpers', () => {
  it('converts pace strings to metres per second', () => {
    expect(paceToMetersPerSecond('5:00')).toBeCloseTo(3.3333333, 6);
    expect(paceToMetersPerSecond('4:30')).toBeCloseTo(3.7037037, 6);
  });

  it('exposes a JSON schema for the MCP tool, including recursion', () => {
    const schema = JSON.stringify(workoutDefinitionSchema.toJSONSchema());
    expect(schema).toContain('min_per_km_fast');
    expect(schema).toContain('repeat');
  });

  it('recognises Garmin JSON and rejects typed definitions', () => {
    expect(isGarminWorkoutJson(compileWorkout(hills))).toBe(true);
    expect(isGarminWorkoutJson(recorded('captured-poc-walk-run.json'))).toBe(true);
    expect(isGarminWorkoutJson(hills)).toBe(false);
    expect(isGarminWorkoutJson(null)).toBe(false);
    expect(isGarminWorkoutJson({ workoutName: 'x', sportType: {}, workoutSegments: [] })).toBe(false);
  });
});
