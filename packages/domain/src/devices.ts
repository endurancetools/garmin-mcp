/**
 * Device settings as cached in `devices.settings` (`getDeviceSettings`). Fields
 * are read defensively: the shape is not confirmed by a recording yet (E2-8).
 * Solar days as cached in `devices.solar` (daily sums of `getDeviceSolar`).
 */
import type { SolarDaySummary } from 'garmin-mcp-store';
import { round } from './format.js';

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

export interface DeviceSettingsSummary {
  time_format?: string;
  date_format?: string;
  units?: string;
  key_tones?: boolean;
  key_vibration?: boolean;
  alert_tones?: boolean;
  move_alert?: boolean;
  pulse_ox_sleep?: boolean;
  high_hr_alert?: boolean;
  low_hr_alert?: boolean;
  /** Alarms set on the device, and how many of them are on. */
  alarms?: number;
  alarms_on?: number;
}

/** Dense summary of one device's settings; undefined when there are none. */
export function deviceSettings(raw: unknown): DeviceSettingsSummary | undefined {
  const s = obj(raw);
  if (!s) return undefined;
  const tracking = obj(s.activityTracking) ?? {};
  const alarms = Array.isArray(s.alarms) ? s.alarms.map(obj).filter((a) => a !== undefined) : undefined;
  return {
    time_format: str(s.timeFormat),
    date_format: str(s.dateFormat),
    units: str(s.measurementUnits),
    key_tones: bool(s.keyTonesEnabled),
    key_vibration: bool(s.keyVibrationEnabled),
    alert_tones: bool(s.alertTonesEnabled),
    move_alert: bool(tracking.moveAlertEnabled),
    pulse_ox_sleep: bool(tracking.pulseOxSleepTrackingEnabled),
    high_hr_alert: bool(tracking.highHrAlertEnabled),
    low_hr_alert: bool(tracking.lowHrAlertEnabled),
    alarms: alarms?.length,
    alarms_on: alarms?.filter((a) => a.alarmMode === 'ON').length,
  };
}

export interface DeviceSolarDay {
  date: string;
  /** Garmin's `totalActivityTimeGainedMs` of the day. */
  time_gained_ms?: number;
  /** Minutes with solar input (`solarUtilization` above 0). */
  solar_minutes?: number;
  /** Highest `solarUtilization` of the day; Garmin does not name its unit. */
  peak_solar_utilization?: number;
}

/** Solar days of a solar-charging device, oldest first; undefined for other devices or when the request failed. */
export function deviceSolar(days: readonly SolarDaySummary[] | null): DeviceSolarDay[] | undefined {
  return days?.map((d) => ({
    date: d.date,
    time_gained_ms: d.time_gained_ms ?? undefined,
    solar_minutes: d.solar_minutes ?? undefined,
    peak_solar_utilization: round(d.peak_solar_utilization),
  }));
}
