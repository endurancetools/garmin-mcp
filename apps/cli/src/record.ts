import type { GarminClient } from 'garmin-mcp-client';
import { addDays, InputError } from 'garmin-mcp-config';
import fs from 'node:fs';
import path from 'node:path';

/** Endpoints `garmin record` can capture, named like the client's fixture files. */
export const RECORDABLE: Record<string, (c: GarminClient, a: { date: string; id?: number; uuid?: string }) => Promise<unknown>> = {
  'social-profile': (c) => c.getProfile(),
  'user-settings': (c) => c.getUserSettings(),
  'heart-rate-zones': (c) => c.getHeartRateZones(),
  'power-zones': (c) => c.getPowerZones(),
  activities: (c, a) => c.listActivities({ to: a.date, limit: 5 }),
  activity: (c, a) => c.getActivity(need(a.id, '--id')),
  'activity-splits': (c, a) => c.getActivitySplits(need(a.id, '--id')),
  'activity-hr-zones': (c, a) => c.getActivityHrZones(need(a.id, '--id')),
  'activity-power-zones': (c, a) => c.getActivityPowerZones(need(a.id, '--id')),
  'activity-weather': (c, a) => c.getActivityWeather(need(a.id, '--id')),
  'activity-exercise-sets': (c, a) => c.getActivityExerciseSets(need(a.id, '--id')),
  'activity-details': (c, a) => c.getActivityDetails(need(a.id, '--id'), 50, 50),
  'activity-types': (c) => c.getActivityTypes(),
  'event-types': (c) => c.getEventTypes(),
  'daily-summary': (c, a) => c.getDailySummary(a.date),
  'steps-chart': (c, a) => c.getSteps(a.date),
  'heart-rate-day': (c, a) => c.getHeartRate(a.date),
  'stress-day': (c, a) => c.getStress(a.date),
  'body-battery': (c, a) => c.getBodyBattery(a.date, a.date),
  'respiration-day': (c, a) => c.getRespiration(a.date),
  'spo2-day': (c, a) => c.getSpo2(a.date),
  'intensity-minutes-day': (c, a) => c.getIntensityMinutes(a.date),
  sleep: (c, a) => c.getSleep(a.date),
  hrv: (c, a) => c.getHrv(a.date),
  'training-status': (c, a) => c.getTrainingStatus(a.date),
  'training-readiness': (c, a) => c.getTrainingReadiness(a.date),
  'max-metrics': (c, a) => c.getVo2Max(a.date),
  'race-predictions': (c) => c.getRacePredictions(),
  'fitness-age': (c, a) => c.getFitnessAge(a.date),
  'personal-records': (c) => c.getPersonalRecords(),
  workouts: (c) => c.listWorkouts(0, 5),
  workout: (c, a) => c.getWorkout(need(a.id, '--id')),
  'calendar-month': (c, a) => c.getCalendar(Number(a.date.slice(0, 4)), Number(a.date.slice(5, 7))),
  gear: (c) => c.listGear(),
  'gear-stats': (c, a) => c.getGearStats(need(a.uuid, '--uuid')),
  'weigh-ins': (c, a) => c.getWeighIns(a.date, a.date),
  devices: (c) => c.listDevices(),
  'device-last-used': (c) => c.getLastUsedDevice(),
  'device-settings': (c, a) => c.getDeviceSettings(need(a.id, '--id')),
  // Stage 8 endpoints, recorded in E8-2 (fixtures: E8-2a).
  'activity-typed-splits': (c, a) => c.getActivityTypedSplits(need(a.id, '--id')),
  'activity-split-summaries': (c, a) => c.getActivitySplitSummaries(need(a.id, '--id')),
  'training-plans': (c) => c.listTrainingPlans(),
  'training-plan': (c, a) => c.getTrainingPlan(need(a.id, '--id')),
  'adaptive-plan': (c, a) => c.getAdaptiveTrainingPlan(need(a.id, '--id')),
  'lactate-threshold-range': (c, a) => c.getLactateThresholdHeartRate(addDays(a.date, -365), a.date),
  'lactate-threshold-speed-range': (c, a) => c.getLactateThresholdSpeed(addDays(a.date, -365), a.date),
  'cycling-ftp': (c) => c.getCyclingFtp(),
  'hydration-day': (c, a) => c.getHydration(a.date),
  'blood-pressure-range': (c, a) => c.getBloodPressure(addDays(a.date, -29), a.date),
  'daily-events': (c, a) => c.getDailyEvents(a.date),
  goals: (c) => c.getGoals(),
  courses: (c) => c.listCourses(),
  course: (c, a) => c.getCourse(need(a.id, '--id')),
  'device-solar': (c, a) => c.getDeviceSolar(need(a.id, '--id'), addDays(a.date, -6), a.date),
  'nutrition-day': (c, a) => c.getNutritionDay(a.date),
  'menstrual-day': (c, a) => c.getMenstrualDay(a.date),
  'earned-badges': (c) => c.getEarnedBadges(),
  'badge-challenges': (c) => c.getBadgeChallengesInProgress(),
};

/**
 * Recordings whose every `name` is something the owner chose or a place: plan
 * and target race names, course and course point names, goal and event names.
 */
const NAMED_BY_OWNER = new Set(['training-plans', 'training-plan', 'adaptive-plan', 'courses', 'course', 'goals', 'daily-events']);

/**
 * Stage 8 recordings (E8-1) whose shape nobody has seen yet: blood pressure,
 * nutrition, cycle tracking and the rest may hold text the owner typed under
 * keys no list here knows (notes, foods, meals, symptoms), so every string is
 * replaced except the ones `keepsText` lets through. Older recordings keep the
 * key-based rules, so their fixtures do not change.
 */
export const UNKNOWN_SHAPE: ReadonlySet<string> = new Set([
  'activity-typed-splits', 'activity-split-summaries', 'training-plans', 'training-plan', 'adaptive-plan',
  'lactate-threshold-range', 'lactate-threshold-speed-range', 'cycling-ftp', 'hydration-day', 'blood-pressure-range',
  'daily-events', 'goals', 'courses', 'course', 'device-solar', 'nutrition-day', 'menstrual-day', 'earned-badges',
  'badge-challenges',
]);

function need<T>(v: T | undefined, flag: string): T {
  if (v === undefined) throw new InputError(`this endpoint needs ${flag}`);
  return v;
}

/** Matched case-insensitively: activity metadata spells some of them `displayname`, `fullname`. */
const PERSONAL_STRINGS = new Set(
  [
    'displayName', 'fullName', 'userName', 'emailAddress', 'email', 'garminGUID', 'location', 'firstName', 'lastName',
    'ownerDisplayName', 'ownerFullName', 'birthDate', 'locationName', 'userProfileFullName', 'bio', 'facebookUrl', 'twitterUrl',
    'personalWebsite', 'nickname', 'customUserText',
    // Free text the owner types: activity and workout names, calendar titles and notes name
    // home towns, races with bib numbers and people.
    'activityName', 'workoutName', 'title', 'description',
    // Courses, training plans and races are named after places and events.
    'courseName', 'trainingPlanName', 'planName', 'eventName', 'raceName', 'goalName', 'address', 'city',
    // Notes and food log entries.
    'note', 'notes', 'comment', 'foodName', 'mealName', 'brandName',
  ].map((k) => k.toLowerCase()),
);
/**
 * Keys that hold the account owner's id anywhere in a response. A bare `id` is
 * the owner's only on the response's root object (`social-profile`,
 * `user-settings`); nested `id`s belong to calendar items, records and the like,
 * and collapsing them to one value would merge them on upsert. The daily
 * summary's `userDailySummaryId` is the profile id too.
 */
const PERSONAL_IDS = new Set([
  'profileId', 'userProfilePk', 'userProfilePK', 'userProfileId', 'userProfileNumber', 'ownerId', 'userId', 'customerId', 'userDailySummaryId',
]);
/**
 * Keys that identify a device or its surroundings (device settings and lists):
 * serial numbers, MAC addresses, Wi-Fi network names, IMEI, the device name the
 * owner chose and alarm labels. Matched case-sensitively, so e.g. `classId` is
 * not taken for an SSID.
 */
const DEVICE_IDENTIFIERS = /^(serialNumber|macAddress|ssid|imei|deviceName|customDeviceName|ownerName|alarmMessage)$|(SerialNumber|MacAddress|Ssid|DeviceName)$/;
/** `lat`, `startLongitude`, `maxLat`, and camelCase suffixes such as a course's `lowerLeftLatitude`. */
const COORDS = /^(min|max|start|end|direct)?(lat|lon|lng|latitude|longitude)$/i;
/** Case-sensitive, so `flat` or `salon` are not taken for coordinates. */
const COORD_SUFFIX = /[a-z](Lat|Lon|Lng|Latitude|Longitude)$/;
const isCoordinate = (key: string): boolean => COORDS.test(key) || COORD_SUFFIX.test(key);
/** An encoded track (string), e.g. a course's polyline; the shape alone shows where it is. */
const POLYLINE = /polyline/i;
/** Profile photo URLs and file names (`ownerProfileImageUrlSmall`, `profileImgNameMedium`, ...). */
const PROFILE_IMAGE = /profileimage|profileimg/i;
/** Uploaded photos under any key, e.g. a device's `imageUrl`. */
const UPLOADED_IMAGE = /\/profile_images\//;

/** An enum-like constant such as `RUNNING`, `INTERVAL_ACTIVE` or `5K`. */
const ENUM_CONSTANT = /^[A-Z0-9_]+$/;
/** A date or a timestamp: `2026-10-10`, `2026-10-10T06:15:00.0`, `2026-10-10 06:15:00`, with an optional zone. */
const DATE_OR_TIMESTAMP = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
/** Keys of type and unit names, which Garmin spells in lower case (`running`, `mmHg`, `kilocalorie`). */
const TYPE_AND_UNIT_KEYS = new Set(['typeKey', 'type', 'unit', 'unitKey', 'units', 'unitOfMeasure', 'sportType', 'measurementSystem']);
/** Strings kept in a recording of unknown shape; any other text is replaced. */
const keepsText = (key: string, value: string): boolean =>
  value === '' || ENUM_CONSTANT.test(value) || DATE_OR_TIMESTAMP.test(value) || TYPE_AND_UNIT_KEYS.has(key);

/** Per-recording shift of coordinates, in degrees; it is not stored anywhere. */
export interface CoordinateShift {
  lat: number;
  lon: number;
}

/**
 * Replace personal data with stable placeholders: names, emails, GUIDs and user
 * ids become fixed fakes. Coordinates keep only their fractional part plus a
 * random shift drawn once per recording, so a track keeps its shape near Null
 * Island but neither the whole degrees nor the minutes can be recovered. That
 * includes latitude/longitude columns of activity detail rows, which are
 * positional (`metrics[i]` named by `metricDescriptors`). Activity, workout,
 * device and calendar item ids stay, so fixtures remain internally consistent.
 * A weather station's id and name (e.g. an airport code) would reveal where the
 * activity took place, so every string inside `weatherStationDTO` is replaced.
 * Device serial numbers, MAC addresses, network and device names are replaced
 * too (see DEVICE_IDENTIFIERS). Courses, training plans and races carry place
 * and event names (`courseName`, `eventName`...) and encoded polylines, which
 * are replaced; `names` replaces every `name` as well, for recordings where
 * nothing but the owner names things (see NAMED_BY_OWNER). `unknownShape`
 * replaces every other string too, except enum-like constants, dates,
 * timestamps and type and unit names (see UNKNOWN_SHAPE).
 */
export function anonymize(
  value: unknown,
  shift: CoordinateShift = { lat: Math.random(), lon: Math.random() },
  options: AnonymizeOptions = {},
): unknown {
  const ctx: Scrub = { shift, names: options.names ?? false, unknownShape: options.unknownShape ?? false };
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'id' && typeof v === 'number' ? 90001 : scrub(v, k, ctx)]));
    return scrubMetricRows(out, shift);
  }
  return scrub(value, '', ctx);
}

export interface AnonymizeOptions {
  /** Replace every `name` string too: plan, course, course point, goal and event names. */
  names?: boolean;
  /** Replace every string but enum-like constants, dates, timestamps and type and unit names. */
  unknownShape?: boolean;
}

interface Scrub {
  shift: CoordinateShift;
  names: boolean;
  unknownShape: boolean;
}

function coordinate(value: number, key: string, shift: CoordinateShift): number {
  const by = /lat(itude)?$/i.test(key) ? shift.lat : shift.lon;
  return Math.round((((value % 1) + by) % 1) * 1e5) / 1e5;
}

function scrubMetricRows(out: Record<string, unknown>, shift: CoordinateShift): Record<string, unknown> {
  const { metricDescriptors: descriptors, activityDetailMetrics: rows } = out;
  if (!Array.isArray(descriptors) || !Array.isArray(rows)) return out;
  const columns = new Map<number, string>();
  for (const d of descriptors as { metricsIndex?: unknown; key?: unknown }[]) {
    if (typeof d.metricsIndex === 'number' && typeof d.key === 'string' && isCoordinate(d.key)) columns.set(d.metricsIndex, d.key);
  }
  return {
    ...out,
    activityDetailMetrics: (rows as { metrics?: unknown }[]).map((row) =>
      Array.isArray(row.metrics)
        ? { ...row, metrics: row.metrics.map((m: unknown, i) => (typeof m === 'number' && columns.has(i) ? coordinate(m, columns.get(i) as string, shift) : m)) }
        : row,
    ),
  };
}

function scrub(value: unknown, key: string, ctx: Scrub): unknown {
  const { shift } = ctx;
  if (Array.isArray(value)) return value.map((v) => scrub(v, key, ctx));
  if (key === 'weatherStationDTO' && value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, typeof v === 'string' ? 'anon-weatherStation' : scrub(v, k, ctx)]),
    );
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, k, ctx)]));
  }
  if (typeof value === 'string' && (POLYLINE.test(key) || (ctx.names && key === 'name'))) return `anon-${key}`;
  if (DEVICE_IDENTIFIERS.test(key) && (typeof value === 'string' || typeof value === 'number')) return typeof value === 'number' ? 90002 : `anon-${key}`;
  if (typeof value === 'string' && PERSONAL_STRINGS.has(key.toLowerCase())) return key === 'birthDate' ? '1990-01-01' : `anon-${key}`;
  if (typeof value === 'string' && (PROFILE_IMAGE.test(key) || UPLOADED_IMAGE.test(value))) return `anon-${key}`;
  if (typeof value === 'string' && ctx.unknownShape && !keepsText(key, value)) return `anon-${key}`;
  if (typeof value === 'string' && /[\w.+-]+@[\w-]+\.[\w.]+/.test(value)) return value.replaceAll(/[\w.+-]+@[\w-]+\.[\w.]+/g, 'anon@example.com');
  if (typeof value === 'number' && PERSONAL_IDS.has(key)) return 90001;
  if (typeof value === 'number' && isCoordinate(key)) return coordinate(value, key, shift);
  return value;
}

/** Keys under which a string other than an `anon-` placeholder is left, sorted. */
export function textKeys(value: unknown): string[] {
  const keys = new Set<string>();
  const walk = (v: unknown, key: string): void => {
    if (Array.isArray(v)) for (const item of v) walk(item, key);
    else if (v && typeof v === 'object') for (const [k, item] of Object.entries(v)) walk(item, k);
    else if (typeof v === 'string' && v !== '' && !v.startsWith('anon-')) keys.add(key);
  };
  walk(value, '');
  return [...keys].toSorted();
}

/** Write an anonymized recording; returns the file and the keys where text is left, for review before committing. */
export function writeFixture(dir: string, name: string, data: unknown): { file: string; textKeys: string[] } {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  const shift = { lat: Math.random(), lon: Math.random() };
  const anonymized = anonymize(data, shift, { names: NAMED_BY_OWNER.has(name), unknownShape: UNKNOWN_SHAPE.has(name) });
  fs.writeFileSync(file, `${JSON.stringify(anonymized, null, 2)}\n`);
  return { file, textKeys: textKeys(anonymized) };
}
