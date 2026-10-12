import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import * as s from './schemas.js';
import { fixture, fixtureNames } from './test-utils/fixtures.js';

/** Every schema must accept at least one recorded response. */
const contracts: Record<string, z.ZodType> = {
  'social-profile': s.socialProfileSchema,
  'user-settings': s.userSettingsSchema,
  'heart-rate-zones': s.heartRateZonesSchema,
  'power-zones': s.powerZonesSchema,
  activities: s.activityListSchema,
  activity: s.activitySchema,
  'activity-splits': s.activitySplitsSchema,
  'activity-hr-zones': s.activityHrZonesSchema,
  'activity-power-zones': s.activityPowerZonesSchema,
  'activity-weather': s.activityWeatherSchema,
  'activity-exercise-sets': s.activityExerciseSetsSchema,
  'activity-details': s.activityDetailsSchema,
  'activity-types': s.activityTypesSchema,
  'daily-summary': s.dailySummarySchema,
  'steps-chart': s.stepsChartSchema,
  'heart-rate-day': s.heartRateDaySchema,
  'stress-day': s.stressDaySchema,
  'body-battery': s.bodyBatteryReportSchema,
  'respiration-day': s.respirationDaySchema,
  'spo2-day': s.spo2DaySchema,
  'intensity-minutes-day': s.intensityMinutesDaySchema,
  sleep: s.sleepSchema,
  hrv: s.hrvSchema,
  'training-status': s.trainingStatusSchema,
  'training-readiness': s.trainingReadinessSchema,
  'max-metrics': s.maxMetricsSchema,
  'race-predictions': s.racePredictionsSchema,
  'fitness-age': s.fitnessAgeSchema,
  'personal-records': s.personalRecordsSchema,
  workouts: s.workoutListSchema,
  workout: s.workoutSchema,
  'calendar-month': s.calendarMonthSchema,
  'workout-schedule': s.workoutScheduleSchema,
  gear: s.gearListSchema,
  'gear-stats': s.gearStatsSchema,
  'weigh-ins': s.weighInsSchema,
  devices: s.deviceListSchema,
  'device-last-used': s.deviceLastUsedSchema,
  'device-settings': s.deviceSettingsSchema,
};

describe('schema contracts', () => {
  it('has a fixture for every schema and a schema for every fixture', () => {
    expect(fixtureNames().toSorted()).toEqual(Object.keys(contracts).toSorted());
  });

  it.each(Object.entries(contracts))('%s parses and keeps unknown fields', (name, schema) => {
    const raw = fixture(name);
    const parsed = schema.parse(raw);
    expect(parsed).toEqual(raw);
  });

  it('passes unknown fields through instead of failing', () => {
    const parsed = s.dailySummarySchema.parse({ calendarDate: '2026-10-07', brandNewMetric: { x: 1 } });
    expect(parsed).toMatchObject({ brandNewMetric: { x: 1 } });
  });
});
