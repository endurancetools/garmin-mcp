/**
 * Garmin Connect workout enums (ids from /workout-service/workout/types as used by
 * python-garminconnect and by workout JSON Garmin has accepted).
 */

export interface SportTypeRef {
  sportTypeId: number;
  sportTypeKey: string;
}

/**
 * Workout sport types. `walking` is 12 as in the captured walk workout JSON that
 * Garmin accepted; python-garminconnect uses 17 for walking and 18 for hiking, so the
 * hiking id is the least verified entry here.
 */
export const SPORT_TYPES = {
  running: { sportTypeId: 1, sportTypeKey: 'running' },
  cycling: { sportTypeId: 2, sportTypeKey: 'cycling' },
  other: { sportTypeId: 3, sportTypeKey: 'other' },
  swimming: { sportTypeId: 4, sportTypeKey: 'swimming' },
  strength_training: { sportTypeId: 5, sportTypeKey: 'strength_training' },
  cardio_training: { sportTypeId: 6, sportTypeKey: 'cardio_training' },
  yoga: { sportTypeId: 7, sportTypeKey: 'yoga' },
  pilates: { sportTypeId: 8, sportTypeKey: 'pilates' },
  hiit: { sportTypeId: 9, sportTypeKey: 'hiit' },
  multi_sport: { sportTypeId: 10, sportTypeKey: 'multi_sport' },
  mobility: { sportTypeId: 11, sportTypeKey: 'mobility' },
  walking: { sportTypeId: 12, sportTypeKey: 'walking' },
  hiking: { sportTypeId: 18, sportTypeKey: 'hiking' },
} as const satisfies Record<string, SportTypeRef>;

export type SportKey = keyof typeof SPORT_TYPES;
export const SPORT_KEYS = Object.keys(SPORT_TYPES) as [SportKey, ...SportKey[]];

export interface StepTypeRef {
  stepTypeId: number;
  stepTypeKey: string;
}

export const STEP_TYPES = {
  warmup: { stepTypeId: 1, stepTypeKey: 'warmup' },
  cooldown: { stepTypeId: 2, stepTypeKey: 'cooldown' },
  interval: { stepTypeId: 3, stepTypeKey: 'interval' },
  recovery: { stepTypeId: 4, stepTypeKey: 'recovery' },
  rest: { stepTypeId: 5, stepTypeKey: 'rest' },
  repeat: { stepTypeId: 6, stepTypeKey: 'repeat' },
  other: { stepTypeId: 7, stepTypeKey: 'other' },
  main: { stepTypeId: 8, stepTypeKey: 'main' },
} as const satisfies Record<string, StepTypeRef>;

export type StepTypeKey = keyof typeof STEP_TYPES;

export interface EndConditionRef {
  conditionTypeId: number;
  conditionTypeKey: string;
}

export const END_CONDITIONS = {
  lap_button: { conditionTypeId: 1, conditionTypeKey: 'lap.button' },
  time: { conditionTypeId: 2, conditionTypeKey: 'time' },
  distance: { conditionTypeId: 3, conditionTypeKey: 'distance' },
  calories: { conditionTypeId: 4, conditionTypeKey: 'calories' },
  power: { conditionTypeId: 5, conditionTypeKey: 'power' },
  heart_rate: { conditionTypeId: 6, conditionTypeKey: 'heart.rate' },
  iterations: { conditionTypeId: 7, conditionTypeKey: 'iterations' },
  fixed_rest: { conditionTypeId: 8, conditionTypeKey: 'fixed.rest' },
  fixed_repetition: { conditionTypeId: 9, conditionTypeKey: 'fixed.repetition' },
  reps: { conditionTypeId: 10, conditionTypeKey: 'reps' },
  training_peaks_tss: { conditionTypeId: 11, conditionTypeKey: 'training.peaks.tss' },
} as const satisfies Record<string, EndConditionRef>;

export interface TargetTypeRef {
  workoutTargetTypeId: number;
  workoutTargetTypeKey: string;
}

/**
 * Target types. Id 6 is sport dependent: `pace.zone` for running/swimming and
 * `power.between` (absolute watts) for cycling. `power.zone` (2) takes a zoneNumber.
 */
export const TARGET_TYPES = {
  no_target: { workoutTargetTypeId: 1, workoutTargetTypeKey: 'no.target' },
  power_zone: { workoutTargetTypeId: 2, workoutTargetTypeKey: 'power.zone' },
  cadence: { workoutTargetTypeId: 3, workoutTargetTypeKey: 'cadence' },
  heart_rate_zone: { workoutTargetTypeId: 4, workoutTargetTypeKey: 'heart.rate.zone' },
  speed_zone: { workoutTargetTypeId: 5, workoutTargetTypeKey: 'speed.zone' },
  pace_zone: { workoutTargetTypeId: 6, workoutTargetTypeKey: 'pace.zone' },
  power_between: { workoutTargetTypeId: 6, workoutTargetTypeKey: 'power.between' },
  grade: { workoutTargetTypeId: 7, workoutTargetTypeKey: 'grade' },
  heart_rate_lap: { workoutTargetTypeId: 8, workoutTargetTypeKey: 'heart.rate.lap' },
  power_lap: { workoutTargetTypeId: 9, workoutTargetTypeKey: 'power.lap' },
  resistance: { workoutTargetTypeId: 15, workoutTargetTypeKey: 'resistance' },
} as const satisfies Record<string, TargetTypeRef>;

/** Garmin stores strength `weightValue` in grams tagged with this kilogram unit. */
export const WEIGHT_UNIT_KILOGRAM = { unitId: 8, unitKey: 'kilogram', factor: 1000 } as const;

/** Shapes of the Garmin workout JSON we emit. Unknown fields from Garmin are tolerated elsewhere. */
export interface GarminExecutableStep {
  type: 'ExecutableStepDTO';
  stepOrder: number;
  stepType: StepTypeRef;
  description?: string;
  endCondition: EndConditionRef;
  endConditionValue?: number;
  targetType: TargetTypeRef;
  zoneNumber?: number;
  targetValueOne?: number;
  targetValueTwo?: number;
  category?: string;
  exerciseName?: string;
  weightValue?: number;
  weightUnit?: typeof WEIGHT_UNIT_KILOGRAM;
  childStepId?: number;
}

export interface GarminRepeatGroup {
  type: 'RepeatGroupDTO';
  stepOrder: number;
  stepType?: StepTypeRef;
  numberOfIterations: number;
  smartRepeat?: boolean;
  endCondition?: EndConditionRef;
  endConditionValue?: number;
  childStepId?: number;
  workoutSteps: GarminStep[];
}

export type GarminStep = GarminExecutableStep | GarminRepeatGroup;

export interface GarminWorkoutSegment {
  segmentOrder: number;
  sportType: SportTypeRef;
  workoutSteps: GarminStep[];
}

export interface GarminWorkout {
  workoutName: string;
  description?: string;
  sportType: SportTypeRef;
  estimatedDurationInSecs?: number;
  workoutSegments: GarminWorkoutSegment[];
}
