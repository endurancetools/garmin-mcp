import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileWorkout } from './compile.js';
import { describeWorkout, estimateWorkoutDuration, formatDuration } from './describe.js';
import { presetDefinition } from './presets.js';

const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures/workouts');
const fixture = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

describe('describeWorkout', () => {
  it('summarises a realistic Garmin GET response', () => {
    expect(describeWorkout(fixture('sample-garmin-get-workout.json'))).toStrictEqual({
      id: 1234567890,
      name: 'Tempo 3x8min',
      sport: 'running',
      description: 'Threshold session',
      estimated_duration_s: 3420,
      estimated_distance_m: 10500,
      step_count: 3,
      steps: [
        '1. Warmup 15:00 @ HR Z2',
        '2. Repeat 3x:',
        '  2.1. Interval 8:00 @ pace 4:40-4:50 /km - Comfortably hard',
        '  2.2. Recovery 400 m',
        '3. Cooldown until lap button @ HR 120-140 bpm',
      ],
    });
  });

  it('describes HR ranges, notes and time-based repeats', () => {
    const readable = describeWorkout(
      compileWorkout({
        name: 'HR intervals',
        sport: 'running',
        steps: [
          { kind: 'warmup', duration: { type: 'time', seconds: 900 }, notes: 'Easy' },
          {
            kind: 'repeat',
            count: 5,
            steps: [
              { kind: 'interval', duration: { type: 'time', seconds: 300 }, target: { type: 'hr_range', min: 172, max: 180 } },
              { kind: 'recovery', duration: { type: 'time', seconds: 120 }, target: { type: 'hr_range', min: 120, max: 150 }, notes: 'Jog' },
            ],
          },
          { kind: 'cooldown', duration: { type: 'time', seconds: 600 } },
        ],
      }),
    );
    expect(readable.steps).toEqual([
      '1. Warmup 15:00 - Easy',
      '2. Repeat 5x:',
      '  2.1. Interval 5:00 @ HR 172-180 bpm',
      '  2.2. Recovery 2:00 @ HR 120-150 bpm - Jog',
      '3. Cooldown 10:00',
    ]);
    expect(readable.estimated_duration_s).toBe(15 * 60 + 5 * 420 + 10 * 60);
  });

  it('describes a recorded walk/run workout whose group has no stepType', () => {
    const readable = describeWorkout(fixture('captured-poc-walk-run.json'));
    expect(readable.steps).toEqual([
      '1. Warmup 10:00 - Warmup 10 min',
      '2. Repeat 7x:',
      '  2.1. Interval 1:00 @ HR Z3 - Run 60s Z3',
      '  2.2. Recovery 3:00 @ HR Z3 - Walk 180s Z3',
      '3. Cooldown 8:00 - Cooldown 8 min',
    ]);
    expect(readable.estimated_duration_s).toBe(600 + 7 * 240 + 480);
  });

  it('describes strength exercises, reps and weights', () => {
    const circuit = describeWorkout(
      compileWorkout(
        presetDefinition({
          name: 'strength_circuit',
          params: { rounds: 3, exercises: [{ exercise: { category: 'SQUAT' }, reps: 8 }], rest_between_rounds_s: 90 },
        }),
      ),
    );
    expect(circuit.steps).toEqual(['1. Repeat 3x:', '  1.1. Interval Squat 8 reps', '  1.2. Rest 1:30']);
    const compiled = describeWorkout(
      compileWorkout({
        name: 'Bench',
        sport: 'strength_training',
        steps: [
          {
            kind: 'interval',
            duration: { type: 'reps', count: 5 },
            exercise: { category: 'BENCH_PRESS', name: 'BARBELL_BENCH_PRESS' },
            weight_kg: 80,
          },
        ],
      }),
    );
    expect(compiled.steps).toEqual(['1. Interval Barbell bench press 80 kg 5 reps']);
  });

  it('formats power, cadence and swim pace targets', () => {
    const readable = describeWorkout({
      workoutName: 'Mixed',
      sportType: { sportTypeKey: 'swimming' },
      workoutSegments: [
        {
          workoutSteps: [
            {
              type: 'ExecutableStepDTO',
              stepType: { stepTypeKey: 'interval' },
              endCondition: { conditionTypeKey: 'distance' },
              endConditionValue: 100,
              targetType: { workoutTargetTypeKey: 'pace.zone' },
              targetValueOne: 1,
              targetValueTwo: 1.25,
            },
            {
              type: 'ExecutableStepDTO',
              stepType: { stepTypeKey: 'interval' },
              endCondition: { conditionTypeKey: 'time' },
              endConditionValue: 3725,
              targetType: { workoutTargetTypeKey: 'power.between' },
              targetValueOne: 200,
              targetValueTwo: 250,
              secondaryTargetType: { workoutTargetTypeKey: 'cadence' },
              secondaryTargetValueOne: 85,
              secondaryTargetValueTwo: 95,
            },
          ],
        },
      ],
    });
    expect(readable.steps).toEqual([
      '1. Interval 100 m @ pace 1:20-1:40 /100 m',
      '2. Interval 1:02:05 @ power 200-250 W, cadence 85-95 rpm',
    ]);
  });

  it('tolerates malformed and unknown fields', () => {
    const readable = describeWorkout({
      workoutName: 'Odd',
      unknownField: { deep: true },
      workoutSegments: [
        {
          workoutSteps: [
            { type: 'ExecutableStepDTO', stepType: 'not-an-object', endConditionValue: 'abc', zoneNumber: 'x' },
            { type: 'RepeatGroupDTO', numberOfIterations: 2, workoutSteps: 'nope' },
          ],
        },
      ],
    });
    expect(readable).toStrictEqual({ name: 'Odd', step_count: 2, steps: ['1. Step', '2. Repeat 2x:'] });
    expect(() => describeWorkout('nope')).toThrow(TypeError);
  });

  it('labels multi-segment workouts', () => {
    const workout = compileWorkout(
      presetDefinition({ name: 'run_intervals', params: { repeats: 1, work_seconds: 60, recovery_seconds: 0, warmup_min: 1, cooldown_min: 1 } }),
    );
    const twoSegments = { ...workout, workoutSegments: [workout.workoutSegments[0], workout.workoutSegments[0]] };
    const steps = describeWorkout(twoSegments).steps;
    expect(steps[0]).toBe('Segment 1 (running):');
    expect(steps).toContain('Segment 2 (running):');
    expect(steps).toContain('  4. Warmup 1:00');
  });

  it('estimates raw Garmin JSON and leaves out steps it cannot time', () => {
    const run = { workoutTargetTypeKey: 'pace.zone' };
    const distance = { conditionTypeKey: 'distance' };
    const json = {
      workoutName: 'Copied',
      workoutSegments: [
        {
          workoutSteps: [
            { type: 'ExecutableStepDTO', endCondition: { conditionTypeKey: 'time' }, endConditionValue: 600 },
            {
              type: 'RepeatGroupDTO',
              numberOfIterations: 3,
              workoutSteps: [
                // 1 km at 4:00-6:00 /km (4.1667 and 2.7778 m/s, slow first) takes 5:00.
                { type: 'ExecutableStepDTO', endCondition: distance, endConditionValue: 1000, targetType: run, targetValueOne: 1000 / 360, targetValueTwo: 1000 / 240 },
                { type: 'ExecutableStepDTO', endCondition: distance, endConditionValue: 200, targetType: run, targetValueOne: 0, targetValueTwo: 1000 / 240 },
              ],
            },
          ],
        },
        {
          workoutSteps: [
            { type: 'ExecutableStepDTO', endCondition: distance, endConditionValue: 400, targetType: run, zoneNumber: 3 },
            { type: 'ExecutableStepDTO', endCondition: { conditionTypeKey: 'lap.button' } },
          ],
        },
      ],
    };
    expect(estimateWorkoutDuration(json)).toEqual({ seconds: 600 + 3 * 300, skipped: ['2.2', '3', '4'] });
    expect(describeWorkout(json).estimated_duration_s).toBe(1500);
    expect(describeWorkout({ ...json, estimatedDurationInSecs: 1800 }).estimated_duration_s).toBe(1800);
    expect(() => estimateWorkoutDuration('nope')).toThrow(TypeError);
  });

  it('formats durations', () => {
    expect(formatDuration(59)).toBe('0:59');
    expect(formatDuration(600)).toBe('10:00');
    expect(formatDuration(3725)).toBe('1:02:05');
  });
});
