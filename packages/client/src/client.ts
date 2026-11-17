import type { TokenProvider } from 'garmin-mcp-auth';
import { assertIsoDate, GarminError, InputError, type GarminConfig, type IsoDate, type Logger } from 'garmin-mcp-config';
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
  /** Event type (race, training...) as Garmin lists it in getEventTypes(). */
  eventType?: s.EventType;
  /** 0–10, stored by Garmin as 0–100. */
  rpe?: number;
  /** One of 0, 25, 50, 75, 100 ("very weak" .. "very strong"). */
  feel?: 0 | 25 | 50 | 75 | 100;
  /** Who sees the activity; sent as Garmin's access control rule. */
  privacy?: ActivityPrivacy;
}

/**
 * Garmin's access control rules (`accessControlRuleDTO`) behind the privacy choices: "followers"
 * is "My Connections" (`subscribers`). Recordings show `groups` (typeId 4) on read; the other ids
 * and writing the rule with the activity PUT are not confirmed by a recording yet (E8-30).
 */
export const ACTIVITY_PRIVACY = {
  public: { typeId: 1, typeKey: 'public' },
  private: { typeId: 2, typeKey: 'private' },
  followers: { typeId: 3, typeKey: 'subscribers' },
} as const;
export type ActivityPrivacy = keyof typeof ACTIVITY_PRIVACY;

function privacyRule(privacy: ActivityPrivacy) {
  const rule = ACTIVITY_PRIVACY[privacy] as (typeof ACTIVITY_PRIVACY)[ActivityPrivacy] | undefined;
  if (!rule) throw new InputError(`privacy must be one of ${Object.keys(ACTIVITY_PRIVACY).join(', ')}`);
  return { ...rule };
}

/** When a measurement was taken: the wall clock in the account's time zone and the instant. */
export interface MeasuredAt {
  /** Local time "2026-11-17T07:30:00". */
  local: string;
  utc: Date;
}

/** File types Garmin Connect imports as an activity. */
export const UPLOAD_FORMATS = ['fit', 'gpx', 'tcx'] as const;

/**
 * What became of an uploaded activity file: a new activity, a duplicate of one Garmin already has
 * (HTTP 409, with its id when Garmin names it), accepted but still processing (no id yet), or refused.
 */
export type UploadResult =
  | { status: 'created'; activityId: number }
  | { status: 'duplicate'; activityId?: number; message: string }
  | { status: 'processing' }
  | { status: 'failed'; message: string };

/** A manual activity: one entered by hand, without a file from a device. */
export interface ManualActivity {
  /** Activity type key; resolved like `ActivityPatch.typeKey`. */
  typeKey: string;
  activityType?: s.ActivityType;
  name: string;
  /** Local start in `timeZone`, "2026-11-16T18:30:00". */
  startLocal: string;
  /** IANA time zone of `startLocal`, e.g. Europe/Warsaw. */
  timeZone: string;
  durationS: number;
  distanceM?: number;
  privacy: ActivityPrivacy;
}

export type DownloadFormat = 'fit' | 'gpx' | 'tcx' | 'kml' | 'csv';

export interface GarminClientOptions extends Partial<Omit<HttpOptions, 'tokens' | 'app' | 'baseUrl'>> {
  logger?: Logger;
}

const MAX_ACTIVITY_PAGE = 1000;

/** Running thresholds per day, the latest value of each day. */
const LACTATE_QUERY: Query = { sport: 'RUNNING', aggregation: 'daily', aggregationStrategy: 'LATEST' };

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

  /** Drop the cached profile: after a new sign-in the tokens may belong to another account. */
  forgetProfile(): void {
    this.#profile = undefined;
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

  /** Run, walk, idle, ClimbPro climb... segments of an activity. Path confirmed by a recording (E8-2). */
  async getActivityTypedSplits(id: number): Promise<unknown> {
    return this.http.request('GET', `/activity-service/activity/${positive(id)}/typedsplits`, {
      schema: s.activityTypedSplitsSchema,
    });
  }

  /** Totals per split type. Path confirmed by a recording (E8-2). */
  async getActivitySplitSummaries(id: number): Promise<unknown> {
    return this.http.request('GET', `/activity-service/activity/${positive(id)}/split_summaries`, {
      schema: s.activitySplitSummariesSchema,
    });
  }

  async getActivityTypes(): Promise<s.ActivityType[]> {
    return this.http.request('GET', '/activity-service/activity/activityTypes', { schema: s.activityTypesSchema });
  }

  /** Event types an activity can be tagged with: race, training, recreation... */
  async getEventTypes(): Promise<s.EventType[]> {
    return this.http.request('GET', '/activity-service/activity/eventTypes', { schema: s.eventTypesSchema });
  }

  async updateActivity(id: number, patch: ActivityPatch): Promise<void> {
    const body: Record<string, unknown> = { activityId: positive(id) };
    if (patch.name !== undefined) body.activityName = patch.name;
    if (patch.description !== undefined) body.description = patch.description;
    if (patch.activityType !== undefined || patch.typeKey !== undefined) body.activityTypeDTO = await this.#activityTypeDTO(patch.typeKey, patch.activityType);
    if (patch.eventType !== undefined) body.eventTypeDTO = { typeId: patch.eventType.typeId, typeKey: patch.eventType.typeKey };
    if (patch.privacy !== undefined) body.accessControlRuleDTO = privacyRule(patch.privacy);
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

  /** `activityTypeDTO` of a type the caller resolved, else of `typeKey` looked up in the type list. */
  async #activityTypeDTO(typeKey: string | undefined, resolved: s.ActivityType | undefined) {
    let t = resolved;
    if (t === undefined) {
      const types = await this.getActivityTypes();
      t = types.find((x) => x.typeKey === typeKey);
      if (!t) {
        const valid = types.map((x) => x.typeKey).filter(Boolean).toSorted().join(', ');
        throw new InputError(`Unknown activity type "${typeKey}". Valid keys: ${valid}`);
      }
    }
    return { typeId: t.typeId, typeKey: t.typeKey, parentTypeId: t.parentTypeId };
  }

  /**
   * Adds a manual activity and returns its id. Garmin computes calories from the type, the
   * duration and the profile (`autoCalcCalories`). Path and body follow the known shape of the
   * Garmin Connect API; not confirmed by a recording yet (E8-30).
   */
  async createManualActivity(a: ManualActivity): Promise<number> {
    if (!(a.durationS > 0)) throw new InputError('duration must be positive');
    if (a.distanceM !== undefined && !(a.distanceM > 0)) throw new InputError('distance must be positive');
    const summary: Record<string, unknown> = { startTimeLocal: `${a.startLocal}.000`, duration: a.durationS };
    if (a.distanceM !== undefined) summary.distance = a.distanceM;
    const path = '/activity-service/activity';
    const created = await this.http.request('POST', path, {
      json: {
        activityTypeDTO: await this.#activityTypeDTO(a.typeKey, a.activityType),
        accessControlRuleDTO: privacyRule(a.privacy),
        timeZoneUnitDTO: { unitKey: a.timeZone },
        activityName: a.name,
        metadataDTO: { autoCalcCalories: true },
        summaryDTO: summary,
      },
    });
    const id = (created as { activityId?: unknown } | null)?.activityId;
    // The activity may exist even when its id is missing from the answer, so a retry could add it twice.
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
      throw new GarminError('VALIDATION', `Unexpected response shape from ${path}: no activityId`, {
        hint: 'The activity may have been added anyway: check get_activities for its day before adding it again.',
      });
    }
    return id;
  }

  /**
   * Uploads a FIT, GPX or TCX file as a new activity (`POST /upload-service/upload`, multipart
   * field `file`; Garmin tells the format by the file name). A 409 is a duplicate, not an error.
   * Shape of the answer (`detailedImportResult`) not confirmed by a recording yet (E8-30).
   */
  async uploadActivityFile(fileName: string, data: Uint8Array): Promise<UploadResult> {
    const ext = /\.([^.]+)$/.exec(fileName)?.[1]?.toLowerCase();
    if (!ext || !(UPLOAD_FORMATS as readonly string[]).includes(ext)) throw new InputError(`${fileName}: only ${UPLOAD_FORMATS.map((f) => `.${f}`).join(', ')} files can be uploaded`);
    const form = new FormData();
    form.append('file', new Blob([data as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }), fileName.split(/[\\/]/).pop() ?? fileName);
    const res = await this.http.upload('/upload-service/upload', form, [409]);
    const result = (res.body as { detailedImportResult?: ImportResult } | null)?.detailedImportResult ?? {};
    const failure = result.failures?.[0];
    const message = (failure?.messages ?? []).map((m) => m.content).filter((c): c is string => typeof c === 'string').join('; ');
    if (res.status === 409) {
      const id = failure?.internalId;
      return { status: 'duplicate', ...(isId(id) && { activityId: id }), message: message || 'Duplicate Activity.' };
    }
    const id = result.successes?.[0]?.internalId;
    if (isId(id)) return { status: 'created', activityId: id };
    if (failure) return { status: 'failed', message: message || 'Garmin refused the file' };
    return { status: 'processing' };
  }

  /**
   * Replaces every exercise set of a strength activity with `sets` (Garmin's `exerciseSets`
   * items, rest sets included). Path and body mirror the read; not confirmed by a recording yet (E8-30).
   */
  async updateActivityExerciseSets(id: number, sets: readonly Record<string, unknown>[]): Promise<void> {
    const activityId = positive(id);
    await this.http.request('PUT', `/activity-service/activity/${activityId}/exerciseSets`, { json: { activityId, exerciseSets: sets } });
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

  /** Readings from `from` to `to`. Path confirmed by a recording (E8-2). */
  async getBloodPressure(from: IsoDate, to: IsoDate = from): Promise<unknown> {
    return this.http.request('GET', `/bloodpressure-service/bloodpressure/range/${assertIsoDate(from)}/${assertIsoDate(to)}`, {
      query: { includeAll: true },
      schema: s.bloodPressureRangeSchema,
    });
  }

  /** Events of one day (sleep, naps, activities, stress) as Body Battery shows them. Path confirmed by a recording (E8-2). */
  async getDailyEvents(date: IsoDate): Promise<unknown> {
    return this.http.request('GET', '/wellness-service/wellness/dailyEvents', {
      query: { calendarDate: assertIsoDate(date) },
      schema: s.dailyEventsSchema,
    });
  }

  /** Food log of one day with its calorie and macro totals. Path confirmed by a recording (E8-2). */
  async getNutritionDay(date: IsoDate): Promise<unknown> {
    return this.http.request('GET', `/nutrition-service/food/logs/${assertIsoDate(date)}`, { schema: s.nutritionDaySchema });
  }

  /** Menstrual cycle day view. Path confirmed by a recording (E8-2). */
  async getMenstrualDay(date: IsoDate): Promise<unknown> {
    return this.http.request('GET', `/periodichealth-service/menstrualcycle/dayview/${assertIsoDate(date)}`, {
      schema: s.menstrualDaySchema,
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

  /** Running lactate threshold heart rate per day. Path and query confirmed by a recording (E8-2). */
  async getLactateThresholdHeartRate(from: IsoDate, to: IsoDate): Promise<unknown> {
    return this.http.request(
      'GET',
      `/biometric-service/stats/lactateThresholdHeartRate/range/${assertIsoDate(from)}/${assertIsoDate(to)}`,
      { query: LACTATE_QUERY, schema: s.lactateThresholdRangeSchema },
    );
  }

  /** Running lactate threshold speed per day. Path and query confirmed by a recording (E8-2). */
  async getLactateThresholdSpeed(from: IsoDate, to: IsoDate): Promise<unknown> {
    return this.http.request(
      'GET',
      `/biometric-service/stats/lactateThresholdSpeed/range/${assertIsoDate(from)}/${assertIsoDate(to)}`,
      { query: LACTATE_QUERY, schema: s.lactateThresholdRangeSchema },
    );
  }

  /** Latest cycling FTP with the date Garmin set it. Path confirmed by a recording (E8-2). */
  async getCyclingFtp(): Promise<unknown> {
    return this.http.request('GET', '/biometric-service/biometric/latestFunctionalThresholdPower/CYCLING', {
      schema: s.cyclingFtpSchema,
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

  // ------------------------------------------------------------ training plans, goals, courses, badges
  // Paths below are confirmed by a recording (E8-2), except the phased plan.

  /** Training plans of the account (Garmin Coach, adaptive, phased). */
  async listTrainingPlans(): Promise<unknown> {
    return this.http.request('GET', '/trainingplan-service/trainingplan/plans', { schema: s.trainingPlansSchema });
  }

  /** A phased training plan with its phases and target event. Path not confirmed by a recording yet: the account has no phased plan. */
  async getTrainingPlan(id: number): Promise<unknown> {
    return this.http.request('GET', `/trainingplan-service/trainingplan/phased/${positive(id)}`, { schema: s.trainingPlanSchema });
  }

  /** An adaptive (Garmin Coach) training plan. */
  async getAdaptiveTrainingPlan(id: number): Promise<unknown> {
    return this.http.request('GET', `/trainingplan-service/trainingplan/fbt-adaptive/${positive(id)}`, {
      schema: s.trainingPlanSchema,
    });
  }

  async getGoals(status: 'active' | 'future' | 'past' = 'active'): Promise<unknown> {
    return this.http.request('GET', '/goal-service/goal/goals', { query: { status, start: 1, limit: 100 }, schema: s.goalsSchema });
  }

  async listCourses(): Promise<unknown> {
    return this.http.request('GET', '/course-service/course', { schema: s.coursesSchema });
  }

  async getCourse(id: number): Promise<unknown> {
    return this.http.request('GET', `/course-service/course/${positive(id)}`, { schema: s.courseSchema });
  }

  async getEarnedBadges(): Promise<unknown> {
    return this.http.request('GET', '/badge-service/badge/earned', { schema: s.earnedBadgesSchema });
  }

  /** Badge challenges joined and not completed yet, with progress. */
  async getBadgeChallengesInProgress(): Promise<unknown> {
    return this.http.request('GET', '/badgechallenge-service/badgeChallenge/non-completed', {
      query: { start: 1, limit: 100 },
      schema: s.badgeChallengesSchema,
    });
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

  /** Put a gear item on an activity. Garmin answers with the gear item. */
  async linkGear(uuid: string, activityId: number): Promise<void> {
    await this.http.request('PUT', `/gear-service/gear/link/${uuidOf(uuid)}/activity/${positive(activityId)}`);
  }

  /** Take a gear item off an activity. */
  async unlinkGear(uuid: string, activityId: number): Promise<void> {
    await this.http.request('PUT', `/gear-service/gear/unlink/${uuidOf(uuid)}/activity/${positive(activityId)}`);
  }

  // ------------------------------------------------------------ weight and body composition

  async getWeighIns(from: IsoDate, to: IsoDate): Promise<s.WeighIns> {
    return this.http.request('GET', `/weight-service/weight/range/${assertIsoDate(from)}/${assertIsoDate(to)}`, {
      query: { includeAll: true },
      schema: s.weighInsSchema,
    });
  }

  /** Adds a manual weigh-in at `at` (default now; a bare Date is read in the process' time zone). */
  async addWeighIn(kg: number, at: Date | MeasuredAt = new Date()): Promise<unknown> {
    if (!(kg > 0)) throw new InputError('weight must be positive');
    const when = at instanceof Date ? { local: localTimestamp(at), utc: at } : { local: `${at.local.slice(0, 19)}.000`, utc: at.utc };
    return this.http.request('POST', '/weight-service/user-weight', {
      json: {
        dateTimestamp: when.local,
        gmtTimestamp: when.utc.toISOString().slice(0, 23),
        unitKey: 'kg',
        sourceType: 'MANUAL',
        value: kg,
      },
    });
  }

  // ------------------------------------------------------------ blood pressure and hydration

  /**
   * Adds a manual blood pressure reading, mmHg (pulse in bpm left out when not given).
   * Path and body as python-garminconnect sends them; not confirmed by a recording yet (E8-30).
   */
  async addBloodPressure(m: { systolic: number; diastolic: number; pulse?: number; notes?: string; at: MeasuredAt }): Promise<unknown> {
    if (!(m.systolic > m.diastolic && m.diastolic > 0)) throw new InputError('systolic must be higher than diastolic, both positive');
    return this.http.request('POST', '/bloodpressure-service/bloodpressure', {
      json: {
        measurementTimestampLocal: `${m.at.local.slice(0, 19)}.00`,
        measurementTimestampGMT: `${m.at.utc.toISOString().slice(0, 19)}.00`,
        systolic: m.systolic,
        diastolic: m.diastolic,
        ...(m.pulse !== undefined && { pulse: m.pulse }),
        sourceType: 'MANUAL',
        notes: m.notes ?? '',
      },
    });
  }

  /**
   * Adds `ml` of water to the day of `at`. Garmin answers with the day's hydration summary.
   * Path and body as python-garminconnect sends them; not confirmed by a recording yet (E8-30).
   */
  async addHydration(ml: number, at: MeasuredAt): Promise<unknown> {
    if (!(ml > 0)) throw new InputError('water must be a positive number of ml');
    return this.http.request('PUT', '/usersummary-service/usersummary/hydration/log', {
      json: { calendarDate: assertIsoDate(at.local.slice(0, 10)), timestampLocal: `${at.local.slice(0, 19)}.000`, valueInML: ml },
      schema: s.hydrationDaySchema,
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

  /** Daily solar gain of a solar-charging device. Path confirmed by a recording (E8-2). */
  async getDeviceSolar(deviceId: number, from: IsoDate, to: IsoDate = from): Promise<unknown> {
    return this.http.request('GET', `/web-gateway/solar/${positive(deviceId)}/${assertIsoDate(from)}/${assertIsoDate(to)}`, {
      query: { singleDayView: from === to },
      schema: s.deviceSolarSchema,
    });
  }
}


interface ImportResult {
  successes?: { internalId?: unknown }[];
  failures?: { internalId?: unknown; messages?: { content?: unknown }[] }[];
}

const isId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

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
