import { describe, expect, it } from 'vitest';
import { EXERCISE_CATALOG } from './exercise-catalog.js';
import { exerciseSetsInput, rawExerciseSets } from './exercise-sets.js';
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
