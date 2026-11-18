import type { GarminClient } from 'garmin-mcp-client';
import { addDays, assertPrivate, InputError, writePrivateFile } from 'garmin-mcp-config';
import { createHmac, randomBytes } from 'node:crypto';
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
  // Path not confirmed by a recording yet (E8-28c).
  'virtual-challenges': (c) => c.getVirtualChallengesInProgress(),
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
  'badge-challenges', 'virtual-challenges',
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
    // Gear names the owner gave (`customMakeModel`: "ASICS ... 18", "Old blue bike").
    'customMakeModel', 'gearName',
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

/**
 * Keys of account object ids: activities, workouts and their steps, schedules,
 * devices (`deviceId`, `unitId`), gear (`uuid`, `gearPk`), courses, calendar
 * items, badges, plans, records, weigh-ins (`samplePk`) and anything else named
 * `...Id`, `...Pk`, `...Uuid` (also plural, for lists of ids) or a bare `id`,
 * `uuid`, `pk`. The rule goes by the key, not by the recording, so it covers
 * responses of any shape. Case-sensitive, so `valid` or `hybrid` are not ids.
 */
const OBJECT_ID = /^(id|uuid|pk)s?$|[a-z0-9](Id|ID|Pk|PK|Uuid|UUID)s?$/;
/**
 * Dictionary ids, the same for every account, which stay: types (`typeId`,
 * `activityTypeId`, `parentTypeId`, `sportTypeId`, `subTypeId`, `eventTypeId`,
 * `stepTypeId`, `deviceTypePk`, `activityTypePk`, `sleepQualityTypePK`...),
 * classes, categories and statuses (`badgeCategoryId`, `challengeCategoryImageId`,
 * `statusId`, `badgeChallengeStatusId`), levels and difficulties (`levelId`,
 * `badgeDifficultyId`), units (`badgeUnitId`), formats (`formatId`), days and
 * weeks of a plan (`dayId`, `dayOfWeekId`, `weekId`), plan versions
 * (`versionId`), time zones (`timeZoneId`), privacy rules (`rulePK`), languages
 * and locales. A bare `unitId` is a device's and is replaced.
 */
const DICTIONARY_ID =
  /^(type|class|category|status|level|format|day|dayOfWeek|week|version|timeZone|rule|language|locale)(Id|ID|Pk|PK)s?$|(Type|Class|Category|CategoryImage|Status|Level|Difficulty|Format|Unit)(Id|ID|Pk|PK)s?$/;
/**
 * An id inside a unit, type, locale, language or version object is a
 * dictionary id too: `unit: { id: 92 }`, `sectionTypeDTO: { id: 4 }`,
 * `estimatedDistanceUnit: { unitId: 1 }`, `supportedLanguages: [{ id: 0 }]`.
 */
const DICTIONARY_PARENT = /(type|unit|locale|languages?|version)(dto)?$/i;
const isObjectId = (key: string, parent: string): boolean =>
  OBJECT_ID.test(key) && !DICTIONARY_ID.test(key) && !DICTIONARY_PARENT.test(parent);
/** An object keyed by ids, e.g. training status per device (`{ "2730757515": {...} }`); shorter digit keys may be indices. */
const ID_AS_KEY = /^\d{6,}$/;

/** `n` pseudo-random bytes from the HMAC of `text` under `salt`. */
function hmacBytes(salt: string, text: string, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; out.length < n; i++) out.push(...createHmac('sha256', salt).update(`${i}:${text}`).digest());
  return out.slice(0, n);
}

/**
 * A stable fake for an account object id: the HMAC of the value under the
 * recording salt, written in the same format. A positive integer keeps its
 * number of digits (and stays a safe integer), a digit string its length, a
 * hex string or UUID (8 characters or more) its length, dashes and case. The same
 * value gives the same fake in every recording made with the same salt, also
 * when one response has it as a number and another as a string (an activity's
 * `activityId` and a badge's `badgeAssocDataId`), or a UUID with and without
 * dashes. Without the salt the real value cannot be recovered. Zero, negative
 * and fractional numbers and other text are not ids and stay.
 */
export function fakeId<T extends number | string>(value: T, salt: string): T {
  const text = String(value);
  if (typeof value === 'number' ? Number.isSafeInteger(value) && value > 0 : /^\d+$/.test(text)) {
    const bytes = hmacBytes(salt, text, text.length);
    // No leading zero unless the value has one; 16 digits start with 1-8 to stay below 2^53.
    const [low, span] = text.startsWith('0') ? [0, 10] : [1, text.length >= 16 ? 8 : 9];
    const digits = bytes.map((b, i) => (i === 0 ? low + (b % span) : b % 10)).join('');
    return (typeof value === 'number' ? Number(digits) : digits) as T;
  }
  if (typeof value === 'string' && value.length >= 8 && /^[\da-f]+(-[\da-f]+)*$/i.test(value)) {
    const bare = value.replaceAll('-', '').toLowerCase();
    const bytes = hmacBytes(salt, bare, bare.length);
    const upper = /[A-F]/.test(value) && !/[a-f]/.test(value);
    let i = 0;
    const fake = [...value].map((c) => (c === '-' ? c : ((bytes[i++] ?? 0) % 16).toString(16))).join('');
    return (upper ? fake.toUpperCase() : fake) as T;
  }
  return value;
}

/**
 * Body measurements and the profile's single threshold and fitness values,
 * replaced with neutral constants in the same unit, under the keys of
 * `user-settings`, `weigh-ins` and `calendar-month`: weight, bone and muscle
 * mass in grams, height in cm, body fat and water in %, `difference` (a
 * calendar weigh-in's change) in grams, FTP in W, lactate threshold heart rate
 * in bpm and speed as Garmin gives it, VO2max. Time series (heart rate, sleep,
 * HRV, stress) stay.
 */
const BODY_VALUES = new Map<string, number>([
  ['weight', 70000], ['height', 175], ['bmi', 22.9], ['bodyFat', 20], ['bodyWater', 55], ['boneMass', 3000],
  ['muscleMass', 30000], ['metabolicAge', 35], ['visceralFat', 10], ['physiqueRating', 5], ['weightDelta', 0],
  ['difference', 0], ['functionalThresholdPower', 200],
]);
/** Prefixes for the variants per sport: `vo2MaxRunning`, `vo2MaxPreciseValue`, `lactateThresholdHeartRateCycling`. */
const BODY_PREFIXES: [RegExp, number][] = [[/^vo2Max/, 50], [/^lactateThresholdHeartRate/, 160], [/^lactateThresholdSpeed/, 0.35]];
/** In a list of sets (`exerciseSets`), `weight` is the load lifted, not the owner's. */
const SETS = /sets$/i;
function bodyValue(key: string, parent: string): number | undefined {
  if (SETS.test(parent)) return undefined;
  return BODY_VALUES.get(key) ?? BODY_PREFIXES.find(([re]) => re.test(key))?.[1];
}

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
 * positional (`metrics[i]` named by `metricDescriptors`). Ids of the account's
 * objects (activities, workouts, devices, gear, courses, calendar items, badges,
 * plans, records, weigh-ins; see OBJECT_ID) become fakes of the same format
 * from `fakeId` under `salt`: with the salt of the data directory
 * (`recordSalt`) every recording gives a real id the same fake, so fixtures
 * stay consistent with each other; without one, a random salt hides them for
 * this call only. An object key of six or more digits is taken for an id too.
 * Dictionary ids (types, categories, units...; see DICTIONARY_ID) stay. Gear
 * names the owner gave are replaced, and body measurements and the profile's
 * thresholds and VO2max become neutral constants (see BODY_VALUES); time
 * series stay.
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
  const ctx: Scrub = {
    shift,
    names: options.names ?? false,
    unknownShape: options.unknownShape ?? false,
    salt: options.salt ?? randomBytes(32).toString('hex'),
  };
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out = Object.fromEntries(
      Object.entries(value).map(([k, v]) => [idAsKey(k, ctx), k === 'id' && typeof v === 'number' ? 90001 : scrub(v, k, ctx, '')]),
    );
    return scrubMetricRows(out, shift);
  }
  return scrub(value, '', ctx, '');
}

export interface AnonymizeOptions {
  /** Replace every `name` string too: plan, course, course point, goal and event names. */
  names?: boolean;
  /** Replace every string but enum-like constants, dates, timestamps and type and unit names. */
  unknownShape?: boolean;
  /** Secret behind the fake ids (`recordSalt`); a random one when left out. */
  salt?: string;
}

interface Scrub {
  shift: CoordinateShift;
  names: boolean;
  unknownShape: boolean;
  salt: string;
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

const idAsKey = (key: string, ctx: Scrub): string => (ID_AS_KEY.test(key) ? fakeId(key, ctx.salt) : key);

/** `parent` is the key of the object (or list) holding `key`; '' at the top. */
function scrub(value: unknown, key: string, ctx: Scrub, parent: string): unknown {
  const { shift } = ctx;
  if (Array.isArray(value)) return value.map((v) => scrub(v, key, ctx, parent));
  if (key === 'weatherStationDTO' && value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, typeof v === 'string' ? 'anon-weatherStation' : scrub(v, k, ctx, key)]),
    );
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [idAsKey(k, ctx), scrub(v, k, ctx, key)]));
  }
  if (typeof value === 'string' && (POLYLINE.test(key) || (ctx.names && key === 'name'))) return `anon-${key}`;
  if (DEVICE_IDENTIFIERS.test(key) && (typeof value === 'string' || typeof value === 'number')) return typeof value === 'number' ? 90002 : `anon-${key}`;
  if (typeof value === 'string' && PERSONAL_STRINGS.has(key.toLowerCase())) return key === 'birthDate' ? '1990-01-01' : `anon-${key}`;
  if (typeof value === 'string' && (PROFILE_IMAGE.test(key) || UPLOADED_IMAGE.test(value))) return `anon-${key}`;
  if (typeof value === 'number' && PERSONAL_IDS.has(key)) return 90001;
  if ((typeof value === 'number' || typeof value === 'string') && isObjectId(key, parent)) {
    const fake = fakeId(value, ctx.salt);
    if (fake !== value) return fake;
  }
  if (typeof value === 'string' && ctx.unknownShape && !keepsText(key, value)) return `anon-${key}`;
  if (typeof value === 'string' && /[\w.+-]+@[\w-]+\.[\w.]+/.test(value)) return value.replaceAll(/[\w.+-]+@[\w-]+\.[\w.]+/g, 'anon@example.com');
  if (typeof value === 'number') {
    const body = bodyValue(key, parent);
    if (body !== undefined) return body;
  }
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

/** File in the data directory with the secret behind the fake ids of recordings; never in the repository. */
export const RECORD_SALT_FILE = 'record-salt';

/** The salt for fake ids, read from the data directory or created there (0600) by the first recording. */
export function recordSalt(dataDir: string): string {
  const file = path.join(dataDir, RECORD_SALT_FILE);
  if (fs.existsSync(file)) {
    assertPrivate(file, 'file');
    const salt = fs.readFileSync(file, 'utf8').trim();
    if (salt) return salt;
  }
  const salt = randomBytes(32).toString('hex');
  writePrivateFile(file, `${salt}\n`);
  return salt;
}

/** Write an anonymized recording; returns the file and the keys where text is left, for review before committing. */
export function writeFixture(dir: string, name: string, data: unknown, salt: string): { file: string; textKeys: string[] } {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  const shift = { lat: Math.random(), lon: Math.random() };
  const anonymized = anonymize(data, shift, { names: NAMED_BY_OWNER.has(name), unknownShape: UNKNOWN_SHAPE.has(name), salt });
  fs.writeFileSync(file, `${JSON.stringify(anonymized, null, 2)}\n`);
  return { file, textKeys: textKeys(anonymized) };
}
