import { hms, pacePerKm, round } from './format.js';

/**
 * Pure mappers for the overview and laps of `get_activity`: running dynamics, respiration,
 * stamina, the Training Effect label, run/walk/stand time and the heart-rate source. Inputs
 * are Garmin's raw `activity/{id}` response (`summaryDTO`, `splitSummaries`, `metadataDTO`)
 * and its `lapDTOs`, read defensively like the other activity sections. Field names were
 * checked against recorded runs with a watch alone and with an HRM-Pro strap.
 */

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
const positive = (v: unknown): number | undefined => {
  const n = num(v);
  return n !== undefined && n > 0 ? n : undefined;
};

export interface RunningDynamics {
  cadence_spm?: number;
  gct_ms?: number;
  /** Left share of ground contact time, %; 50 is balanced. */
  gct_balance_left_pct?: number;
  vertical_oscillation_cm?: number;
  vertical_ratio_pct?: number;
  stride_m?: number;
}

/**
 * Running dynamics of a `summaryDTO` or one lap (same keys): `averageRunCadence` (spm),
 * `groundContactTime` (ms), `groundContactBalanceLeft` (%), `verticalOscillation` (cm),
 * `verticalRatio` (%), `strideLength` (cm). Garmin reports 0 for a metric the sensors did not
 * measure, so zeros are dropped. `undefined` when nothing beyond cadence is there.
 */
export function runningDynamics(raw: unknown): RunningDynamics | undefined {
  const s = obj(raw);
  if (!s) return undefined;
  const stride = positive(s.strideLength);
  const out: RunningDynamics = {
    gct_ms: round(positive(s.groundContactTime), 0),
    gct_balance_left_pct: round(positive(s.groundContactBalanceLeft), 1),
    vertical_oscillation_cm: round(positive(s.verticalOscillation), 1),
    vertical_ratio_pct: round(positive(s.verticalRatio), 1),
    stride_m: stride === undefined ? undefined : round(stride / 100, 2),
  };
  if (Object.values(out).every((v) => v === undefined)) return undefined;
  return { cadence_spm: round(positive(s.averageRunCadence), 0), ...out };
}

export interface Respiration {
  avg_brpm?: number;
  min_brpm?: number;
  max_brpm?: number;
}

/** Breathing rate (breaths/min) of a `summaryDTO` or lap: `avg/min/maxRespirationRate`. */
export function respiration(raw: unknown): Respiration | undefined {
  const s = obj(raw);
  const avg = round(positive(s?.avgRespirationRate), 1);
  if (avg === undefined) return undefined;
  return { avg_brpm: avg, min_brpm: round(positive(s?.minRespirationRate), 1), max_brpm: round(positive(s?.maxRespirationRate), 1) };
}

export interface Stamina {
  start_pct?: number;
  end_pct?: number;
  /** Lowest available stamina during the activity, %. */
  min_available_pct?: number;
}

/** Garmin stamina (`begin/endPotentialStamina`, `minAvailableStamina`, all %); `undefined` without it. */
export function stamina(raw: unknown): Stamina | undefined {
  const s = obj(raw);
  const start = num(s?.beginPotentialStamina);
  if (start === undefined) return undefined;
  return { start_pct: round(start, 0), end_pct: round(num(s?.endPotentialStamina), 0), min_available_pct: round(num(s?.minAvailableStamina), 0) };
}

/** `IMPROVING_AEROBIC_BASE_8` → `improving_aerobic_base`: the trailing number only picks Garmin's message text. */
const teKey = (v: unknown) =>
  str(v)
    ?.replace(/_\d+$/, '')
    .toLowerCase();

export interface TrainingEffectText {
  /** Primary benefit, e.g. `aerobic_base`, `tempo`, `lactate_threshold`, `vo2max`, `anaerobic_capacity`, `recovery`. */
  label?: string;
  aerobic_message?: string;
  anaerobic_message?: string;
}

/** Training Effect label and messages of a `summaryDTO` (`trainingEffectLabel`, `aerobic/anaerobicTrainingEffectMessage`). */
export function trainingEffectText(raw: unknown): TrainingEffectText {
  const s = obj(raw);
  return { label: teKey(s?.trainingEffectLabel), aerobic_message: teKey(s?.aerobicTrainingEffectMessage), anaerobic_message: teKey(s?.anaerobicTrainingEffectMessage) };
}

/** Grade adjusted pace of a `summaryDTO` or lap (`avgGradeAdjustedSpeed`, m/s) as "m:ss /km". */
export function gapPace(raw: unknown): string | undefined {
  return pacePerKm(positive(obj(raw)?.avgGradeAdjustedSpeed));
}

export interface MotionTime {
  run?: string;
  run_pct?: number;
  walk?: string;
  walk_pct?: number;
  stand?: string;
  stand_pct?: number;
}

const MOTION: Record<string, 'run' | 'walk' | 'stand' | undefined> = { RWD_RUN: 'run', RWD_WALK: 'walk', RWD_STAND: 'stand' };

/**
 * Time running, walking and standing from `splitSummaries` (`splitType` RWD_RUN, RWD_WALK,
 * RWD_STAND, `duration` s), with shares of their sum. `undefined` without those splits.
 */
export function motionTime(splitSummaries: unknown): MotionTime | undefined {
  const secs: Partial<Record<'run' | 'walk' | 'stand', number>> = {};
  for (const s of (Array.isArray(splitSummaries) ? splitSummaries : []).map(obj)) {
    const key = MOTION[str(s?.splitType) ?? ''];
    const d = num(s?.duration);
    if (key && d !== undefined) secs[key] = (secs[key] ?? 0) + d;
  }
  const total = (secs.run ?? 0) + (secs.walk ?? 0) + (secs.stand ?? 0);
  if (!(total > 0)) return undefined;
  const out: MotionTime = {};
  for (const key of ['run', 'walk', 'stand'] as const) {
    const d = secs[key];
    if (d === undefined) continue;
    out[key] = hms(d);
    out[`${key}_pct` as const] = round((d / total) * 100, 0);
  }
  return out;
}

export interface HrSensor {
  manufacturer?: string;
  connection?: 'ant+' | 'ble';
  battery_pct?: number;
  battery_status?: string;
}

/**
 * Where the heart rate came from, from `metadataDTO.sensors`: `external_sensor` when a paired
 * sensor of type HEART_RATE (ANT+ `antplusDeviceType` or BLE `bleDeviceType`) is listed, with
 * its manufacturer, connection and battery; `watch_optical` when the list exists without one.
 * Garmin does not say whether an external sensor is a chest strap or an arm band. `undefined`
 * without a sensor list (manual or imported activities) or without heart rate.
 */
export function hrSource(metadata: unknown, hasHr: boolean): { hr_source?: 'external_sensor' | 'watch_optical'; hr_sensor?: HrSensor } {
  const sensors = obj(metadata)?.sensors;
  if (!hasHr || !Array.isArray(sensors)) return {};
  const hr = sensors.map(obj).find((s) => str(s?.antplusDeviceType) === 'HEART_RATE' || str(s?.bleDeviceType) === 'HEART_RATE');
  if (!hr) return { hr_source: 'watch_optical' };
  return {
    hr_source: 'external_sensor',
    hr_sensor: {
      manufacturer: str(hr.manufacturer)?.toLowerCase(),
      connection: str(hr.bleDeviceType) ? 'ble' : 'ant+',
      battery_pct: num(hr.batteryLevel),
      battery_status: str(hr.batteryStatus)?.toLowerCase(),
    },
  };
}

/** Keys of `metadataDTO` that identify the user, their photos or the device. */
const META_PRIVATE = ['userInfoDto', 'activityImages', 'agentApplicationInstallationId', 'deviceApplicationInstallationId', 'videoUrl'];
const SUMMARY_GPS = ['startLatitude', 'startLongitude', 'endLatitude', 'endLongitude'];
/** Stream metrics with the GPS track; dropped from `stream` when redacting. */
export const GPS_STREAM_METRICS: ReadonlySet<string> = new Set(['directLatitude', 'directLongitude']);

/**
 * Copy of Garmin's raw `activity/{id}` response without personal data, for `raw_summary`:
 * the user's name, profile id and photo URLs (`userProfileId`, `metadataDTO.userInfoDto`),
 * activity photos, install ids, the device id, sensor serial numbers, the start and end GPS
 * position and the activity's time zone (`timeZoneUnitDTO`, a coarse location that may differ
 * from GARMIN_TIMEZONE). Everything else is kept as Garmin sent it.
 */
export function redactActivityRaw(raw: unknown): Record<string, unknown> | undefined {
  const a = obj(raw);
  if (!a) return undefined;
  const { userProfileId: _user, timeZoneUnitDTO: _tz, ...rest } = a;
  const out: Obj = { ...rest };
  const summary = obj(a.summaryDTO);
  if (summary) out.summaryDTO = Object.fromEntries(Object.entries(summary).filter(([k]) => !SUMMARY_GPS.includes(k)));
  const meta = obj(a.metadataDTO);
  if (meta) {
    const m: Obj = Object.fromEntries(Object.entries(meta).filter(([k]) => !META_PRIVATE.includes(k)));
    const device = obj(meta.deviceMetaDataDTO);
    if (device) m.deviceMetaDataDTO = Object.fromEntries(Object.entries(device).filter(([k]) => k !== 'deviceId'));
    if (Array.isArray(meta.sensors)) m.sensors = meta.sensors.map((s) => (obj(s) ? Object.fromEntries(Object.entries(s as Obj).filter(([k]) => k !== 'serialNumber')) : s));
    out.metadataDTO = m;
  }
  return out;
}
