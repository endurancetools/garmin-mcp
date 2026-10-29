import type { ActivitySummary, GarminClient } from 'garmin-mcp-client';
import { GarminError } from 'garmin-mcp-config';
import { Store, Syncer, SyncJobRunner } from 'garmin-mcp-store';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GarminService } from '../service.js';

export const NOW = Date.parse('2026-10-08T12:00:00Z');

/** The recorded calendar has no races, so tests add one; its shape is not confirmed by a recording. */
const RACE = {
  id: 30000003,
  itemType: 'event',
  date: '2026-10-25',
  title: 'City Half Marathon',
  isRace: true,
  primaryEvent: true,
  subscribed: false,
  location: 'anon-location',
  url: 'https://example.com/half',
  shareableEventUuid: '00000000-0000-4000-8000-000000000003',
  completionTarget: { value: 21.0975, unit: 'kilometer', unitType: 'distance' },
  eventTimeLocal: { startTimeHhMm: '09:00', timeZoneId: 'Europe/Warsaw' },
};

const notFound = (path: string) => new GarminError('NOT_FOUND', `Garmin returned 404 for ${path}`);

/** Response fixtures of garmin-mcp-client (`packages/client/fixtures`), so domain tests follow recorded shapes. */
export function fixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../../client/fixtures', `${name}.json`), 'utf8')) as unknown;
}

export function summary(id: number, day: string, extra: Partial<ActivitySummary> = {}): ActivitySummary {
  return {
    activityId: id,
    activityName: `Run ${day}`,
    startTimeLocal: `${day} 07:00:00`,
    startTimeGMT: `${day} 05:00:00`,
    activityType: { typeId: 1, typeKey: 'running' },
    distance: 10_000,
    duration: 3000,
    averageHR: 150,
    activityTrainingLoad: 100,
    ...extra,
  };
}

export function setup(opts: { activities?: ActivitySummary[]; gone?: ReadonlySet<number>; zip?: Uint8Array; budgetMs?: number; delayMs?: number; autoFetch?: boolean; autoSync?: boolean; redact?: boolean } = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const activities = opts.activities ?? [];
  const names = new Map<number, string>();
  const updated = new Map<number, Record<string, unknown>>();
  const rec = async <T>(method: string, args: unknown[], value: () => T): Promise<T> => {
    calls.push({ method, args });
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    return value();
  };
  const client = {
    listAllActivities: (p: { from?: string; to?: string } = {}, onPage?: (page: ActivitySummary[], n: number) => void) =>
      rec('listAllActivities', [p], () => {
        const list = activities.filter((a) => {
          const d = String(a.startTimeLocal).slice(0, 10);
          return (!p.from || d >= p.from) && (!p.to || d <= p.to);
        });
        onPage?.(list, list.length);
        return list;
      }),
    // Ids in `gone` were deleted in Garmin Connect: the activity and its sections answer 404.
    getActivity: (id: number) =>
      rec('getActivity', [id], () => {
        if (opts.gone?.has(id)) throw notFound(`activity/${id}`);
        return {
          activityId: id,
          activityName: names.get(id) ?? `Run ${id}`,
          description: 'desc',
          activityTypeDTO: { typeKey: 'running' },
          summaryDTO: { startTimeLocal: '2026-10-07T07:00:00.0', movingDuration: 2950, directWorkoutRpe: 60 },
        };
      }),
    getActivitySplits: (id: number) =>
      rec('getActivitySplits', [id], () => {
        if (opts.gone?.has(id)) throw notFound(`activity/${id}/splits`);
        return { lapDTOs: [{ lapIndex: 1, distance: 1000, duration: 300, averageHR: 140 }] };
      }),
    getActivityHrZones: (id: number) => rec('getActivityHrZones', [id], () => [{ zoneNumber: 1, secsInZone: 100, zoneLowBoundary: 100 }, { zoneNumber: 2, secsInZone: 300, zoneLowBoundary: 120 }]),
    // Synthetic shapes (no recorded fixtures yet, E2-8). Activity 2 has none of these (404).
    getActivityPowerZones: (id: number) =>
      rec('getActivityPowerZones', [id], () => {
        if (id === 2) throw notFound(`powerTimeInZones/${id}`);
        return [{ zoneNumber: 1, secsInZone: 600, zoneLowBoundary: 0 }, { zoneNumber: 2, secsInZone: 1800, zoneLowBoundary: 138.4 }];
      }),
    getActivityWeather: (id: number) =>
      rec('getActivityWeather', [id], () => {
        if (id === 2) throw notFound(`weather/${id}`);
        return {
          issueDate: '2026-10-07T07:00:00.000+0000',
          temp: 59,
          apparentTemp: 57,
          dewPoint: 48,
          relativeHumidity: 67,
          windDirection: 315,
          windDirectionCompassPoint: 'nw',
          windSpeed: 11,
          windGust: 20,
          weatherStationDTO: { id: 'EPWA', name: 'Warsaw Chopin' },
          weatherTypeDTO: { weatherTypePk: 3, desc: 'Partly Cloudy' },
        };
      }),
    getActivityExerciseSets: (id: number) =>
      rec('getActivityExerciseSets', [id], () => {
        if (id === 2) throw notFound(`exerciseSets/${id}`);
        return {
          activityId: id,
          exerciseSets: [
            { setType: 'ACTIVE', exercises: [{ category: 'SQUAT', name: 'BARBELL_BACK_SQUAT', probability: 98 }, { category: 'LUNGE', name: null, probability: 2 }], repetitionCount: 8, weight: 80_000, duration: 42.5 },
            { setType: 'REST', exercises: [], duration: 120 },
            { setType: 'ACTIVE', exercises: [{ category: 'SQUAT', name: 'BARBELL_BACK_SQUAT', probability: 99 }], repetitionCount: 6, weight: 90_000, duration: 38 },
            { setType: 'REST', exercises: [], duration: 150 },
            { setType: 'ACTIVE', exercises: [{ category: 'PULL_UP', name: null, probability: 90 }], repetitionCount: 10, weight: -1, duration: 30 },
          ],
        };
      }),
    getActivityDetails: (id: number) =>
      rec('getActivityDetails', [id], () => ({
        metricDescriptors: [{ metricsIndex: 0, key: 'directTimestamp' }, { metricsIndex: 1, key: 'directHeartRate' }],
        activityDetailMetrics: Array.from({ length: 3000 }, (_, i) => ({ metrics: [1_791_000_000_000 + i * 1000, 120 + (i % 30)] })),
      })),
    updateActivity: (id: number, patch: { name?: string }) =>
      rec('updateActivity', [id, patch], () => {
        if (patch.name) names.set(id, patch.name);
      }),
    // Food is logged (linked nutrition app) on days ending in 7 only; other days carry Garmin's "nothing logged" shape.
    getDailySummary: (date: string) =>
      rec('getDailySummary', [date], () => {
        const logged = date.endsWith('7');
        return {
          totalSteps: 8000,
          restingHeartRate: 52,
          totalKilocalories: 2400,
          bmrKilocalories: 1800,
          activeKilocalories: 600,
          consumedKilocalories: logged ? 2150 : null,
          includesCalorieConsumedData: logged,
        };
      }),
    getSleep: (date: string) => rec('getSleep', [date], () => ({ dailySleepDTO: { calendarDate: date, sleepTimeSeconds: 28_800, deepSleepSeconds: 5000, remSleepSeconds: 6000, sleepScores: { overall: { value: 81, qualifierKey: 'GOOD' } } } })),
    getHrv: (date: string) => rec('getHrv', [date], () => ({ hrvSummary: { lastNightAvg: 60 } })),
    getTrainingStatus: (date: string) =>
      rec('getTrainingStatus', [date], () => ({
        ...(fixture('training-status') as Record<string, unknown>),
        mostRecentTrainingLoadBalance: {
          metricsTrainingLoadBalanceDTOMap: {
            3333: {
              calendarDate: date,
              primaryTrainingDevice: true,
              trainingBalanceFeedbackPhrase: 'AEROBIC_HIGH_SHORTAGE',
              monthlyLoadAerobicLow: 610.4,
              monthlyLoadAerobicLowTargetMin: 300,
              monthlyLoadAerobicLowTargetMax: 600,
              monthlyLoadAerobicHigh: 150,
              monthlyLoadAerobicHighTargetMin: 300,
              monthlyLoadAerobicHighTargetMax: 650,
              monthlyLoadAnaerobic: 80,
              monthlyLoadAnaerobicTargetMin: 0,
              monthlyLoadAnaerobicTargetMax: 200,
            },
          },
        },
      })),
    getTrainingReadiness: (date: string) =>
      rec('getTrainingReadiness', [date], () => [
        { score: 70, level: 'HIGH', inputContext: 'AFTER_WAKEUP_RESET', timestamp: `${date}T05:30:00.0`, recoveryTime: 900 },
        { score: 66, level: 'MODERATE', timestamp: `${date}T10:00:00.0`, recoveryTime: 600 },
      ]),
    getRacePredictions: () => rec('getRacePredictions', [], () => fixture('race-predictions')),
    getFitnessAge: (date: string) => rec('getFitnessAge', [date], () => fixture('fitness-age')),
    getPersonalRecords: () => rec('getPersonalRecords', [], () => fixture('personal-records')),
    getEnduranceScore: (from: string, to: string) =>
      rec('getEnduranceScore', [from, to], () => ({
        avg: 6700,
        max: 6850,
        groupMap: { '2026-09-21': { groupAverage: 6650.4 }, '2026-09-14': { groupAverage: 6600 } },
        enduranceScoreDTO: { calendarDate: to, overallScore: 6800, classification: 4 },
      })),
    getHillScore: (from: string, to: string) =>
      rec('getHillScore', [from, to], () => ({
        maxScore: 60,
        hillScoreDTOList: [
          { calendarDate: '2026-10-01', overallScore: 52, strengthScore: 40, enduranceScore: 58 },
          { calendarDate: to, overallScore: 55, strengthScore: 42, enduranceScore: 60 },
        ],
      })),
    getVo2Max: (date: string) =>
      rec('getVo2Max', [date], () => [
        { ...(fixture('max-metrics') as Record<string, unknown>[])[0], heatAltitudeAcclimation: { calendarDate: date, heatAcclimationPercentage: 40, heatTrend: 'ACCLIMATIZING', altitudeAcclimation: 0, altitudeTrend: 'NO_CHANGE' } },
      ]),
    listDevices: () => rec('listDevices', [], () => fixture('devices')),
    getLastUsedDevice: () => rec('getLastUsedDevice', [], () => fixture('device-last-used')),
    getDeviceSettings: (id: number) => rec('getDeviceSettings', [id], () => fixture('device-settings')),
    getActivityTypes: () => rec('getActivityTypes', [], () => fixture('activity-types')),
    getWeighIns: () => rec('getWeighIns', [], () => ({ dailyWeightSummaries: [] })),
    listWorkouts: () => rec('listWorkouts', [], () => [{ workoutId: 700001, workoutName: 'Z2 Run', sportType: { sportTypeKey: 'running' } }]),
    getCalendar: (year: number, month: number) =>
      rec('getCalendar', [year, month], () => {
        const recorded = fixture('calendar-month') as { calendarItems: unknown[] };
        return { ...recorded, calendarItems: [...recorded.calendarItems, RACE] };
      }),
    getWorkout: (id: number) =>
      rec('getWorkout', [id], () => {
        if (id === 666) throw new Error('Workout not found');
        return { ...(fixture('workout') as Record<string, unknown>), workoutId: id, ...updated.get(id) };
      }),
    updateWorkout: (id: number, workout: Record<string, unknown>) =>
      rec('updateWorkout', [id, workout], () => {
        updated.set(id, workout);
        return undefined;
      }),
    createWorkout: (payload: Record<string, unknown>) => rec('createWorkout', [payload], () => ({ workoutId: 4242, workoutName: payload.workoutName, sportType: payload.sportType })),
    scheduleWorkout: (id: number, date: string) =>
      rec('scheduleWorkout', [id, date], () => {
        if (id === 666) throw new Error('Workout not found');
        return { workoutScheduleId: 77, calendarDate: date, workout: { workoutId: id, workoutName: 'W' } };
      }),
    deleteWorkoutSchedule: (id: number) =>
      rec('deleteWorkoutSchedule', [id], () => {
        if (id === 666) throw new Error('Schedule not found');
        return undefined;
      }),
    downloadActivity: (id: number, format: string) => rec('downloadActivity', [id, format], () => ({ data: opts.zip ?? new Uint8Array([1, 2, 3]), contentType: 'application/zip', filename: undefined })),
  };
  const store = Store.open(':memory:');
  const syncer = new Syncer(client as unknown as GarminClient, store, { timeZone: 'UTC', now: () => NOW, fetchOnDemand: opts.autoFetch ?? true });
  const jobs = new SyncJobRunner(syncer, store, { chunkDays: 7, pause: { minMs: 0, maxMs: 0 }, maxRequestsPerDay: 10_000, timeZone: 'UTC', now: () => NOW });
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garmin-dl-'));
  const service = new GarminService({
    client: client as unknown as GarminClient,
    store,
    syncer,
    jobs,
    timeZone: 'UTC',
    downloadDir,
    budgetMs: opts.budgetMs ?? 2000,
    autoSync: opts.autoSync ?? false,
    redact: opts.redact,
    now: () => NOW,
  });
  const count = (method: string) => calls.filter((c) => c.method === method).length;
  return { service, store, calls, count, downloadDir };
}
