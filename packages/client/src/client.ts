import type { TokenProvider } from 'garmin-mcp-auth';
import { assertIsoDate, InputError, type GarminConfig, type IsoDate, type Logger } from 'garmin-mcp-config';
import { NotFoundError } from './errors.js';
import { HttpCore, type BinaryResponse, type HttpOptions, type Query } from './http.js';
import * as s from './schemas.js';

export interface ActivityListParams {
  /** Offset, 0 = most recent. */
  start?: number;
  limit?: number;
  from?: IsoDate;
  to?: IsoDate;
  /** Garmin type key, e.g. running, cycling. */
  type?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface ActivityPatch {
  name?: string;
  description?: string;
  /** Activity type key; resolved to Garmin's type ids via getActivityTypes() unless `activityType` is given. */
  typeKey?: string;
  /** The type already resolved by the caller (e.g. from the cached type list); skips the type list request. */
  activityType?: s.ActivityType;
  /** 0–10, stored by Garmin as 0–100. */
  rpe?: number;
  /** One of 0, 25, 50, 75, 100 ("very weak" .. "very strong"). */
  feel?: 0 | 25 | 50 | 75 | 100;
}

export type DownloadFormat = 'fit' | 'gpx' | 'tcx' | 'kml' | 'csv';

export interface GarminClientOptions extends Partial<Omit<HttpOptions, 'tokens' | 'app' | 'baseUrl'>> {
  logger?: Logger;
}

const MAX_ACTIVITY_PAGE = 1000;

/**
 * Typed connectapi client. Returns validated raw objects; no aggregation
 * or trimming happens here.
 */
export class GarminClient {
  readonly http: HttpCore;
  #profile: Promise<s.SocialProfile> | undefined;

  constructor(
    config: Pick<GarminConfig, 'hosts' | 'app' | 'concurrency'> & Partial<Pick<GarminConfig, 'minRequestIntervalMs'>>,
    tokens: TokenProvider,
    options: GarminClientOptions = {},
  ) {
    this.http = new HttpCore({
      ...options,
      baseUrl: config.hosts.connectapi,
      tokens,
      app: config.app,
      concurrency: options.concurrency ?? config.concurrency,
      minIntervalMs: options.minIntervalMs ?? config.minRequestIntervalMs ?? 0,
    });
  }

  // ------------------------------------------------------------ profile

  async getProfile(): Promise<s.SocialProfile> {
    this.#profile ??= this.http
      .request('GET', '/userprofile-service/socialProfile', { schema: s.socialProfileSchema })
      .catch((err: unknown) => {
        this.#profile = undefined;
        throw err;
      });
    return this.#profile;
  }

  async getUserSettings(): Promise<s.UserSettings> {
    return this.http.request('GET', '/userprofile-service/userprofile/user-settings', { schema: s.userSettingsSchema });
  }

  async getHeartRateZones(): Promise<s.HeartRateZones> {
    return this.http.request('GET', '/biometric-service/heartRateZones', { schema: s.heartRateZonesSchema });
  }

  async getPowerZones(): Promise<s.PowerZones> {
    return this.http.request('GET', '/biometric-service/powerZones/sports/all', { schema: s.powerZonesSchema });
  }

  async getPersonalRecords(): Promise<unknown> {
    return this.#withDisplayName((name) =>
      this.http.request('GET', `/personalrecord-service/personalrecord/prs/${name}`, { schema: s.personalRecordsSchema }),
    );
  }

  async #displayName(): Promise<string> {
    const profile = await this.getProfile();
    if (!profile.displayName) throw new NotFoundError('socialProfile.displayName');
    return encodeURIComponent(profile.displayName);
  }

  async #withDisplayName<T>(fn: (name: string) => Promise<T>): Promise<T> {
    return fn(await this.#displayName());
  }

  /** userProfilePk needed by gear endpoints: the social profile id, else the last-used device's owner. */
  async getUserProfilePk(): Promise<number> {
    const profile = await this.getProfile();
    if (profile.profileId) return profile.profileId;
    const last = await this.getLastUsedDevice();
    if (last.userProfileNumber) return last.userProfileNumber;
    throw new NotFoundError('userProfilePk');
  }

  // ------------------------------------------------------------ activities

  async listActivities(params: ActivityListParams = {}): Promise<s.ActivitySummary[]> {
    const limit = Math.min(params.limit ?? 20, MAX_ACTIVITY_PAGE);
    const query: Query = {
      start: params.start ?? 0,
      limit,
      startDate: params.from && assertIsoDate(params.from, 'from'),
      endDate: params.to && assertIsoDate(params.to, 'to'),
      activityType: params.type,
      sortOrder: params.sortOrder,
    };
    return this.http
      .request('GET', '/activitylist-service/activities/search/activities', {
        query,
        schema: s.activityListSchema,
        strict: true,
      })
      .then((list) => list ?? []);
  }

  /** Every activity matching the filter, paging until Garmin returns an empty page. */
  async listAllActivities(
    params: Omit<ActivityListParams, 'start' | 'limit'> & { pageSize?: number; maxPages?: number } = {},
    onPage?: (page: s.ActivitySummary[], total: number) => void,
  ): Promise<s.ActivitySummary[]> {
    const pageSize = params.pageSize ?? 100;
    const out: s.ActivitySummary[] = [];
    for (let page = 0; page < (params.maxPages ?? 1000); page++) {
      const batch = await this.listActivities({ ...params, start: page * pageSize, limit: pageSize });
      out.push(...batch);
      onPage?.(batch, out.length);
      if (batch.length < pageSize) break;
    }
    return out;
  }

  async getActivity(id: number): Promise<s.Activity> {
    return this.http.request('GET', `/activity-service/activity/${positive(id)}`, { schema: s.activitySchema, strict: true });
  }

  async getActivitySplits(id: number): Promise<s.ActivitySplits> {
    return this.http.request('GET', `/activity-service/activity/${positive(id)}/splits`, { schema: s.activitySplitsSchema });
  }

  async getActivityHrZones(id: number): Promise<s.ActivityHrZones> {
    return this.http.request('GET', `/activity-service/activity/${positive(id)}/hrTimeInZones`, {
      schema: s.activityHrZonesSchema,
    });
  }

  async getActivityPowerZones(id: number): Promise<s.ActivityPowerZones> {
    return this.http.request('GET', `/activity-service/activity/${positive(id)}/powerTimeInZones`, {
      schema: s.activityPowerZonesSchema,
    });
  }

  async getActivityDetails(id: number, maxChartSize = 2000, maxPolylineSize = 4000): Promise<s.ActivityDetails> {
    return this.http.request('GET', `/activity-service/activity/${positive(id)}/details`, {
      query: { maxChartSize, maxPolylineSize },
      schema: s.activityDetailsSchema,
    });
  }

  async getActivityWeather(id: number): Promise<s.ActivityWeather> {
    return this.http.request('GET', `/activity-service/activity/${positive(id)}/weather`, { schema: s.activityWeatherSchema });
  }

  async getActivityExerciseSets(id: number): Promise<s.ActivityExerciseSets> {
    return this.http.request('GET', `/activity-service/activity/${positive(id)}/exerciseSets`, {
      schema: s.activityExerciseSetsSchema,
    });
  }

  async getActivityTypes(): Promise<s.ActivityType[]> {
    return this.http.request('GET', '/activity-service/activity/activityTypes', { schema: s.activityTypesSchema });
  }

  async updateActivity(id: number, patch: ActivityPatch): Promise<void> {
    const body: Record<string, unknown> = { activityId: positive(id) };
    if (patch.name !== undefined) body.activityName = patch.name;
    if (patch.description !== undefined) body.description = patch.description;
    if (patch.activityType !== undefined) {
      const t = patch.activityType;
      body.activityTypeDTO = { typeId: t.typeId, typeKey: t.typeKey, parentTypeId: t.parentTypeId };
    } else if (patch.typeKey !== undefined) {
      const types = await this.getActivityTypes();
      const match = types.find((t) => t.typeKey === patch.typeKey);
      if (!match) {
        const valid = types.map((t) => t.typeKey).filter(Boolean).toSorted().join(', ');
        throw new InputError(`Unknown activity type "${patch.typeKey}". Valid keys: ${valid}`);
      }
      body.activityTypeDTO = { typeId: match.typeId, typeKey: match.typeKey, parentTypeId: match.parentTypeId };
    }
    // Only the changed summary fields: sending the full summaryDTO back is rejected (GPS pair).
    const summary: Record<string, number> = {};
    if (patch.rpe !== undefined) {
      if (patch.rpe < 0 || patch.rpe > 10) throw new InputError('rpe must be between 0 and 10');
      summary.directWorkoutRpe = Math.round(patch.rpe * 10);
    }
    if (patch.feel !== undefined) {
      if (![0, 25, 50, 75, 100].includes(patch.feel)) throw new InputError('feel must be one of 0, 25, 50, 75, 100');
      summary.directWorkoutFeel = patch.feel;
    }
    if (Object.keys(summary).length > 0) body.summaryDTO = summary;
    await this.http.request('PUT', `/activity-service/activity/${body.activityId as number}`, { json: body });
  }

  async deleteActivity(id: number): Promise<unknown> {
    return this.http.request('DELETE', `/activity-service/activity/${positive(id)}`);
  }

  async downloadActivity(id: number, format: DownloadFormat): Promise<BinaryResponse> {
    const path =
      format === 'fit'
        ? `/download-service/files/activity/${positive(id)}`
        : `/download-service/export/${format}/activity/${positive(id)}`;
    return this.http.download(path);
  }

  // ------------------------------------------------------------ daily health

  async getDailySummary(date: IsoDate): Promise<s.DailySummary> {
    return this.#withDisplayName((name) =>
      this.http.request('GET', `/usersummary-service/usersummary/daily/${name}`, {
        query: { calendarDate: assertIsoDate(date) },
        schema: s.dailySummarySchema,
      }),
    );
  }

  async getSteps(date: IsoDate): Promise<unknown> {
    return this.#withDisplayName((name) =>
      this.http.request('GET', `/wellness-service/wellness/dailySummaryChart/${name}`, {
        query: { date: assertIsoDate(date) },
        schema: s.stepsChartSchema,
      }),
    );
  }

  async getHeartRate(date: IsoDate): Promise<unknown> {
    return this.#withDisplayName((name) =>
      this.http.request('GET', `/wellness-service/wellness/dailyHeartRate/${name}`, {
        query: { date: assertIsoDate(date) },
        schema: s.heartRateDaySchema,
      }),
    );
  }

  async getStress(date: IsoDate): Promise<unknown> {
    return this.http.request('GET', `/wellness-service/wellness/dailyStress/${assertIsoDate(date)}`, {
      schema: s.stressDaySchema,
    });
  }

  async getBodyBattery(from: IsoDate, to: IsoDate = from): Promise<s.BodyBatteryReport> {
    return this.http
      .request('GET', '/wellness-service/wellness/bodyBattery/reports/daily', {
        query: { startDate: assertIsoDate(from), endDate: assertIsoDate(to) },
        schema: s.bodyBatteryReportSchema,
      })
      .then((r) => r ?? []);
  }

  async getRespiration(date: IsoDate): Promise<unknown> {
    return this.http.request('GET', `/wellness-service/wellness/daily/respiration/${assertIsoDate(date)}`, {
      schema: s.respirationDaySchema,
    });
  }

  async getSpo2(date: IsoDate): Promise<unknown> {
    return this.http.request('GET', `/wellness-service/wellness/daily/spo2/${assertIsoDate(date)}`, {
      schema: s.spo2DaySchema,
    });
  }

  async getIntensityMinutes(date: IsoDate): Promise<unknown> {
    return this.http.request('GET', `/wellness-service/wellness/daily/im/${assertIsoDate(date)}`, {
      schema: s.intensityMinutesDaySchema,
    });
  }

  async getHydration(date: IsoDate): Promise<unknown> {
    return this.http.request('GET', `/usersummary-service/usersummary/hydration/daily/${assertIsoDate(date)}`, {
      schema: s.hydrationDaySchema,
    });
  }

  // ------------------------------------------------------------ sleep, HRV

  async getSleep(date: IsoDate): Promise<s.Sleep> {
    return this.#withDisplayName((name) =>
      this.http.request('GET', `/wellness-service/wellness/dailySleepData/${name}`, {
        query: { date: assertIsoDate(date), nonSleepBufferMinutes: 60 },
        schema: s.sleepSchema,
      }),
    );
  }

  async getHrv(date: IsoDate): Promise<s.Hrv> {
    return this.http.request('GET', `/hrv-service/hrv/${assertIsoDate(date)}`, { schema: s.hrvSchema });
  }

  // ------------------------------------------------------------ training

  async getTrainingStatus(date: IsoDate): Promise<s.TrainingStatus> {
    return this.http.request('GET', `/metrics-service/metrics/trainingstatus/aggregated/${assertIsoDate(date)}`, {
      schema: s.trainingStatusSchema,
    });
  }

  async getTrainingReadiness(date: IsoDate): Promise<s.TrainingReadiness> {
    return this.http
      .request('GET', `/metrics-service/metrics/trainingreadiness/${assertIsoDate(date)}`, {
        schema: s.trainingReadinessSchema,
      })
      .then((r) => r ?? []);
  }

  async getVo2Max(from: IsoDate, to: IsoDate = from): Promise<s.MaxMetrics> {
    return this.http
      .request('GET', `/metrics-service/metrics/maxmet/daily/${assertIsoDate(from)}/${assertIsoDate(to)}`, {
        schema: s.maxMetricsSchema,
      })
      .then((r) => r ?? []);
  }

  async getEnduranceScore(from: IsoDate, to: IsoDate): Promise<unknown> {
    return this.http.request('GET', '/metrics-service/metrics/endurancescore/stats', {
      query: { startDate: assertIsoDate(from), endDate: assertIsoDate(to), aggregation: 'weekly' },
    });
  }

  async getHillScore(from: IsoDate, to: IsoDate): Promise<unknown> {
    return this.http.request('GET', '/metrics-service/metrics/hillscore/stats', {
      query: { startDate: assertIsoDate(from), endDate: assertIsoDate(to), aggregation: 'daily' },
    });
  }

  async getRacePredictions(): Promise<unknown> {
    return this.#withDisplayName((name) =>
      this.http.request('GET', `/metrics-service/metrics/racepredictions/latest/${name}`, {
        schema: s.racePredictionsSchema,
      }),
    );
  }

  async getFitnessAge(date: IsoDate): Promise<unknown> {
    return this.http.request('GET', `/fitnessage-service/fitnessage/${assertIsoDate(date)}`, { schema: s.fitnessAgeSchema });
  }

  // ------------------------------------------------------------ workouts

  async listWorkouts(start = 0, limit = 100): Promise<s.WorkoutSummary[]> {
    return this.http
      .request('GET', '/workout-service/workouts', { query: { start, limit }, schema: s.workoutListSchema, strict: true })
      .then((r) => r ?? []);
  }

  async getWorkout(id: number): Promise<s.Workout> {
    return this.http.request('GET', `/workout-service/workout/${positive(id)}`, { schema: s.workoutSchema, strict: true });
  }

  async createWorkout(definition: Record<string, unknown>): Promise<s.Workout> {
    return this.http.request('POST', '/workout-service/workout', { json: definition, schema: s.workoutSchema, strict: true });
  }

  /** Overwrite a saved workout; Garmin expects the whole workout carrying its id. */
  async updateWorkout(id: number, workout: Record<string, unknown>): Promise<unknown> {
    return this.http.request('PUT', `/workout-service/workout/${positive(id)}`, { json: { ...workout, workoutId: positive(id) } });
  }

  async deleteWorkout(id: number): Promise<unknown> {
    return this.http.request('DELETE', `/workout-service/workout/${positive(id)}`);
  }

  async scheduleWorkout(workoutId: number, date: IsoDate): Promise<s.WorkoutSchedule> {
    return this.http.request('POST', `/workout-service/schedule/${positive(workoutId)}`, {
      json: { date: assertIsoDate(date) },
      schema: s.workoutScheduleSchema,
    });
  }

  async deleteWorkoutSchedule(scheduleId: number): Promise<unknown> {
    return this.http.request('DELETE', `/workout-service/schedule/${positive(scheduleId)}`);
  }

  /** `month` is 1–12; Garmin's calendar-service counts months from 0. */
  async getCalendar(year: number, month: number): Promise<s.CalendarMonth> {
    if (month < 1 || month > 12) throw new InputError('month must be 1-12');
    return this.http.request('GET', `/calendar-service/year/${year}/month/${month - 1}`, { schema: s.calendarMonthSchema });
  }

  // ------------------------------------------------------------ gear

  async listGear(): Promise<s.Gear[]> {
    const pk = await this.getUserProfilePk();
    const list = await this.http.request('GET', '/gear-service/gear/filterGear', {
      query: { userProfilePk: pk },
      schema: s.gearListSchema,
      strict: true,
    });
    return list ?? [];
  }

  async getGearStats(uuid: string): Promise<s.GearStats | null> {
    try {
      return await this.http.request('GET', `/gear-service/gear/stats/${uuidOf(uuid)}`, { schema: s.gearStatsSchema });
    } catch (err) {
      if (err instanceof NotFoundError) return null; // retired gear
      throw err;
    }
  }

  async getGearActivities(uuid: string, limit = 1000): Promise<s.ActivitySummary[]> {
    try {
      const list = await this.http.request('GET', `/activitylist-service/activities/${uuidOf(uuid)}/gear`, {
        query: { start: 0, limit: Math.min(limit, MAX_ACTIVITY_PAGE) },
        schema: s.activityListSchema,
      });
      return list ?? [];
    } catch (err) {
      if (err instanceof NotFoundError) return [];
      throw err;
    }
  }

  // ------------------------------------------------------------ weight and body composition

  async getWeighIns(from: IsoDate, to: IsoDate): Promise<s.WeighIns> {
    return this.http.request('GET', `/weight-service/weight/range/${assertIsoDate(from)}/${assertIsoDate(to)}`, {
      query: { includeAll: true },
      schema: s.weighInsSchema,
    });
  }

  /** Adds a manual weigh-in at `at` (default now). */
  async addWeighIn(kg: number, at: Date = new Date()): Promise<unknown> {
    if (!(kg > 0)) throw new InputError('weight must be positive');
    return this.http.request('POST', '/weight-service/user-weight', {
      json: {
        dateTimestamp: localTimestamp(at),
        gmtTimestamp: at.toISOString().slice(0, 23),
        unitKey: 'kg',
        sourceType: 'MANUAL',
        value: kg,
      },
    });
  }

  async deleteWeighIn(samplePk: number, date: IsoDate): Promise<unknown> {
    return this.http.request('DELETE', `/weight-service/weight/${assertIsoDate(date)}/byversion/${positive(samplePk)}`);
  }

  // ------------------------------------------------------------ devices

  async listDevices(): Promise<s.Device[]> {
    return this.http
      .request('GET', '/device-service/deviceregistration/devices', { schema: s.deviceListSchema, strict: true })
      .then((r) => r ?? []);
  }

  async getDeviceSettings(id: number): Promise<s.DeviceSettings> {
    return this.http.request('GET', `/device-service/deviceservice/device-info/settings/${positive(id)}`, { schema: s.deviceSettingsSchema });
  }

  async getLastUsedDevice(): Promise<s.DeviceLastUsed> {
    return this.http.request('GET', '/device-service/deviceservice/mylastused', { schema: s.deviceLastUsedSchema });
  }
}

function positive(id: number): number {
  if (!Number.isSafeInteger(id) || id <= 0) throw new InputError(`id must be a positive integer, got ${id}`);
  return id;
}

function uuidOf(uuid: string): string {
  if (!/^[0-9a-f-]{32,36}$/i.test(uuid)) throw new InputError(`invalid gear uuid "${uuid}"`);
  return uuid;
}

/** `YYYY-MM-DDTHH:mm:ss.SSS` in the process' local zone, as Garmin expects for dateTimestamp. */
function localTimestamp(d: Date): string {
  const offset = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - offset).toISOString().slice(0, 23);
}
