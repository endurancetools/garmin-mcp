import { eachDay, type IsoDate } from 'garmin-mcp-config';
import type { ActivityRow } from 'garmin-mcp-store';
import { activityWeather } from './activity-extras.js';
import { gapPace, trainingEffectText } from './activity-metrics.js';
import { hms, isFootSport, km, round, speedOrPace } from './format.js';

export interface ActivityBrief {
  id: number;
  date?: string;
  start_local?: string;
  type?: string;
  name?: string;
  duration?: string;
  distance_km?: number;
  avg_pace?: string;
  avg_speed_kmh?: number;
  elevation_gain_m?: number;
  avg_hr_bpm?: number;
  max_hr_bpm?: number;
  avg_power_w?: number;
  training_load?: number;
  training_effect?: { aerobic?: number; anaerobic?: number };
  calories_kcal?: number;
}

/** Dense one-line-per-activity shape for lists (`get_activities`). */
export function activityBrief(a: ActivityRow): ActivityBrief {
  return {
    id: a.id,
    date: a.date ?? undefined,
    start_local: a.start_time_local?.slice(11, 16),
    type: a.type ?? undefined,
    name: a.name ?? undefined,
    duration: hms(a.duration_s),
    distance_km: a.distance_m ? km(a.distance_m) : undefined,
    ...speedOrPace(a.type, a.distance_m, a.duration_s),
    elevation_gain_m: round(a.elevation_gain_m, 0),
    avg_hr_bpm: round(a.avg_hr, 0),
    max_hr_bpm: round(a.max_hr, 0),
    avg_power_w: round(a.avg_power, 0),
    training_load: round(a.training_load, 0),
    training_effect: { aerobic: round(a.training_effect_aerobic, 1), anaerobic: round(a.training_effect_anaerobic, 1) },
    calories_kcal: round(a.calories, 0),
  };
}

export interface ActivityListItem extends Omit<ActivityBrief, 'training_effect'> {
  avg_gap_pace?: string;
  cadence_spm?: number;
  cadence_rpm?: number;
  normalized_power_w?: number;
  training_effect?: { aerobic?: number; anaerobic?: number; label?: string };
  temp_c?: number;
  dew_point_c?: number;
}

const positive = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);

/**
 * `get_activities` row: the brief plus grade adjusted pace (foot sports), run or bike cadence,
 * normalized power and the Training Effect label from the activity list entry, and air
 * temperature and dew point from the activity's weather when that was downloaded
 * (`weatherRaw`, Fahrenheit as Garmin sends it); the list's own temperature is the watch's
 * sensor, warmed by the wrist, and is not used.
 */
export function activityListItem(a: ActivityRow, weatherRaw?: unknown): ActivityListItem {
  const raw = a.raw as Record<string, unknown>;
  const brief = activityBrief(a);
  const weather = weatherRaw === undefined ? undefined : activityWeather(weatherRaw, undefined);
  return {
    ...brief,
    avg_gap_pace: isFootSport(a.type) ? gapPace(raw) : undefined,
    cadence_spm: round(positive(raw.averageRunningCadenceInStepsPerMinute), 0),
    cadence_rpm: round(positive(raw.averageBikingCadenceInRevPerMinute), 0),
    normalized_power_w: round(positive(raw.normPower), 0),
    training_effect: { ...brief.training_effect, label: trainingEffectText(raw).label },
    temp_c: weather?.temp_c,
    dew_point_c: weather?.dew_point_c,
  };
}

/** Seconds per HR zone (1–5) summed from the activity list's hrTimeInZone_N fields. */
export function hrZoneSeconds(activities: readonly ActivityRow[]): number[] {
  const zones = [0, 0, 0, 0, 0];
  for (const a of activities) {
    const raw = a.raw as Record<string, unknown>;
    for (let z = 1; z <= 5; z++) {
      const v = raw[`hrTimeInZone_${z}`];
      if (typeof v === 'number') zones[z - 1] = (zones[z - 1] ?? 0) + v;
    }
  }
  return zones;
}

export interface SportVolume {
  sport: string;
  sessions: number;
  duration: string;
  duration_h: number;
  distance_km?: number;
  elevation_gain_m?: number;
  training_load?: number;
}

export interface PeriodActivitySummary {
  from: IsoDate;
  to: IsoDate;
  sessions: number;
  total_duration?: string;
  total_distance_km?: number;
  total_training_load?: number;
  by_sport: SportVolume[];
  hr_zones?: { zone: number; time: string; pct: number }[];
  active_days: number;
  rest_days: number;
  longest?: ActivityBrief;
  hardest?: ActivityBrief;
}

/** Volume per sport, HR zone distribution, rest days, longest effort. */
export function periodActivitySummary(activities: readonly ActivityRow[], from: IsoDate, to: IsoDate): PeriodActivitySummary {
  const inRange = activities.filter((a) => a.date !== null && a.date >= from && a.date <= to);
  const bySport = new Map<string, ActivityRow[]>();
  for (const a of inRange) {
    const key = a.type ?? 'other';
    bySport.set(key, [...(bySport.get(key) ?? []), a]);
  }
  const total = (xs: readonly ActivityRow[], f: (a: ActivityRow) => number | null) => xs.reduce((acc, a) => acc + (f(a) ?? 0), 0);
  const zones = hrZoneSeconds(inRange);
  const zoneTotal = zones.reduce((a, b) => a + b, 0);
  const activeDays = new Set(inRange.map((a) => a.date)).size;
  const longest = inRange.toSorted((a, b) => (b.duration_s ?? 0) - (a.duration_s ?? 0))[0];
  const hardest = inRange.toSorted((a, b) => (b.training_load ?? 0) - (a.training_load ?? 0))[0];
  return {
    from,
    to,
    sessions: inRange.length,
    total_duration: hms(total(inRange, (a) => a.duration_s)),
    total_distance_km: km(total(inRange, (a) => a.distance_m), 1),
    total_training_load: round(total(inRange, (a) => a.training_load), 0),
    by_sport: [...bySport.entries()]
      .map(([sport, xs]) => {
        const dist = total(xs, (a) => a.distance_m);
        const elev = total(xs, (a) => a.elevation_gain_m);
        const dur = total(xs, (a) => a.duration_s);
        return {
          sport,
          sessions: xs.length,
          duration: hms(dur) ?? '0:00',
          duration_h: round(dur / 3600, 2) ?? 0,
          distance_km: dist > 0 ? km(dist, 1) : undefined,
          elevation_gain_m: elev > 0 ? round(elev, 0) : undefined,
          training_load: round(total(xs, (a) => a.training_load), 0),
        };
      })
      .toSorted((a, b) => b.duration_h - a.duration_h),
    hr_zones:
      zoneTotal > 0
        ? zones.map((secs, i) => ({ zone: i + 1, time: hms(secs) ?? '0:00', pct: round((secs / zoneTotal) * 100, 0) ?? 0 }))
        : undefined,
    active_days: activeDays,
    rest_days: eachDay(from, to).length - activeDays,
    longest: longest && activityBrief(longest),
    hardest: hardest && hardest.training_load ? activityBrief(hardest) : undefined,
  };
}
