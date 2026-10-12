import { describe, expect, it } from 'vitest';
import { compileWorkout } from './compile.js';
import { WorkoutDefinitionError, type Target, type WorkoutDefinition, type WorkoutStep } from './definition.js';
import { describeWorkout } from './describe.js';
import type { GarminStep, GarminWorkout } from './garmin-constants.js';
import { presetDefinition, WORKOUT_PRESET_NAMES, workoutPresetSchema, type WorkoutPreset } from './presets.js';

const z4 = { type: 'hr_zone', zone: 4 } as const;
const pace = (fast: string, slow: string) => ({ type: 'pace', min_per_km_fast: fast, min_per_km_slow: slow }) as const;

/** Every preset with defaults only and with most parameters set. */
const PRESETS: WorkoutPreset[] = [
  { name: 'run_intervals', params: { repeats: 6, work_meters: 400 } },
  {
    name: 'run_intervals',
    params: {
      workout_name: 'Threshold',
      repeats: 4,
      work_seconds: 480,
      work_target: pace('4:10', '4:20'),
      recovery_seconds: 120,
      recovery_target: { type: 'hr_range', min: 120, max: 145 },
      warmup_min: 15,
      cooldown_min: 0,
    },
  },
  { name: 'run_intervals', params: { repeats: 1, work_meters: 3000, work_target: z4, recovery_seconds: 0 } },
  { name: 'run_intervals', params: { repeats: 5, work_meters: 1000, work_target: pace('3:50', '4:10'), recovery_seconds: 120 } },
  { name: 'walk_run', params: { repeats: 8, run_seconds: 60, walk_seconds: 90 } },
  { name: 'walk_run', params: { repeats: 5, run_seconds: 120, walk_seconds: 60, run_target: { type: 'hr_zone', zone: 3 }, warmup_min: 0 } },
  { name: 'easy_z2', params: { duration_min: 45 } },
  { name: 'easy_z2', params: { sport: 'cycling', duration_min: 90, target: { type: 'power_range', min: 150, max: 190 }, warmup_min: 10, cooldown_min: 5 } },
  { name: 'easy_z2', params: { sport: 'walking', duration_min: 30, target: { type: 'hr_range', min: 100, max: 120 } } },
  {
    name: 'strength_circuit',
    params: {
      exercises: [
        { exercise: { category: 'SQUAT', name: 'GOBLET_SQUAT' }, reps: 12, weight_kg: 16 },
        { exercise: { category: 'PUSH_UP' }, reps: 15 },
        { exercise: { category: 'PLANK' }, seconds: 45, notes: 'Hips level' },
        { exercise: { category: 'LUNGE', name: 'DUMBBELL_LUNGE' } },
      ],
      rest_between_exercises_s: 20,
    },
  },
  { name: 'strength_circuit', params: { rounds: 1, exercises: [{ exercise: { category: 'deadlift' }, reps: 5, weight_kg: 120 }] } },
];

/**
 * Estimated duration of each preset above, worked out by hand: time steps, distance steps at
 * the middle of their pace range, repeats multiplied, everything else left out.
 */
const ESTIMATED_SECONDS = [
  600 + 6 * 90 + 600, // 400 m without a pace target cannot be timed
  15 * 60 + 4 * (480 + 120),
  600 + 600, // 3 km at HR zone 4 cannot be timed
  600 + 5 * (240 + 120) + 600, // 1 km at 3:50-4:10 takes 4:00
  300 + 8 * (60 + 90) + 300,
  5 * (120 + 60) + 300,
  45 * 60,
  10 * 60 + 90 * 60 + 5 * 60,
  30 * 60,
  3 * (20 + 20 + 45 + 20 + 90), // rests and the plank; reps and the open lunge cannot be timed
  undefined, // reps only
];

// ------------------------------------------------------------------ invariants of the Garmin tree

function walk(steps: GarminStep[], visit: (step: GarminStep, parent: GarminStep | undefined) => void, parent?: GarminStep) {
  for (const step of steps) {
    visit(step, parent);
    if (step.type === 'RepeatGroupDTO') walk(step.workoutSteps, visit, step);
  }
}

function checkInvariants(w: GarminWorkout) {
  const orders: number[] = [];
  const groups: { iterations: number; endValue: number | undefined; id: number | undefined; children: number }[] = [];
  /** childStepId of each executable step next to the childStepId of the group holding it (undefined at the top). */
  const links: { own: number | undefined; parent: number | undefined }[] = [];
  walk(w.workoutSegments[0]!.workoutSteps, (step, parent) => {
    orders.push(step.stepOrder);
    if (step.type === 'RepeatGroupDTO') {
      groups.push({ iterations: step.numberOfIterations, endValue: step.endConditionValue, id: step.childStepId, children: step.workoutSteps.length });
    } else {
      links.push({ own: step.childStepId, parent: parent?.childStepId });
    }
  });
  // Depth-first numbering: 1..n in the order the tree is walked, so also unique.
  expect(orders).toEqual(orders.map((_, i) => i + 1));
  for (const g of groups) {
    expect(g.endValue).toBe(g.iterations);
    expect(g.id).toBeGreaterThan(0);
    expect(g.children).toBeGreaterThan(0);
  }
  expect(new Set(groups.map((g) => g.id)).size).toBe(groups.length);
  for (const link of links) expect(link.own).toBe(link.parent);
  expect(w.workoutSegments).toHaveLength(1);
  expect(w.workoutSegments[0]!.sportType).toEqual(w.sportType);
  return { groups: groups.length, steps: orders.length };
}

// ------------------------------------------------------------------ expected readable form, from the definition alone

const mmss = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
};
const words = (key: string) => {
  const text = key.replace(/[\s_-]+/g, ' ').trim().toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
};
const paceSeconds = (p: string) => {
  const [m, s] = p.split(':').map(Number) as [number, number];
  return m * 60 + s;
};

function targetText(t: Target | undefined): string | undefined {
  switch (t?.type) {
    case undefined:
    case 'none':
      return undefined;
    case 'hr_zone':
      return `HR Z${t.zone}`;
    case 'hr_range':
      return `HR ${t.min}-${t.max} bpm`;
    case 'pace':
      return `pace ${mmss(paceSeconds(t.min_per_km_fast))}-${mmss(paceSeconds(t.min_per_km_slow))} /km`;
    case 'power_zone':
      return `power Z${t.zone}`;
    case 'power_range':
      return `power ${t.min}-${t.max} W`;
    case 'cadence':
      return `cadence ${t.min}-${t.max} rpm`;
  }
}

function expectedLines(steps: WorkoutStep[], prefix = '', indent = ''): string[] {
  return steps.flatMap((step, i) => {
    const label = prefix ? `${prefix}.${i + 1}` : String(i + 1);
    if (step.kind === 'repeat') return [`${indent}${label}. Repeat ${step.count}x:`, ...expectedLines(step.steps, label, `${indent}  `)];
    const parts = [words(step.kind)];
    if (step.exercise) parts.push(words(step.exercise.name ?? step.exercise.category) + (step.weight_kg ? ` ${step.weight_kg} kg` : ''));
    const d = step.duration;
    if (!d || d.type === 'lap_button') parts.push('until lap button');
    else if (d.type === 'time') parts.push(mmss(d.seconds));
    else if (d.type === 'distance') parts.push(d.meters < 1000 ? `${d.meters} m` : `${d.meters / 1000} km`);
    else if (d.type === 'reps') parts.push(`${d.count} reps`);
    else parts.push(`${d.kcal} kcal`);
    const target = targetText(step.target);
    return [`${indent}${label}. ${parts.join(' ')}${target ? ` @ ${target}` : ''}${step.notes ? ` - ${step.notes}` : ''}`];
  });
}

// ------------------------------------------------------------------ tests

describe('workout presets', () => {
  it('covers every preset in the test cases', () => {
    expect(new Set(PRESETS.map((p) => p.name))).toEqual(new Set(WORKOUT_PRESET_NAMES));
    expect(WORKOUT_PRESET_NAMES).toEqual(['run_intervals', 'walk_run', 'easy_z2', 'strength_circuit']);
  });

  it.each(PRESETS.map((p, i) => [`${i}: ${p.name}`, p] as const))('%s compiles to a well-formed Garmin tree', (_, preset) => {
    const w = compileWorkout(presetDefinition(preset));
    const { steps } = checkInvariants(w);
    expect(steps).toBeGreaterThan(0);
  });

  it.each(PRESETS.map((p, i) => [`${i}: ${p.name}`, p, ESTIMATED_SECONDS[i]] as const))('%s reads back as its definition', (_, preset, seconds) => {
    const def = presetDefinition(preset);
    const readable = describeWorkout(compileWorkout(def));
    expect(readable.name).toBe(def.name);
    expect(readable.sport).toBe(def.sport);
    expect(readable.step_count).toBe(def.steps.length);
    expect(readable.steps).toEqual(expectedLines(def.steps));
    expect(readable.estimated_duration_s).toBe(seconds);
  });

  it('reads back a definition with every target and duration type', () => {
    const def: WorkoutDefinition = {
      name: 'Everything',
      sport: 'cycling',
      steps: [
        { kind: 'warmup', duration: { type: 'time', seconds: 3725 }, target: { type: 'cadence', min: 85, max: 95 } },
        {
          kind: 'repeat',
          count: 3,
          steps: [
            { kind: 'interval', duration: { type: 'distance', meters: 2500 }, target: { type: 'power_zone', zone: 5 } },
            {
              kind: 'repeat',
              count: 2,
              steps: [
                { kind: 'interval', duration: { type: 'time', seconds: 30 }, target: { type: 'power_range', min: 400, max: 450 } },
                { kind: 'recovery', duration: { type: 'calories', kcal: 20 }, target: { type: 'hr_zone', zone: 1 } },
              ],
            },
          ],
        },
        { kind: 'other', duration: { type: 'distance', meters: 800 }, target: { type: 'none' }, notes: 'Spin' },
        { kind: 'cooldown', duration: { type: 'lap_button' } },
      ],
    };
    const compiled = compileWorkout(def);
    expect(checkInvariants(compiled)).toEqual({ groups: 2, steps: 8 });
    expect(describeWorkout(compiled).steps).toEqual(expectedLines(def.steps));
    const run = { name: 'Pace', sport: 'running', steps: [{ kind: 'interval', duration: { type: 'distance', meters: 1000 }, target: pace('3:58', '4:07') }] } satisfies WorkoutDefinition;
    expect(describeWorkout(compileWorkout(run)).steps).toEqual(['1. Interval 1 km @ pace 3:58-4:07 /km']);
  });

  it('builds the steps a preset promises', () => {
    expect(presetDefinition({ name: 'run_intervals', params: { repeats: 6, work_meters: 400 } })).toEqual({
      name: '6x400 m',
      sport: 'running',
      steps: [
        { kind: 'warmup', duration: { type: 'time', seconds: 600 } },
        {
          kind: 'repeat',
          count: 6,
          steps: [
            { kind: 'interval', duration: { type: 'distance', meters: 400 } },
            { kind: 'recovery', duration: { type: 'time', seconds: 90 } },
          ],
        },
        { kind: 'cooldown', duration: { type: 'time', seconds: 600 } },
      ],
    });
    expect(presetDefinition({ name: 'easy_z2', params: { duration_min: 45 } })).toEqual({
      name: 'Easy running 45 min',
      sport: 'running',
      steps: [{ kind: 'interval', duration: { type: 'time', seconds: 2700 }, target: { type: 'hr_zone', zone: 2 }, notes: 'Easy, conversational' }],
    });
    const walkRun = presetDefinition({ name: 'walk_run', params: { repeats: 8, run_seconds: 60, walk_seconds: 90 } });
    expect(walkRun.name).toBe('Walk/run 8x 1 min run / 1:30 walk');
    expect(walkRun.steps.map((s) => s.kind)).toEqual(['warmup', 'repeat', 'cooldown']);
    const circuit = presetDefinition(PRESETS.at(-2)!);
    expect(circuit.name).toBe('Strength circuit 3x4');
    expect(circuit.sport).toBe('strength_training');
    const round = (circuit.steps[0] as Extract<WorkoutStep, { kind: 'repeat' }>).steps;
    // Rest after every exercise but the last, then the rest between rounds.
    expect(round.map((s) => s.kind)).toEqual(['interval', 'rest', 'interval', 'rest', 'interval', 'rest', 'interval', 'rest']);
    expect(round.at(-1)).toEqual({ kind: 'rest', duration: { type: 'time', seconds: 90 } });
    // One round needs neither a repeat nor a rest between rounds.
    expect(presetDefinition(PRESETS.at(-1)!).steps).toEqual([
      { kind: 'interval', duration: { type: 'reps', count: 5 }, exercise: { category: 'deadlift' }, weight_kg: 120 },
    ]);
  });

  it('rejects bad parameters with the path of the parameter and a hint', () => {
    const fail = (preset: unknown) => {
      try {
        presetDefinition(preset as WorkoutPreset);
      } catch (err) {
        if (err instanceof WorkoutDefinitionError) return err;
        throw err;
      }
      throw new Error('expected a WorkoutDefinitionError');
    };
    const both = fail({ name: 'run_intervals', params: { repeats: 4, work_seconds: 60, work_meters: 400 } });
    expect(both.path).toBe('preset.params.work_seconds');
    expect(both.message).toMatch(/exactly one of work_seconds or work_meters/);
    expect(both.hint).toMatch(/preset parameter/);
    expect(fail({ name: 'run_intervals', params: { repeats: 4 } }).path).toBe('preset.params.work_seconds');
    expect(fail({ name: 'easy_z2', params: { duration_min: 30, sport: 'rowing' } }).path).toBe('preset.params.sport');
    expect(fail({ name: 'strength_circuit', params: { exercises: [{ exercise: { category: 'PLANK' }, reps: 1, seconds: 30 }] } }).path).toBe(
      'preset.params.exercises[0].reps',
    );
    expect(fail({ name: 'tempo', params: {} }).path).toBe('preset.name');
  });

  it('reports inverted ranges in preset targets from the compiler', () => {
    const def = presetDefinition({ name: 'run_intervals', params: { repeats: 3, work_seconds: 60, work_target: pace('4:30', '4:00') } });
    expect(() => compileWorkout(def)).toThrow(/^steps\[1\]\.steps\[0\]\.target: min_per_km_fast/);
  });

  it('publishes a JSON schema with the preset names and parameters', () => {
    const schema = JSON.stringify(workoutPresetSchema.toJSONSchema());
    for (const name of WORKOUT_PRESET_NAMES) expect(schema).toContain(name);
    expect(schema).toContain('work_meters');
    expect(schema).toContain('rest_between_rounds_s');
  });
});
