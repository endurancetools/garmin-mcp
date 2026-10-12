import type { IsoDate } from 'garmin-mcp-config';
import type { DailyRows, TrainingMetricsRow } from 'garmin-mcp-store';
import { hms, iso, km, round } from './format.js';
import { formState, trainingLoadSeries, type LoadInput, type LoadPoint } from './load.js';
import { trend, type Trend } from './stats.js';

type StatusRow = DailyRows['training_status'];

/** "PRODUCTIVE_1" → "productive". */
export function statusLabel(phrase: string | null | undefined): string | undefined {
  if (!phrase) return undefined;
  return phrase.replace(/_\d+$/, '').toLowerCase().replaceAll('_', ' ');
}

export interface TrainingOverview {
  as_of: IsoDate;
  vo2max?: { running?: number; cycling?: number; running_trend?: Trend };
  readiness?: { score?: number; level?: string; feedback?: string; trend?: Trend };
  garmin_status?: string;
  garmin_load?: { acute?: number; chronic?: number; ratio?: number; acwr_status?: string };
  /** Remaining recovery time from the latest readiness snapshot of the day. */
  recovery?: { remaining_h?: number; as_of?: string };
  /** Garmin load focus: last 4 weeks of load per intensity band against its targets. */
  load_focus?: LoadFocus;
  /** CTL/ATL/TSB from Garmin's per-activity training load (EPOC); the own TSS model is get_load in garmin-mcp-analytics. */
  garmin_load_model?: LoadPoint & { form: string };
  load_series?: LoadPoint[];
  /** Current-state metrics from the newest training sync on or before `to`. */
  metrics?: TrainingMetrics;
  note: string;
}

export interface LoadBand {
  load?: number;
  target_min?: number;
  target_max?: number;
  status?: 'below' | 'within' | 'above';
}

export interface LoadFocus {
  feedback?: string;
  aerobic_low?: LoadBand;
  aerobic_high?: LoadBand;
  anaerobic?: LoadBand;
}

export interface TrainingMetrics {
  as_of: string;
  race_predictions?: { as_of?: string; '5k'?: string; '10k'?: string; half_marathon?: string; marathon?: string };
  endurance_score?: { score?: number; classification?: string; as_of?: string; weekly_avg?: { week: string; avg?: number }[] };
  hill_score?: { score?: number; strength?: number; endurance?: number; as_of?: string; max_4w?: number };
  fitness_age?: { fitness_age?: number; chronological_age?: number; achievable?: number };
  acclimation?: { heat_pct?: number; heat_trend?: string; altitude_m?: number; altitude_trend?: string; current_altitude_m?: number; as_of?: string };
  personal_records?: { record: string; value?: string | number; date?: string; activity_id?: number }[];
}

/**
 * VO2max, readiness, Garmin status and CTL/ATL/TSB from Garmin's training load side by side.
 * Garmin's acute/chronic are 7-day sums with its own weighting; our CTL/ATL are
 * EWMAs of per-activity load, so absolute values differ while trends agree.
 */
export function trainingOverview(
  status: readonly StatusRow[],
  activities: readonly LoadInput[],
  from: IsoDate,
  to: IsoDate,
  includeSeries: boolean,
  metrics?: TrainingMetricsRow,
): TrainingOverview {
  const sorted = status.toSorted((a, b) => a.date.localeCompare(b.date));
  const latest = sorted.findLast((r) => r.date <= to);
  const latestVo2 = sorted.findLast((r) => r.vo2max_running !== null || r.vo2max_cycling !== null);
  const readinessRaw = latest?.raw as { readiness?: { score?: number; level?: string; feedbackShort?: string; inputContext?: string }[] } | undefined;
  const morning = readinessRaw?.readiness?.find((r) => r.inputContext === 'AFTER_WAKEUP_RESET') ?? readinessRaw?.readiness?.[0];
  const series = trainingLoadSeries(activities, from, to);
  const last = series.at(-1);
  const acute = latest?.acute_load ?? undefined;
  const chronic = latest?.chronic_load ?? undefined;
  return {
    as_of: to,
    vo2max: latestVo2 && {
      running: round(latestVo2.vo2max_running, 1),
      cycling: round(latestVo2.vo2max_cycling, 1),
      running_trend: trend(sorted.map((r) => ({ date: r.date, value: r.vo2max_running })), to, 0.01),
    },
    readiness: latest && {
      score: latest.readiness_score ?? undefined,
      level: morning?.level?.toLowerCase(),
      feedback: morning?.feedbackShort?.toLowerCase().replaceAll('_', ' '),
      trend: trend(sorted.map((r) => ({ date: r.date, value: r.readiness_score })), to, 0.05, 0),
    },
    garmin_status: statusLabel(latest?.status),
    garmin_load: latest && {
      acute: round(acute, 0),
      chronic: round(chronic, 0),
      ratio: acute !== undefined && chronic ? round(acute / chronic, 2) : undefined,
      acwr_status: acwrStatus(latest.raw),
    },
    recovery: recovery(latest?.raw),
    load_focus: loadFocus(latest?.raw),
    garmin_load_model: last && { ...last, form: formState(last).replaceAll('_', ' ') },
    load_series: includeSeries ? series : undefined,
    metrics: metrics && trainingMetrics(metrics),
    note:
      'garmin_load_model uses 42/7-day EWMAs of Garmin per-activity training load (EPOC; CTL fitness, ATL fatigue, TSB form = CTL-ATL); ' +
      'the own model from power, pace and heart rate (TSS) is get_load. ' +
      'garmin_load is Garmin\'s own acute/chronic load; scales differ, compare directions rather than absolute numbers. ' +
      'garmin_load_model.form uses TSB bands scaled to CTL (above +10 % fresh, down to -10 % neutral, down to -30 % optimal training, below that overreaching), ' +
      'not Coggan\'s absolute TSB bands, because Garmin training load is on an EPOC scale, not in TSS points.',
  };
}

type StatusRaw = {
  status?: {
    mostRecentTrainingStatus?: {
      latestTrainingStatusData?: Record<string, { primaryTrainingDevice?: boolean; acuteTrainingLoadDTO?: { acwrStatus?: string } }>;
    };
    mostRecentTrainingLoadBalance?: { metricsTrainingLoadBalanceDTOMap?: Record<string, LoadBalanceRaw | null> | null } | null;
  };
  readiness?: { timestamp?: string; timestampLocal?: string; recoveryTime?: number; recoveryTimeChangePhrase?: string }[];
};

type LoadBalanceRaw = { primaryTrainingDevice?: boolean; trainingBalanceFeedbackPhrase?: string } & Record<string, unknown>;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const label = (v: unknown) => str(v)?.toLowerCase().replaceAll('_', ' ');
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** Garmin's recovery clock (minutes) from the newest readiness snapshot; "REACHED_ZERO" keeps the old minutes. */
function recovery(raw: unknown): TrainingOverview['recovery'] {
  const snapshots = (raw as StatusRaw | null)?.readiness ?? [];
  const latest = snapshots.toSorted((a, b) => String(a.timestampLocal ?? a.timestamp ?? '').localeCompare(String(b.timestampLocal ?? b.timestamp ?? ''))).at(-1);
  if (!latest) return undefined;
  const minutes = latest.recoveryTimeChangePhrase === 'REACHED_ZERO' ? 0 : num(latest.recoveryTime);
  if (minutes === undefined || minutes < 0) return undefined;
  return { remaining_h: round(minutes / 60, 1), as_of: str(latest.timestampLocal) ?? str(latest.timestamp) };
}

function loadFocus(raw: unknown): LoadFocus | undefined {
  const map = (raw as StatusRaw | null)?.status?.mostRecentTrainingLoadBalance?.metricsTrainingLoadBalanceDTOMap ?? {};
  const devices = Object.values(map).filter((d): d is LoadBalanceRaw => Boolean(obj(d)));
  const d = devices.find((x) => x.primaryTrainingDevice) ?? devices[0];
  if (!d) return undefined;
  const band = (name: string): LoadBand | undefined => {
    const load = num(d[`monthlyLoad${name}`]);
    const min = num(d[`monthlyLoad${name}TargetMin`]);
    const max = num(d[`monthlyLoad${name}TargetMax`]);
    if (load === undefined && min === undefined && max === undefined) return undefined;
    const status = load === undefined || min === undefined || max === undefined ? undefined : load < min ? 'below' : load > max ? 'above' : 'within';
    return { load: round(load, 0), target_min: round(min, 0), target_max: round(max, 0), status };
  };
  return {
    feedback: label(d.trainingBalanceFeedbackPhrase),
    aerobic_low: band('AerobicLow'),
    aerobic_high: band('AerobicHigh'),
    anaerobic: band('Anaerobic'),
  };
}

const ENDURANCE_CLASSES = ['', 'recreational', 'intermediate', 'trained', 'well trained', 'expert', 'superior', 'elite'];

/** Personal record type ids as used by Garmin Connect. */
const PR_TYPES: Record<number, [string, 'time' | 'distance' | 'elevation' | 'count' | 'days' | 'power']> = {
  1: ['fastest 1k', 'time'],
  2: ['fastest mile', 'time'],
  3: ['fastest 5k', 'time'],
  4: ['fastest 10k', 'time'],
  5: ['fastest half marathon', 'time'],
  6: ['fastest marathon', 'time'],
  7: ['longest run', 'distance'],
  8: ['longest ride', 'distance'],
  9: ['most elevation gain cycling', 'elevation'],
  10: ['best 20 min power', 'power'],
  11: ['fastest 40k cycling', 'time'],
  12: ['most steps day', 'count'],
  13: ['most steps week', 'count'],
  14: ['most steps month', 'count'],
  15: ['longest daily goal streak', 'days'],
  16: ['longest weekly goal streak', 'days'],
  17: ['longest pool swim', 'distance'],
  // Swim ids confirmed against Garmin Connect on a recorded account; 19, 21 and 24 were not in it.
  18: ['fastest 100m pool swim', 'time'],
  20: ['fastest 400m pool swim', 'time'],
  22: ['fastest 750m pool swim', 'time'],
  23: ['fastest 1000m pool swim', 'time'],
  25: ['fastest 1500m pool swim', 'time'],
};

function prValue(value: number | undefined, kind: (typeof PR_TYPES)[number][1] | undefined): string | number | undefined {
  if (value === undefined) return undefined;
  switch (kind) {
    case 'time':
      return hms(value);
    case 'distance':
      return `${km(value, 2)} km`;
    case 'elevation':
      return `${Math.round(value)} m`;
    case 'days':
      return `${Math.round(value)} days`;
    case 'power':
      return `${Math.round(value)} W`;
    default:
      return Math.round(value * 100) / 100;
  }
}

/** Dense view of the stored race predictions, scores, fitness age, acclimation and records. */
export function trainingMetrics(row: TrainingMetricsRow): TrainingMetrics {
  const r = row.raw;
  const race = obj(r.race_predictions);
  const endurance = obj(r.endurance_score);
  const enduranceDto = obj(endurance?.enduranceScoreDTO);
  const hill = obj(r.hill_score);
  const hillDays = (Array.isArray(hill?.hillScoreDTOList) ? (hill.hillScoreDTOList as unknown[]) : [])
    .map(obj)
    .filter((d): d is Record<string, unknown> => d !== undefined)
    .toSorted((a, b) => String(a.calendarDate ?? '').localeCompare(String(b.calendarDate ?? '')));
  const hillLatest = hillDays.at(-1);
  const age = obj(r.fitness_age);
  const maxmet = Array.isArray(r.max_metrics) ? obj(r.max_metrics.at(-1)) : obj(r.max_metrics);
  const acc = obj(maxmet?.heatAltitudeAcclimation);
  const records = Array.isArray(r.personal_records) ? (r.personal_records as unknown[]).map(obj).filter((x) => x !== undefined) : [];
  const classId = num(enduranceDto?.classification);
  return {
    as_of: row.date,
    race_predictions: race && {
      as_of: str(race.calendarDate),
      '5k': hms(num(race.time5K)),
      '10k': hms(num(race.time10K)),
      half_marathon: hms(num(race.timeHalfMarathon)),
      marathon: hms(num(race.timeMarathon)),
    },
    endurance_score: enduranceDto && {
      score: num(enduranceDto.overallScore),
      classification: classId === undefined ? undefined : (ENDURANCE_CLASSES[classId] ?? `level ${classId}`),
      as_of: str(enduranceDto.calendarDate),
      weekly_avg: Object.entries(obj(endurance?.groupMap) ?? {})
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([week, g]) => ({ week, avg: round(num(obj(g)?.groupAverage), 0) })),
    },
    hill_score: hillLatest && {
      score: num(hillLatest.overallScore),
      strength: num(hillLatest.strengthScore),
      endurance: num(hillLatest.enduranceScore),
      as_of: str(hillLatest.calendarDate),
      max_4w: num(hill?.maxScore),
    },
    fitness_age: age && {
      fitness_age: round(num(age.fitnessAge), 1),
      chronological_age: num(age.chronologicalAge),
      achievable: round(num(age.achievableFitnessAge), 1),
    },
    acclimation: acc && {
      heat_pct: num(acc.heatAcclimationPercentage),
      heat_trend: label(acc.heatTrend),
      altitude_m: num(acc.altitudeAcclimation),
      altitude_trend: label(acc.altitudeTrend),
      current_altitude_m: num(acc.currentAltitude),
      as_of: str(acc.calendarDate),
    },
    personal_records: records
      .map((pr) => {
        const typeId = num(pr.typeId);
        const type = typeId === undefined ? undefined : PR_TYPES[typeId];
        return {
          record: type?.[0] ?? `record type ${typeId ?? '?'}`,
          value: prValue(num(pr.value), type?.[1]),
          date: (str(pr.prStartTimeGmtFormatted) ?? iso(num(pr.prStartTimeGMT)))?.slice(0, 10),
          activity_id: num(pr.activityId),
          typeId,
        };
      })
      .toSorted((a, b) => (a.typeId ?? 0) - (b.typeId ?? 0))
      .map(({ typeId: _t, ...rest }) => rest),
  };
}

function acwrStatus(raw: unknown): string | undefined {
  const devices = Object.values((raw as StatusRaw | null)?.status?.mostRecentTrainingStatus?.latestTrainingStatusData ?? {});
  const primary = devices.find((d) => d.primaryTrainingDevice) ?? devices[0];
  return primary?.acuteTrainingLoadDTO?.acwrStatus?.toLowerCase();
}
