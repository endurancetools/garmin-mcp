/**
 * Raw Garmin JSON → indexed columns. Kept separate from SQL so the mapping is
 * easy to unit test and to extend when Garmin adds fields.
 */
import type {
  Activity,
  ActivitySummary,
  DailySummary,
  Device,
  Gear,
  GearStats,
  Hrv,
  Sleep,
  TrainingReadiness,
  TrainingStatus,
  WeightEntry,
  WorkoutSummary,
} from 'garmin-mcp-client';

type Num = number | null;

const n = (v: unknown): Num => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** Garmin encodes "no data" as negative values for stress and similar gauges. */
const nonNeg = (v: unknown): Num => {
  const x = n(v);
  return x !== null && x >= 0 ? x : null;
};
const s = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** "2026-10-07 05:00:00" or "2026-10-07T05:00:00.0" → "2026-10-07T05:00:00". */
export function normalizeLocal(v: unknown): string | null {
  const str = s(v);
  if (!str) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(str);
  return m ? `${m[1]}T${m[2]}` : null;
}

/** GMT strings or epoch millis → ISO UTC with Z. */
export function normalizeUtc(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString().replace('.000Z', 'Z');
  const local = normalizeLocal(v);
  return local ? `${local}Z` : null;
}

export interface ActivityColumns {
  id: number;
  start_time_utc: string | null;
  start_time_local: string | null;
  type: string | null;
  name: string | null;
  duration_s: Num;
  distance_m: Num;
  avg_hr: Num;
  max_hr: Num;
  avg_power: Num;
  training_effect_aerobic: Num;
  training_effect_anaerobic: Num;
  training_load: Num;
  calories: Num;
  elevation_gain_m: Num;
}

export function activityColumns(a: ActivitySummary): ActivityColumns {
  return {
    id: a.activityId,
    start_time_utc: normalizeUtc(a.startTimeGMT),
    start_time_local: normalizeLocal(a.startTimeLocal),
    type: s(a.activityType?.typeKey),
    name: s(a.activityName),
    duration_s: n(a.duration),
    distance_m: n(a.distance),
    avg_hr: n(a.averageHR),
    max_hr: n(a.maxHR),
    avg_power: n(a.avgPower),
    training_effect_aerobic: n(a.aerobicTrainingEffect),
    training_effect_anaerobic: n(a.anaerobicTrainingEffect),
    training_load: n(a.activityTrainingLoad),
    calories: n(a.calories),
    elevation_gain_m: n(a.elevationGain),
  };
}

/** Columns from the single-activity endpoint, used after edits. */
export function activityColumnsFromDetail(a: Activity): Partial<ActivityColumns> & { id: number } {
  const sum = a.summaryDTO;
  return {
    id: a.activityId,
    name: s(a.activityName),
    type: s(a.activityTypeDTO?.typeKey),
    start_time_local: normalizeLocal(sum?.startTimeLocal),
    start_time_utc: normalizeUtc(sum?.startTimeGMT),
  };
}

export function dailySummaryColumns(d: DailySummary | null) {
  const moderate = n(d?.moderateIntensityMinutes);
  const vigorous = n(d?.vigorousIntensityMinutes);
  return {
    steps: n(d?.totalSteps),
    resting_hr: n(d?.restingHeartRate),
    avg_stress: nonNeg(d?.averageStressLevel),
    body_battery_high: nonNeg(d?.bodyBatteryHighestValue),
    body_battery_low: nonNeg(d?.bodyBatteryLowestValue),
    total_calories: n(d?.totalKilocalories),
    active_calories: n(d?.activeKilocalories),
    // Garmin counts vigorous minutes double toward the weekly goal.
    intensity_minutes: moderate === null && vigorous === null ? null : (moderate ?? 0) + 2 * (vigorous ?? 0),
    avg_spo2: nonNeg(d?.averageSpo2),
    avg_respiration: nonNeg(d?.avgWakingRespirationValue),
  };
}

export function sleepColumns(sl: Sleep | null) {
  const d = sl?.dailySleepDTO;
  return {
    start_utc: normalizeUtc(d?.sleepStartTimestampGMT),
    end_utc: normalizeUtc(d?.sleepEndTimestampGMT),
    duration_s: n(d?.sleepTimeSeconds),
    deep_s: n(d?.deepSleepSeconds),
    light_s: n(d?.lightSleepSeconds),
    rem_s: n(d?.remSleepSeconds),
    awake_s: n(d?.awakeSleepSeconds),
    score: n(d?.sleepScores?.overall?.value),
    avg_spo2: nonNeg(d?.averageSpO2Value),
    avg_respiration: nonNeg(d?.averageRespirationValue),
  };
}

export function hrvColumns(h: Hrv | null) {
  const sum = h?.hrvSummary;
  return {
    last_night_avg: n(sum?.lastNightAvg),
    weekly_avg: n(sum?.weeklyAvg),
    status: s(sum?.status),
    baseline_low: n(sum?.baseline?.balancedLow),
    baseline_high: n(sum?.baseline?.balancedUpper),
  };
}

export function trainingColumns(status: TrainingStatus | null, readiness: TrainingReadiness | null) {
  const devices = Object.values(status?.mostRecentTrainingStatus?.latestTrainingStatusData ?? {});
  const primary = devices.find((d) => d.primaryTrainingDevice) ?? devices[0];
  const load = primary?.acuteTrainingLoadDTO;
  const morning = readiness?.find((r) => r.inputContext === 'AFTER_WAKEUP_RESET') ?? readiness?.[0];
  const vo2 = status?.mostRecentVO2Max;
  return {
    vo2max_running: n(vo2?.generic?.vo2MaxPreciseValue) ?? n(vo2?.generic?.vo2MaxValue),
    vo2max_cycling: n(vo2?.cycling?.vo2MaxPreciseValue) ?? n(vo2?.cycling?.vo2MaxValue),
    status: s(primary?.trainingStatusFeedbackPhrase),
    acute_load: n(load?.dailyTrainingLoadAcute),
    chronic_load: n(load?.dailyTrainingLoadChronic),
    readiness_score: n(morning?.score),
  };
}

export function bodyCompositionColumns(w: WeightEntry) {
  const grams = (v: unknown) => {
    const x = n(v);
    return x === null ? null : Math.round(x) / 1000;
  };
  return {
    sample_time_utc: normalizeUtc(w.timestampGMT ?? w.date) ?? `${w.calendarDate ?? 'unknown'}T00:00:00Z#${w.samplePk}`,
    date: s(w.calendarDate) ?? (normalizeUtc(w.date) ?? '').slice(0, 10),
    sample_pk: w.samplePk,
    weight_kg: grams(w.weight),
    body_fat_pct: n(w.bodyFat),
    muscle_mass_kg: grams(w.muscleMass),
    bmi: n(w.bmi),
  };
}

export function workoutColumns(w: WorkoutSummary) {
  return {
    id: w.workoutId,
    name: s(w.workoutName),
    sport: s(w.sportType?.sportTypeKey),
    updated_at: normalizeLocal(w.updatedDate),
  };
}

export function gearColumns(g: Gear, stats: GearStats | null) {
  const makeModel = [g.gearMakeName, g.gearModelName].filter((x) => x && x !== 'Unknown').join(' ');
  return {
    uuid: g.uuid,
    name: s(g.displayName) ?? s(g.customMakeModel) ?? (makeModel || null),
    type: s(g.gearTypeName),
    status: s(g.gearStatusName),
    total_distance_m: n(stats?.totalDistance),
  };
}

export function deviceColumns(d: Device, lastSyncUtc: string | null) {
  return {
    id: d.deviceId,
    name: s(d.displayName),
    model: s(d.productDisplayName),
    last_sync_utc: lastSyncUtc,
  };
}
