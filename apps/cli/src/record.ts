import type { GarminClient } from 'garmin-mcp-client';
import { InputError } from 'garmin-mcp-config';
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
};

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
const COORDS = /^(min|max|start|end|direct)?(lat|lon|latitude|longitude)$/i;
/** Profile photo URLs and file names (`ownerProfileImageUrlSmall`, `profileImgNameMedium`, ...). */
const PROFILE_IMAGE = /profileimage|profileimg/i;
/** Uploaded photos under any key, e.g. a device's `imageUrl`. */
const UPLOADED_IMAGE = /\/profile_images\//;

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
 * too (see DEVICE_IDENTIFIERS).
 */
export function anonymize(value: unknown, shift: CoordinateShift = { lat: Math.random(), lon: Math.random() }): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'id' && typeof v === 'number' ? 90001 : scrub(v, k, shift)]));
    return scrubMetricRows(out, shift);
  }
  return scrub(value, '', shift);
}

function coordinate(value: number, key: string, shift: CoordinateShift): number {
  const by = /lat/i.test(key) ? shift.lat : shift.lon;
  return Math.round((((value % 1) + by) % 1) * 1e5) / 1e5;
}

function scrubMetricRows(out: Record<string, unknown>, shift: CoordinateShift): Record<string, unknown> {
  const { metricDescriptors: descriptors, activityDetailMetrics: rows } = out;
  if (!Array.isArray(descriptors) || !Array.isArray(rows)) return out;
  const columns = new Map<number, string>();
  for (const d of descriptors as { metricsIndex?: unknown; key?: unknown }[]) {
    if (typeof d.metricsIndex === 'number' && typeof d.key === 'string' && COORDS.test(d.key)) columns.set(d.metricsIndex, d.key);
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

function scrub(value: unknown, key: string, shift: CoordinateShift): unknown {
  if (Array.isArray(value)) return value.map((v) => scrub(v, key, shift));
  if (key === 'weatherStationDTO' && value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, typeof v === 'string' ? 'anon-weatherStation' : scrub(v, k, shift)]),
    );
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, k, shift)]));
  }
  if (DEVICE_IDENTIFIERS.test(key) && (typeof value === 'string' || typeof value === 'number')) return typeof value === 'number' ? 90002 : `anon-${key}`;
  if (typeof value === 'string' && PERSONAL_STRINGS.has(key.toLowerCase())) return key === 'birthDate' ? '1990-01-01' : `anon-${key}`;
  if (typeof value === 'string' && (PROFILE_IMAGE.test(key) || UPLOADED_IMAGE.test(value))) return `anon-${key}`;
  if (typeof value === 'string' && /[\w.+-]+@[\w-]+\.[\w.]+/.test(value)) return value.replaceAll(/[\w.+-]+@[\w-]+\.[\w.]+/g, 'anon@example.com');
  if (typeof value === 'number' && PERSONAL_IDS.has(key)) return 90001;
  if (typeof value === 'number' && COORDS.test(key)) return coordinate(value, key, shift);
  return value;
}

export function writeFixture(dir: string, name: string, data: unknown): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, `${JSON.stringify(anonymize(data), null, 2)}\n`);
  return file;
}
