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
 * `user-settings`, `weigh-ins`, `calendar-month` and `heart-rate-zones`:
 * weight, bone and muscle mass in grams, height in cm, body fat and water in %,
 * `difference` (a calendar weigh-in's change) in grams, FTP in W, HRmax and
 * resting heart rate of the zones in bpm, lactate threshold heart rate in bpm
 * and speed as Garmin gives it, VO2max (also in `max-metrics`), and the ages of
 * `fitness-age` in years: the age is the one in 2026 of the `birthDate`
 * anonymize writes (1990-01-01), the fitness ages are fixed too, so neither
 * the real ones nor their ratio to the age can be read back (`fitnessAge` of
 * `max-metrics` as well). Zone floors are scaled to the neutral FTP or HRmax
 * (see scaleZoneFloors), and a threshold's history to the neutral value (see
 * THRESHOLD_HISTORY). Time series (heart rate, sleep, HRV, stress) stay.
 */
const BODY_VALUES = new Map<string, number>([
  ['weight', 70000], ['height', 175], ['bmi', 22.9], ['bodyFat', 20], ['bodyWater', 55], ['boneMass', 3000],
  ['muscleMass', 30000], ['metabolicAge', 35], ['visceralFat', 10], ['physiqueRating', 5], ['weightDelta', 0],
  ['difference', 0], ['functionalThresholdPower', 200], ['maxHeartRateUsed', 175], ['restingHeartRateUsed', 50],
  ['chronologicalAge', 36], ['fitnessAge', 30.5], ['previousFitnessAge', 30.6], ['achievableFitnessAge', 29],
]);
/** Prefixes for the variants per sport: `vo2MaxRunning`, `vo2MaxPreciseValue`, `lactateThresholdHeartRateCycling`. */
const BODY_PREFIXES: [RegExp, number][] = [[/^vo2Max/, 50], [/^lactateThresholdHeartRate/, 160], [/^lactateThresholdSpeed/, 0.35]];
/** In a list of sets (`exerciseSets`), `weight` is the load lifted, not the owner's. */
const SETS = /sets$/i;
/**
 * `fitness-age` gives what the fitness age is computed from as `components`,
 * each a `{ value }` under its own key: body fat in % and resting heart rate in
 * bpm become the neutral values of BODY_VALUES; the averages of vigorous days
 * and minutes stay, like the intensity minutes of the daily summary.
 */
const COMPONENT_VALUES = new Map([['bodyFat', 'bodyFat'], ['rhr', 'restingHeartRateUsed']]);
function bodyValue(key: string, parent: string): number | undefined {
  if (SETS.test(parent)) return undefined;
  if (key === 'value') {
    const component = COMPONENT_VALUES.get(parent);
    return component === undefined ? undefined : BODY_VALUES.get(component);
  }
  return BODY_VALUES.get(key) ?? BODY_PREFIXES.find(([re]) => re.test(key))?.[1];
}

/** `zone1Floor`..`zone7Floor` of a power zone set (`power-zones`) in W, of a heart rate zone set (`heart-rate-zones`) in bpm. */
const ZONE_FLOOR = /^zone\d+Floor$/;
/** What the floors of a zone set are relative to: FTP for power zones, HRmax for heart rate zones. */
const ZONE_ANCHORS = ['functionalThresholdPower', 'maxHeartRateUsed'];
/**
 * Zone floors are percentages of FTP (power) or of HRmax (heart rate), so the
 * real value could be read back from them (power zone 5 starts at about
 * 105 % FTP). In an object with a numeric `functionalThresholdPower`, or else
 * `maxHeartRateUsed`, every non-zero floor is scaled by the neutral value of
 * BODY_VALUES over the real one; a zero (a zone the sport does not use) stays.
 * An object with neither stays.
 */
function scaleZoneFloors(value: object): object {
  const record = value as Record<string, unknown>;
  const anchor = ZONE_ANCHORS.find((k) => {
    const v = record[k];
    return typeof v === 'number' && v > 0;
  });
  if (anchor === undefined) return value;
  const factor = (BODY_VALUES.get(anchor) as number) / (record[anchor] as number);
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, ZONE_FLOOR.test(k) && typeof v === 'number' && v !== 0 ? Math.round(v * factor) : v]),
  );
}

/**
 * Scale the non-zero numbers under `key` in a list by one factor, so that the
 * one `anchor` picks becomes `neutral`: the ratios between them stay, the
 * absolute values do not. Whole numbers stay whole, others keep six decimals.
 * Anything else stays.
 */
function scaleList(value: unknown, key: string, anchor: (values: number[]) => number, neutral: number): unknown {
  if (!Array.isArray(value)) return value;
  const of = (item: unknown): unknown => (item && typeof item === 'object' ? (item as Record<string, unknown>)[key] : undefined);
  const nonZero = value.map(of).filter((v): v is number => typeof v === 'number' && v > 0);
  if (nonZero.length === 0) return value;
  const factor = neutral / anchor(nonZero);
  const round = Number.isInteger(neutral) ? Math.round : (v: number) => Math.round(v * 1e6) / 1e6;
  return value.map((item) => {
    const v = of(item);
    return typeof v === 'number' && v > 0 ? { ...(item as object), [key]: round(v * factor) } : item;
  });
}

/** Recordings whose `zoneLowBoundary` list is in W of the owner's power zones (time in zone of an activity). */
const POWER_ZONE_BOUNDARIES = new Set(['activity-power-zones']);
/** The lowest non-zero boundary after scaling, in W. */
const NEUTRAL_LOWEST_BOUNDARY = 100;
/**
 * An activity's power zones (`activity-power-zones`) come without FTP, but their
 * `zoneLowBoundary` values are the same percentages of it as the profile's
 * zone floors, so the real FTP could be read back. Every non-zero boundary is
 * scaled by one factor for the whole list, so that the lowest non-zero one is
 * NEUTRAL_LOWEST_BOUNDARY: the ratios between zones stay, the absolute value
 * does not. A zero stays, and so does `secsInZone`. Heart rate zones of an
 * activity (`activity-hr-zones`) have the same shape and are not passed here.
 */
const scaleZoneBoundaries = (value: unknown): unknown => scaleList(value, 'zoneLowBoundary', (b) => Math.min(...b), NEUTRAL_LOWEST_BOUNDARY);

/**
 * Recordings of a threshold's history (a list of `{ from, value }`, oldest
 * first) with the neutral value of their threshold: lactate threshold heart
 * rate in bpm and speed as Garmin gives it (see BODY_PREFIXES). Every value is
 * scaled by one factor, so that the latest one is the neutral value, as in the
 * profile: dates, number of entries and the direction of each change stay.
 */
const THRESHOLD_HISTORY = new Map([
  ['lactate-threshold-range', bodyValue('lactateThresholdHeartRate', '') as number],
  ['lactate-threshold-speed-range', bodyValue('lactateThresholdSpeed', '') as number],
]);
const scaleThresholdHistory = (value: unknown, neutral: number): unknown => scaleList(value, 'value', (v) => v.at(-1) as number, neutral);

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
 * names the owner gave are replaced, and body measurements, the profile's
 * thresholds and VO2max, the age and fitness age with the body fat and resting
 * heart rate behind it become neutral constants (see BODY_VALUES and
 * COMPONENT_VALUES), power and heart rate zone floors scaled to the neutral
 * FTP and HRmax, with `powerZoneBoundaries` an activity's power zone
 * boundaries scaled too (see scaleZoneBoundaries) and with `thresholdHistory`
 * a threshold's history (see THRESHOLD_HISTORY); time series stay.
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
  let input = options.powerZoneBoundaries ? scaleZoneBoundaries(value) : value;
  if (options.thresholdHistory !== undefined) input = scaleThresholdHistory(input, options.thresholdHistory);
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const out = Object.fromEntries(
      Object.entries(scaleZoneFloors(input)).map(([k, v]) => [idAsKey(k, ctx), k === 'id' && typeof v === 'number' ? 90001 : scrub(v, k, ctx, '')]),
    );
    return scrubMetricRows(out, shift);
  }
  return scrub(input, '', ctx, '');
}

export interface AnonymizeOptions {
  /** Replace every `name` string too: plan, course, course point, goal and event names. */
  names?: boolean;
  /** Replace every string but enum-like constants, dates, timestamps and type and unit names. */
  unknownShape?: boolean;
  /** Secret behind the fake ids (`recordSalt`); a random one when left out. */
  salt?: string;
  /** Scale the `zoneLowBoundary` list of an activity's power zones (see scaleZoneBoundaries). */
  powerZoneBoundaries?: boolean;
  /** Scale a threshold's history so that its latest `value` is this one (see THRESHOLD_HISTORY). */
  thresholdHistory?: number;
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
    return Object.fromEntries(Object.entries(scaleZoneFloors(value)).map(([k, v]) => [idAsKey(k, ctx), scrub(v, k, ctx, key)]));
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
  const anonymized = anonymize(data, shift, {
    names: NAMED_BY_OWNER.has(name),
    unknownShape: UNKNOWN_SHAPE.has(name),
    salt,
    powerZoneBoundaries: POWER_ZONE_BOUNDARIES.has(name),
    thresholdHistory: THRESHOLD_HISTORY.get(name),
  });
  fs.writeFileSync(file, `${JSON.stringify(anonymized, null, 2)}\n`);
  return { file, textKeys: textKeys(anonymized) };
}
