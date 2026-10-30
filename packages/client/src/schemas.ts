/**
 * Response schemas for connectapi. Objects are loose: unknown fields pass through,
 * so Garmin adding fields never breaks us. Known fields are typed and,
 * since Garmin returns null liberally, nullish unless the store depends on them.
 */
import { z } from 'zod';

const num = z.number().nullish();
const int = z.number().int().nullish();
const str = z.string().nullish();
const bool = z.boolean().nullish();
/** Garmin ids are 64-bit integers; they fit in a double up to 2^53, which holds for activity ids today. */
const id = z.number().int();

const typeRef = z.looseObject({ typeId: int, typeKey: str, parentTypeId: int });

// ---------------------------------------------------------------- profile

export const socialProfileSchema = z.looseObject({
  id: int,
  profileId: int,
  garminGUID: str,
  displayName: str,
  fullName: str,
  userName: str,
  location: str,
});
export type SocialProfile = z.infer<typeof socialProfileSchema>;

export const userSettingsSchema = z.looseObject({
  id: int,
  userData: z
    .looseObject({
      gender: str,
      weight: num,
      height: num,
      birthDate: str,
      measurementSystem: str,
      timeFormat: str,
      lactateThresholdHeartRate: num,
      lactateThresholdSpeed: num,
      vo2MaxRunning: num,
      vo2MaxCycling: num,
      thresholdHeartRateAutoDetected: bool,
    })
    .nullish(),
});
export type UserSettings = z.infer<typeof userSettingsSchema>;

export const heartRateZonesSchema = z.array(
  z.looseObject({
    trainingMethod: str,
    restingHeartRateUsed: num,
    lactateThresholdHeartRateUsed: num,
    zone1Floor: num,
    zone2Floor: num,
    zone3Floor: num,
    zone4Floor: num,
    zone5Floor: num,
    maxHeartRateUsed: num,
    sport: str,
  }),
);
export type HeartRateZones = z.infer<typeof heartRateZonesSchema>;

export const powerZonesSchema = z.array(
  z.looseObject({
    sport: str,
    functionalThresholdPower: num,
    zone1Floor: num,
    zone2Floor: num,
    zone3Floor: num,
    zone4Floor: num,
    zone5Floor: num,
    zone6Floor: num,
    zone7Floor: num,
  }),
);
export type PowerZones = z.infer<typeof powerZonesSchema>;

// ---------------------------------------------------------------- activities

export const activitySummarySchema = z.looseObject({
  activityId: id,
  activityName: str,
  description: str,
  startTimeLocal: str,
  startTimeGMT: str,
  activityType: typeRef.nullish(),
  eventType: typeRef.nullish(),
  distance: num,
  duration: num,
  movingDuration: num,
  elapsedDuration: num,
  elevationGain: num,
  elevationLoss: num,
  averageSpeed: num,
  maxSpeed: num,
  averageHR: num,
  maxHR: num,
  calories: num,
  avgPower: num,
  maxPower: num,
  normPower: num,
  aerobicTrainingEffect: num,
  anaerobicTrainingEffect: num,
  activityTrainingLoad: num,
  vO2MaxValue: num,
  steps: num,
  lapCount: num,
  locationName: str,
  deviceId: num,
  hrTimeInZone_1: num,
  hrTimeInZone_2: num,
  hrTimeInZone_3: num,
  hrTimeInZone_4: num,
  hrTimeInZone_5: num,
});
export type ActivitySummary = z.infer<typeof activitySummarySchema>;
export const activityListSchema = z.array(activitySummarySchema);

export const activitySchema = z.looseObject({
  activityId: id,
  activityName: str,
  description: str,
  activityTypeDTO: typeRef.nullish(),
  eventTypeDTO: typeRef.nullish(),
  locationName: str,
  summaryDTO: z
    .looseObject({
      startTimeLocal: str,
      startTimeGMT: str,
      distance: num,
      duration: num,
      movingDuration: num,
      elapsedDuration: num,
      elevationGain: num,
      elevationLoss: num,
      averageSpeed: num,
      averageHR: num,
      maxHR: num,
      calories: num,
      averagePower: num,
      maxPower: num,
      normalizedPower: num,
      trainingEffect: num,
      anaerobicTrainingEffect: num,
      activityTrainingLoad: num,
      directWorkoutRpe: num,
      directWorkoutFeel: num,
      directWorkoutComplianceScore: num,
    })
    .nullish(),
  metadataDTO: z.looseObject({ deviceMetaDataDTO: z.looseObject({ deviceId: z.unknown() }).nullish(), associatedWorkoutId: int }).nullish(),
});
export type Activity = z.infer<typeof activitySchema>;

export const activitySplitsSchema = z.looseObject({
  activityId: int,
  lapDTOs: z
    .array(
      z.looseObject({
        lapIndex: int,
        startTimeGMT: str,
        distance: num,
        duration: num,
        movingDuration: num,
        averageSpeed: num,
        averageHR: num,
        maxHR: num,
        averagePower: num,
        normalizedPower: num,
        elevationGain: num,
        elevationLoss: num,
        averageRunCadence: num,
        intensityType: str,
        wktStepIndex: int,
        directWorkoutComplianceScore: num,
      }),
    )
    .nullish(),
});
export type ActivitySplits = z.infer<typeof activitySplitsSchema>;

export const activityHrZonesSchema = z.array(
  z.looseObject({ zoneNumber: int, secsInZone: num, zoneLowBoundary: num }),
);
export type ActivityHrZones = z.infer<typeof activityHrZonesSchema>;

// The three schemas below follow the known API shapes; none is confirmed by a recording yet (E2-8).

/** `powerTimeInZones`: same shape as `hrTimeInZones`, boundaries in watts. */
export const activityPowerZonesSchema = z.array(
  z.looseObject({ zoneNumber: int, secsInZone: num, zoneLowBoundary: num }),
);
export type ActivityPowerZones = z.infer<typeof activityPowerZonesSchema>;

/** Temperatures in Fahrenheit, wind in the account's display unit. Null when the activity has no weather. */
export const activityWeatherSchema = z
  .looseObject({
    issueDate: str,
    temp: num,
    apparentTemp: num,
    dewPoint: num,
    relativeHumidity: num,
    windDirection: num,
    windDirectionCompassPoint: str,
    windSpeed: num,
    windGust: num,
    weatherStationDTO: z.looseObject({ id: str, name: str }).nullish(),
    weatherTypeDTO: z.looseObject({ weatherTypePk: int, desc: str }).nullish(),
  })
  .nullable();
export type ActivityWeather = z.infer<typeof activityWeatherSchema>;

/** Strength sets: `setType` ACTIVE or REST, weight in grams (-1 = none), duration in seconds. */
export const activityExerciseSetsSchema = z
  .looseObject({
    activityId: int,
    exerciseSets: z
      .array(
        z.looseObject({
          setType: str,
          exercises: z.array(z.looseObject({ category: str, name: str, probability: num })).nullish(),
          repetitionCount: int,
          weight: num,
          duration: num,
          startTime: str,
        }),
      )
      .nullish(),
  })
  .nullable();
export type ActivityExerciseSets = z.infer<typeof activityExerciseSetsSchema>;

export const activityDetailsSchema = z.looseObject({
  activityId: int,
  measurementCount: int,
  metricsCount: int,
  metricDescriptors: z.array(z.looseObject({ metricsIndex: int, key: str, unit: z.unknown() })).nullish(),
  activityDetailMetrics: z.array(z.looseObject({ metrics: z.array(z.number().nullable()) })).nullish(),
  geoPolylineDTO: z.looseObject({ polyline: z.array(z.looseObject({ lat: num, lon: num, time: num })).nullish() }).nullish(),
});
export type ActivityDetails = z.infer<typeof activityDetailsSchema>;

export const activityTypesSchema = z.array(typeRef);
export type ActivityType = z.infer<typeof typeRef>;

// ---------------------------------------------------------------- daily health

export const dailySummarySchema = z.looseObject({
  calendarDate: str,
  totalSteps: num,
  dailyStepGoal: num,
  totalDistanceMeters: num,
  totalKilocalories: num,
  activeKilocalories: num,
  bmrKilocalories: num,
  consumedKilocalories: num,
  includesCalorieConsumedData: bool,
  restingHeartRate: num,
  minHeartRate: num,
  maxHeartRate: num,
  averageStressLevel: num,
  maxStressLevel: num,
  bodyBatteryHighestValue: num,
  bodyBatteryLowestValue: num,
  bodyBatteryChargedValue: num,
  bodyBatteryDrainedValue: num,
  moderateIntensityMinutes: num,
  vigorousIntensityMinutes: num,
  intensityMinutesGoal: num,
  floorsAscended: num,
  averageSpo2: num,
  lowestSpo2: num,
  avgWakingRespirationValue: num,
  sleepingSeconds: num,
  privacyProtected: bool,
});
export type DailySummary = z.infer<typeof dailySummarySchema>;

const valuesArray = z.array(z.array(z.union([z.number(), z.string(), z.null()]))).nullish();

export const stepsChartSchema = z.array(
  z.looseObject({ startGMT: str, endGMT: str, steps: num, primaryActivityLevel: str }),
);

export const heartRateDaySchema = z.looseObject({
  calendarDate: str,
  maxHeartRate: num,
  minHeartRate: num,
  restingHeartRate: num,
  lastSevenDaysAvgRestingHeartRate: num,
  heartRateValues: valuesArray,
});

export const stressDaySchema = z.looseObject({
  calendarDate: str,
  maxStressLevel: num,
  avgStressLevel: num,
  stressValuesArray: valuesArray,
  bodyBatteryValuesArray: valuesArray,
});

export const bodyBatteryReportSchema = z.array(
  z.looseObject({
    date: str,
    charged: num,
    drained: num,
    startTimestampGMT: str,
    endTimestampGMT: str,
    bodyBatteryValuesArray: valuesArray,
  }),
);
export type BodyBatteryReport = z.infer<typeof bodyBatteryReportSchema>;

export const respirationDaySchema = z.looseObject({
  calendarDate: str,
  lowestRespirationValue: num,
  highestRespirationValue: num,
  avgWakingRespirationValue: num,
  avgSleepRespirationValue: num,
});

export const spo2DaySchema = z.looseObject({
  calendarDate: str,
  averageSpO2: num,
  lowestSpO2: num,
  latestSpO2: num,
  avgSleepSpO2: num,
  lastSevenDaysAvgSpO2: z.union([z.number(), z.string()]).nullish(),
});

export const intensityMinutesDaySchema = z.looseObject({
  calendarDate: str,
  weeklyGoal: num,
  moderateMinutes: num,
  vigorousMinutes: num,
});

export const hydrationDaySchema = z.looseObject({ calendarDate: str, goalInML: num, valueInML: num, sweatLossInML: num });

// ---------------------------------------------------------------- sleep and HRV

export const sleepSchema = z.looseObject({
  dailySleepDTO: z
    .looseObject({
      calendarDate: str,
      sleepTimeSeconds: num,
      deepSleepSeconds: num,
      lightSleepSeconds: num,
      remSleepSeconds: num,
      awakeSleepSeconds: num,
      napTimeSeconds: num,
      sleepStartTimestampGMT: num,
      sleepEndTimestampGMT: num,
      sleepStartTimestampLocal: num,
      sleepEndTimestampLocal: num,
      averageSpO2Value: num,
      lowestSpO2Value: num,
      averageRespirationValue: num,
      avgSleepStress: num,
      awakeCount: num,
      sleepScores: z
        .looseObject({ overall: z.looseObject({ value: num, qualifierKey: str }).nullish() })
        .nullish(),
    })
    .nullish(),
  restingHeartRate: num,
  avgOvernightHrv: num,
  hrvStatus: str,
  bodyBatteryChange: num,
});
export type Sleep = z.infer<typeof sleepSchema>;

export const hrvSchema = z
  .looseObject({
    hrvSummary: z
      .looseObject({
        calendarDate: str,
        weeklyAvg: num,
        lastNightAvg: num,
        lastNight5MinHigh: num,
        status: str,
        feedbackPhrase: str,
        baseline: z.looseObject({ lowUpper: num, balancedLow: num, balancedUpper: num, markerValue: num }).nullish(),
      })
      .nullish(),
  })
  .nullable();
export type Hrv = z.infer<typeof hrvSchema>;

// ---------------------------------------------------------------- training

const vo2Entry = z
  .looseObject({ calendarDate: str, vo2MaxPreciseValue: num, vo2MaxValue: num, fitnessAge: num })
  .nullish();

export const trainingStatusSchema = z.looseObject({
  mostRecentVO2Max: z.looseObject({ generic: vo2Entry, cycling: vo2Entry }).nullish(),
  mostRecentTrainingStatus: z
    .looseObject({
      latestTrainingStatusData: z
        .record(
          z.string(),
          z.looseObject({
            calendarDate: str,
            trainingStatus: num,
            trainingStatusFeedbackPhrase: str,
            primaryTrainingDevice: bool,
            sport: str,
            acuteTrainingLoadDTO: z
              .looseObject({
                acwrPercent: num,
                acwrStatus: str,
                dailyTrainingLoadAcute: num,
                dailyTrainingLoadChronic: num,
                dailyAcuteChronicWorkloadRatio: num,
              })
              .nullish(),
          }),
        )
        .nullish(),
    })
    .nullish(),
  mostRecentTrainingLoadBalance: z.looseObject({}).nullish(),
});
export type TrainingStatus = z.infer<typeof trainingStatusSchema>;

export const trainingReadinessSchema = z.array(
  z.looseObject({
    calendarDate: str,
    timestamp: str,
    score: num,
    level: str,
    feedbackShort: str,
    sleepScore: num,
    recoveryTime: num,
    acuteLoad: num,
    hrvFactorPercent: num,
    inputContext: str,
  }),
);
export type TrainingReadiness = z.infer<typeof trainingReadinessSchema>;

export const maxMetricsSchema = z.array(z.looseObject({ generic: vo2Entry, cycling: vo2Entry, calendarDate: str }));
export type MaxMetrics = z.infer<typeof maxMetricsSchema>;

export const racePredictionsSchema = z.looseObject({
  calendarDate: str,
  time5K: num,
  time10K: num,
  timeHalfMarathon: num,
  timeMarathon: num,
});

export const fitnessAgeSchema = z.looseObject({ chronologicalAge: num, fitnessAge: num, achievableFitnessAge: num });

export const personalRecordsSchema = z.array(
  z.looseObject({ typeId: int, activityId: int, value: num, prStartTimeGmtFormatted: str, prTypeLabelKey: str }),
);

// ---------------------------------------------------------------- workouts and calendar

export const workoutSummarySchema = z.looseObject({
  workoutId: id,
  workoutName: str,
  description: str,
  sportType: z.looseObject({ sportTypeId: int, sportTypeKey: str }).nullish(),
  updatedDate: str,
  createdDate: str,
  estimatedDurationInSecs: num,
  estimatedDistanceInMeters: num,
});
export type WorkoutSummary = z.infer<typeof workoutSummarySchema>;
export const workoutListSchema = z.array(workoutSummarySchema);
export const workoutSchema = workoutSummarySchema.extend({ workoutSegments: z.array(z.unknown()).nullish() });
export type Workout = z.infer<typeof workoutSchema>;

export const calendarItemSchema = z.looseObject({
  /** Missing on naps, which have no calendar id of their own. */
  id: int,
  itemType: str,
  date: str,
  title: str,
  workoutId: int,
  activityTypeId: int,
  sportTypeKey: str,
});
export type CalendarItem = z.infer<typeof calendarItemSchema>;
export const calendarMonthSchema = z.looseObject({
  year: int,
  month: int,
  calendarItems: z.array(calendarItemSchema).nullish(),
});
export type CalendarMonth = z.infer<typeof calendarMonthSchema>;

export const workoutScheduleSchema = z.looseObject({
  workoutScheduleId: int,
  calendarDate: str,
  workout: z.looseObject({ workoutId: int, workoutName: str }).nullish(),
});
export type WorkoutSchedule = z.infer<typeof workoutScheduleSchema>;

// ---------------------------------------------------------------- gear

export const gearSchema = z.looseObject({
  uuid: z.string(),
  gearPk: int,
  displayName: str,
  customMakeModel: str,
  gearMakeName: str,
  gearModelName: str,
  gearTypeName: str,
  gearStatusName: str,
  dateBegin: str,
  dateEnd: str,
  maximumMeters: num,
  notes: str,
});
export type Gear = z.infer<typeof gearSchema>;
export const gearListSchema = z.array(gearSchema);

export const gearStatsSchema = z.looseObject({ uuid: str, totalDistance: num, totalActivities: num });
export type GearStats = z.infer<typeof gearStatsSchema>;

// ---------------------------------------------------------------- weight

export const weightEntrySchema = z.looseObject({
  samplePk: z.number(),
  date: num,
  calendarDate: str,
  timestampGMT: num,
  /** grams */
  weight: num,
  bmi: num,
  bodyFat: num,
  bodyWater: num,
  /** grams */
  boneMass: num,
  /** grams */
  muscleMass: num,
  visceralFat: num,
  metabolicAge: num,
  sourceType: str,
});
export type WeightEntry = z.infer<typeof weightEntrySchema>;

export const weighInsSchema = z.looseObject({
  dailyWeightSummaries: z
    .array(
      z.looseObject({
        summaryDate: str,
        latestWeight: weightEntrySchema.nullish(),
        allWeightMetrics: z.array(weightEntrySchema).nullish(),
      }),
    )
    .nullish(),
});
export type WeighIns = z.infer<typeof weighInsSchema>;

// ---------------------------------------------------------------- devices

export const deviceSchema = z.looseObject({
  deviceId: z.number(),
  displayName: str,
  productDisplayName: str,
  partNumber: str,
  currentFirmwareVersion: str,
  deviceStatus: str,
  /** True for every paired device; the main watch is the one with `primaryActivityTrackerIndicator`. */
  primary: bool,
  primaryActivityTrackerIndicator: bool,
});
export type Device = z.infer<typeof deviceSchema>;
export const deviceListSchema = z.array(deviceSchema);

export const deviceLastUsedSchema = z.looseObject({
  userDeviceId: num,
  userProfileNumber: num,
  lastUsedDeviceName: str,
  lastUsedDeviceUploadTime: num,
});
export type DeviceLastUsed = z.infer<typeof deviceLastUsedSchema>;

/**
 * Settings of one device (`device-info/settings/{deviceId}`). Shape not confirmed
 * by a recording yet (E2-8): `alarmTime` in minutes after midnight,
 * `alarmMode` ON or OFF. Null when the device has no settings.
 */
export const deviceSettingsSchema = z
  .looseObject({
    deviceId: num,
    timeFormat: str,
    dateFormat: str,
    measurementUnits: str,
    keyTonesEnabled: bool,
    keyVibrationEnabled: bool,
    alertTonesEnabled: bool,
    activityTracking: z
      .looseObject({
        moveAlertEnabled: bool,
        pulseOxSleepTrackingEnabled: bool,
        highHrAlertEnabled: bool,
        lowHrAlertEnabled: bool,
      })
      .nullish(),
    alarms: z.array(z.looseObject({ alarmId: num, alarmMode: str, alarmTime: num, alarmDays: z.array(z.string()).nullish() })).nullish(),
  })
  .nullable();
export type DeviceSettings = z.infer<typeof deviceSettingsSchema>;
