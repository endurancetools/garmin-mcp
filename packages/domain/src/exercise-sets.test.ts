import { describe, expect, it } from 'vitest';
import { EXERCISE_CATALOG } from './exercise-catalog.js';
import { checkWorkoutExercises, exerciseSetsInput, rawExerciseSets } from './exercise-sets.js';
import { fixture } from './test-utils/fake.js';

describe('exercise sets', () => {
  it('reads recorded sets in the shape update_activity takes', () => {
    // Recorded: no exercise name, no weight, only the likeliest of three categories counts.
    expect(exerciseSetsInput(fixture('activity-exercise-sets'))).toEqual([{ exercise: { category: 'LATERAL_RAISE' }, reps: 8, duration_s: 1970.3 }]);
    expect(exerciseSetsInput(null)).toEqual([]);
    expect(rawExerciseSets({ exerciseSets: null })).toEqual([]);
  });

  it('knows the categories Garmin wrote in the recording', () => {
    const categories = rawExerciseSets(fixture('activity-exercise-sets')).flatMap((s) => (s.exercises as { category: string }[]).map((e) => e.category));
    expect(categories).toEqual(['LATERAL_RAISE', 'LUNGE', 'CURL']);
    for (const c of categories) expect(EXERCISE_CATALOG[c]?.length).toBeGreaterThan(0);
    expect(EXERCISE_CATALOG.SQUAT).toContain('BARBELL_BACK_SQUAT');
  });
});

describe('checkWorkoutExercises', () => {
  const strength = (exercise: { category: string; name?: string }) => ({
    definition: {
      steps: [{ kind: 'repeat', steps: [{ kind: 'interval', exercise }, { kind: 'rest' }] }],
    },
  });
  const failure = async (input: Parameters<typeof checkWorkoutExercises>[0]) => {
    try {
      await checkWorkoutExercises(input);
    } catch (e) {
      return e as { message: string; hint?: string };
    }
    throw new Error('expected an InputError');
  };

  it('accepts catalogue keys in any case and a workout without exercises', async () => {
    await expect(checkWorkoutExercises(strength({ category: 'hip_raise', name: 'kettlebell swing' }))).resolves.toBeUndefined();
    await expect(checkWorkoutExercises({ definition: { steps: [{ kind: 'interval' }] } })).resolves.toBeUndefined();
    await expect(checkWorkoutExercises({})).resolves.toBeUndefined();
  });

  it('names the step path of an unknown category, with the categories as the hint', async () => {
    const e = await failure(strength({ category: 'KETTLEBELL', name: 'KETTLEBELL_SWING' }));
    expect(e.message).toBe('definition.steps[0].steps[0].exercise.category: unknown exercise category "KETTLEBELL"');
    expect(e.hint).toContain('HIP_RAISE');
  });

  it('an exercise in the wrong category lists the similar names of that category', async () => {
    const e = await failure({ ...strength({ category: 'HIP_RAISE', name: 'HIP_SWING' }), definitionLabel: 'preset' });
    expect(e.message).toBe('preset.steps[0].steps[0].exercise.name: unknown exercise "HIP_SWING" in category HIP_RAISE');
    expect(e.hint).toMatch(/^Exercises of HIP_RAISE with a similar name: /);
  });

  it('checks garmin_json steps by category and exerciseName', async () => {
    const garminJson = {
      workoutSegments: [{ workoutSteps: [{ type: 'RepeatGroupDTO', workoutSteps: [{ category: 'SQUAT', exerciseName: 'NOT_A_SQUAT' }] }] }],
    };
    const e = await failure({ garminJson });
    expect(e.message).toBe('garmin_json.workoutSegments[0].workoutSteps[0].workoutSteps[0].name: unknown exercise "NOT_A_SQUAT" in category SQUAT');
  });
});
