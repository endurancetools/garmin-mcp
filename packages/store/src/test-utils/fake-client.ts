import type { ActivitySummary, GarminClient } from 'garmin-mcp-client';

export interface FakeClientOptions {
  activities?: ActivitySummary[];
  /** Activities Garmin still has but leaves out of its list (e.g. a different start date). */
  unlisted?: number[];
  delayMs?: number;
  failWith?: (method: string, arg?: unknown) => Error | undefined;
}

export function activity(id: number, day: string, extra: Partial<ActivitySummary> = {}): ActivitySummary {
  return {
    activityId: id,
    activityName: `Run ${day}`,
    startTimeLocal: `${day} 07:00:00`,
    startTimeGMT: `${day} 05:00:00`,
    activityType: { typeId: 1, typeKey: 'running', parentTypeId: 17 },
    distance: 10_000,
    duration: 3000,
    averageHR: 150,
    maxHR: 175,
    activityTrainingLoad: 100,
    calories: 600,
    ...extra,
  };
}

/** Minimal in-memory stand-in for GarminClient that counts calls per method. */
export function fakeClient(opts: FakeClientOptions = {}) {
  const calls: Record<string, number> = {};
  const activities = (opts.activities ?? []).toSorted((a, b) =>
    String(b.startTimeLocal).localeCompare(String(a.startTimeLocal)),
  );
  const call = async <T>(method: string, arg: unknown, value: () => T): Promise<T> => {
    calls[method] = (calls[method] ?? 0) + 1;
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const err = opts.failWith?.(method, arg);
    if (err) throw err;
    return value();
  };
  const client = {
    getDailySummary: (date: string) =>
      call('getDailySummary', date, () => ({ calendarDate: date, totalSteps: 10_000, restingHeartRate: 50, averageStressLevel: -1, moderateIntensityMinutes: 10, vigorousIntensityMinutes: 5 })),
    getSleep: (date: string) =>
      call('getSleep', date, () => ({ dailySleepDTO: { calendarDate: date, sleepTimeSeconds: 27_000, sleepScores: { overall: { value: 80 } } } })),
    getHrv: (date: string) => call('getHrv', date, () => ({ hrvSummary: { calendarDate: date, lastNightAvg: 60, status: 'BALANCED' } })),
    getTrainingStatus: (date: string) => call('getTrainingStatus', date, () => ({ mostRecentVO2Max: { generic: { vo2MaxPreciseValue: 52.5 } } })),
    getTrainingReadiness: (date: string) => call('getTrainingReadiness', date, () => [{ calendarDate: date, score: 70 }]),
    getRacePredictions: () => call('getRacePredictions', undefined, () => ({ calendarDate: '2026-10-08', time5K: 1260 })),
    getFitnessAge: (date: string) => call('getFitnessAge', date, () => ({ chronologicalAge: 36, fitnessAge: 30.5 })),
    getPersonalRecords: () => call('getPersonalRecords', undefined, () => [{ typeId: 3, value: 1260 }]),
    getEnduranceScore: (from: string, to: string) => call('getEnduranceScore', { from, to }, () => ({ enduranceScoreDTO: { calendarDate: to, overallScore: 6800 } })),
    getHillScore: (from: string, to: string) => call('getHillScore', { from, to }, () => ({ hillScoreDTOList: [{ calendarDate: to, overallScore: 55 }] })),
    getVo2Max: (from: string) => call('getVo2Max', from, () => [{ calendarDate: from, heatAltitudeAcclimation: { heatAcclimationPercentage: 40 } }]),
    listAllActivities: (params: { from?: string; to?: string } = {}, onPage?: (page: ActivitySummary[], total: number) => void) =>
      call('listAllActivities', params, () => {
        const list = activities.filter((a) => {
          const d = String(a.startTimeLocal).slice(0, 10);
          return !opts.unlisted?.includes(a.activityId) && (!params.from || d >= params.from) && (!params.to || d <= params.to);
        });
        onPage?.(list, list.length);
        return list;
      }),
    getActivity: (id: number) =>
      call('getActivity', id, () => {
        const a = activities.find((x) => x.activityId === id);
        if (!a) throw Object.assign(new Error(`Garmin returned 404 for /activity-service/activity/${id}`), { code: 'NOT_FOUND' });
        return { activityId: id, activityName: a.activityName, summaryDTO: { startTimeLocal: a.startTimeLocal } };
      }),
    getWeighIns: (from: string, to: string) =>
      call('getWeighIns', { from, to }, () => ({
        dailyWeightSummaries: [
          { summaryDate: to, allWeightMetrics: [{ samplePk: 1, calendarDate: to, timestampGMT: Date.parse(`${to}T06:00:00Z`), weight: 75_300, bodyFat: 15, muscleMass: 36_000 }] },
        ],
      })),
    getProfile: () => call('getProfile', undefined, () => ({ displayName: 'me', profileId: 1 })),
    getUserSettings: () => call('getUserSettings', undefined, () => ({ userData: { measurementSystem: 'metric' } })),
    getHeartRateZones: () => call('getHeartRateZones', undefined, () => []),
    getPowerZones: () => call('getPowerZones', undefined, () => []),
    listGear: () => call('listGear', undefined, () => [{ uuid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', displayName: 'Shoe', gearTypeName: 'Shoes', gearStatusName: 'active' }]),
    getGearStats: () => call('getGearStats', undefined, () => ({ totalDistance: 100_000 })),
    getGearActivities: () => call('getGearActivities', undefined, () => activities.slice(0, 1)),
    listDevices: () => call('listDevices', undefined, () => [{ deviceId: 7, displayName: 'FR965', productDisplayName: 'Forerunner 965' }]),
    getDeviceSettings: (id: number) => call('getDeviceSettings', id, () => ({ deviceId: id, timeFormat: 'time_twenty_four_hr', measurementUnits: 'metric' })),
    getLastUsedDevice: () => call('getLastUsedDevice', undefined, () => ({ userDeviceId: 7, lastUsedDeviceUploadTime: Date.parse('2026-10-08T06:00:00Z') })),
    getActivityTypes: () =>
      call('getActivityTypes', undefined, () => [
        { typeId: 1, typeKey: 'running', parentTypeId: 17 },
        { typeId: 7, typeKey: 'trail_running', parentTypeId: 1 },
      ]),
    listWorkouts: () => call('listWorkouts', undefined, () => [{ workoutId: 5, workoutName: 'Z2', sportType: { sportTypeKey: 'running' } }]),
    getCalendar: (year: number, month: number) =>
      call('getCalendar', { year, month }, () => ({
        calendarItems: [
          { id: 900 + month, itemType: 'workout', workoutId: 5, date: `${year}-${String(month).padStart(2, '0')}-15` },
          { id: 800 + month, itemType: 'event', title: 'Race', isRace: true, date: `${year}-${String(month).padStart(2, '0')}-20` },
        ],
      })),
  };
  /** Deletes an activity in "Garmin Connect". */
  const remove = (id: number) => activities.splice(activities.findIndex((a) => a.activityId === id), 1);
  return { client: client as unknown as GarminClient, calls, remove };
}
