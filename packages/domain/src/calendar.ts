import { round } from './format.js';

/**
 * Races and events from the Garmin Connect calendar (calendar items of type
 * "event"), as cached in `calendar_events`. Fields are read defensively: the
 * shapes are not confirmed by a recording yet (E2-8).
 */

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

/** Units of `completionTarget.unit` in Connect's custom-event picker. */
const METERS_PER_UNIT: Record<string, number> = { meter: 1, kilometer: 1000, yard: 0.9144, mile: 1609.344 };

export interface CalendarEvent {
  id?: number;
  date?: string;
  title?: string;
  /** Present (true) only for races. */
  race?: true;
  /** Present (true) only for the goal race of an active training plan. */
  primary?: true;
  distance_km?: number;
  start_time?: string;
  time_zone?: string;
  location?: string;
  url?: string;
}

/** One calendar item of type "event". The custom goal time needs a per-event request, so it is not included. */
export function calendarEvent(raw: unknown): CalendarEvent {
  const it = obj(raw) ?? {};
  const target = obj(it.completionTarget);
  const scale = METERS_PER_UNIT[str(target?.unit) ?? ''];
  const value = num(target?.value);
  const time = obj(it.eventTimeLocal);
  return {
    id: num(it.id),
    date: str(it.date),
    title: str(it.title),
    race: it.isRace === true ? true : undefined,
    primary: it.primaryEvent === true ? true : undefined,
    distance_km: target?.unitType === 'distance' && scale !== undefined && value !== undefined ? round((value * scale) / 1000, 2) : undefined,
    start_time: str(time?.startTimeHhMm),
    time_zone: str(time?.timeZoneId),
    location: str(it.location),
    url: str(it.url),
  };
}
