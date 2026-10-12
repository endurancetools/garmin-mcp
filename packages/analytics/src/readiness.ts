import { addDays, dateIn, daysBetween, type IsoDate } from 'garmin-mcp-config';
import { round } from 'garmin-mcp-domain';
import type { DailyRows } from 'garmin-mcp-store';
import { CTL_WARMUP_DAYS, type LoadDay } from './load.js';

/** Thresholds of the morning decision (spec 5.7); every one can be overridden in the tool input. */
export interface ReadinessRules {
  /** HRV red: last night below this × Garmin's baseline low. */
  hrv_red_base_factor: number;
  /** HRV red: last night below this × the mean of the previous 28 nights. */
  hrv_red_mean28_factor: number;
  /** HRV yellow: last night below this × Garmin's 7-day average. */
  hrv_yellow_weekly_factor: number;
  /** Resting HR red: at least the 28-day mean + this (bpm). */
  rhr_red_delta: number;
  /** Resting HR yellow: at least the 28-day mean + this (bpm). */
  rhr_yellow_delta: number;
  /** Sleep red: score below this. */
  sleep_score_red: number;
  /** Sleep yellow: score below this. */
  sleep_score_yellow: number;
  /** Sleep red: fewer hours than this. */
  sleep_h_red: number;
  /** Sleep yellow: fewer hours than this. */
  sleep_h_yellow: number;
  /** Body Battery high of the day below this: red. */
  bb_red: number;
  /** Body Battery high of the day below this: yellow. */
  bb_yellow: number;
  /** Average stress of the day before above this: yellow (never red). */
  stress_yellow: number;
  /** Own load red: ACWR above this. */
  acwr_red: number;
  /** Own load yellow: ACWR above this. */
  acwr_yellow: number;
  /** Own load red: TSB below this. */
  tsb_red: number;
  /** Own load yellow: TSB below this. */
  tsb_yellow: number;
  /** At least this many red signals: REST. */
  decision_red_min: number;
  /** At least this many yellow signals: MODIFY. */
  decision_yellow_min: number;
}

export const DEFAULT_READINESS_RULES: Readonly<ReadinessRules> = {
  hrv_red_base_factor: 0.9,
  hrv_red_mean28_factor: 0.85,
  hrv_yellow_weekly_factor: 0.9,
  rhr_red_delta: 5,
  rhr_yellow_delta: 3,
  sleep_score_red: 60,
  sleep_score_yellow: 75,
  sleep_h_red: 6,
  sleep_h_yellow: 7,
  bb_red: 30,
  bb_yellow: 50,
  stress_yellow: 50,
  acwr_red: 1.5,
  acwr_yellow: 1.3,
  tsb_red: -30,
  tsb_yellow: -20,
  decision_red_min: 1,
  decision_yellow_min: 2,
};

/** Defaults overridden by the finite numbers in `overrides`. */
export function resolveReadinessRules(overrides?: Partial<Record<keyof ReadinessRules, number | undefined>>): ReadinessRules {
  const out: ReadinessRules = { ...DEFAULT_READINESS_RULES };
  for (const key of Object.keys(DEFAULT_READINESS_RULES) as (keyof ReadinessRules)[]) {
    const v = overrides?.[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
  }
  return out;
}

export type ReadinessSignalName = 'hrv' | 'rhr' | 'sleep' | 'body_battery' | 'training_readiness' | 'stress' | 'load';

export const READINESS_SIGNALS: readonly ReadinessSignalName[] = [
  'hrv',
  'rhr',
  'sleep',
  'body_battery',
  'training_readiness',
  'stress',
  'load',
];

/**
 * `unknown`: no data for the signal; `info`: shown for reference, never rated (Garmin's own
 * Training Readiness score). Neither counts towards the decision.
 */
export type ReadinessRating = 'ok' | 'yellow' | 'red' | 'info' | 'unknown';

export type ReadinessDecision = 'GO' | 'MODIFY' | 'REST';

type Values = Record<string, number | string>;

export interface ReadinessSignal {
  name: ReadinessSignalName;
  rating: ReadinessRating;
  /** Observed values of the day (empty when unknown). */
  value: Values;
  /** What the value is compared with (averages, Garmin's baseline), when the rule uses any. */
  reference?: Values;
  /** The rule that set the rating, or why the signal is unknown. */
  detail: string;
}

export interface Readiness {
  date: IsoDate;
  decision: ReadinessDecision;
  counts: Record<ReadinessRating, number>;
  signals: ReadinessSignal[];
  /** The day is still running, or some of its rows were fetched before it ended. */
  partial: boolean;
  rules_used: ReadinessRules;
  /** Short advice for the decision. */
  recommendation: string[];
}

type Fetched = { date: IsoDate; fetched_at: number };

export interface ReadinessInput {
  date: IsoDate;
  /** Today in the user's time zone. */
  today: IsoDate;
  timeZone: string;
  /** Rows of [D − 28, D]; other dates are ignored. */
  daily: readonly (Fetched & Pick<DailyRows['daily_summary'], 'resting_hr' | 'avg_stress' | 'body_battery_high'>)[];
  sleep: readonly (Fetched & Pick<DailyRows['sleep'], 'score' | 'duration_s'>)[];
  hrv: readonly (Fetched &
    Pick<DailyRows['hrv'], 'last_night_avg' | 'weekly_avg' | 'status' | 'baseline_low' | 'baseline_high'>)[];
  training: readonly (Fetched & Pick<DailyRows['training_status'], 'readiness_score' | 'raw'>)[];
  /** Load model point of D (`loadOn`). */
  load?: Pick<LoadDay, 'date' | 'tsb' | 'acwr' | 'monotony' | 'warming_up'>;
  /** First day of the load series (the first session), for the warm-up progress in the `load` detail. */
  load_start?: IsoDate;
  rules?: Partial<Record<keyof ReadinessRules, number | undefined>>;
}

/** Days before D whose means the HRV and resting HR rules use. */
export const READINESS_WINDOW_DAYS = 28;

const RECOMMENDATIONS: Record<ReadinessDecision, string[]> = {
  REST: [
    "Cancel today's key session or move it by 24-48 h. Allowed: 30-45 min Z1, mobility, swim technique.",
    'Check for signs of illness (throat, temperature, muscle soreness without training). Symptoms below the neck: no training.',
    'If this is the second red day in a row: cut 30-50% of the volume from the rest of the week and note why in the microcycle.',
  ],
  MODIFY: [
    'Keep the session structure, cut the quality part by 30-50% (fewer reps, not a slower pace) or swap it with an easy day.',
    'Strength: core session only, or the main session at 60% load without eccentrics to failure.',
  ],
  GO: ['Follow the planned microcycle. If HRV and TSB are high in an overload week, do not add anything beyond the plan.'],
};

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

function mean(xs: readonly (number | null | undefined)[]): number | undefined {
  const ok = xs.filter(finite);
  return ok.length ? ok.reduce((s, v) => s + v, 0) / ok.length : undefined;
}

const unknown = (name: ReadinessSignalName, detail: string): ReadinessSignal => ({ name, rating: 'unknown', value: {}, detail });

/** Drops undefined entries of a values object. */
function vals(v: Record<string, number | string | null | undefined>): Values {
  const out: Values = {};
  for (const [k, x] of Object.entries(v)) if (x !== undefined && x !== null && x !== '') out[k] = x;
  return out;
}

function rate(red: string | undefined, yellow: string | undefined): { rating: ReadinessRating; detail: string | undefined } {
  if (red) return { rating: 'red', detail: red };
  if (yellow) return { rating: 'yellow', detail: yellow };
  return { rating: 'ok', detail: undefined };
}

/** Nights in [D − 28, D) the own HRV mean needs before the HRV rule compares with it. */
export const HRV_MEAN_MIN_NIGHTS = 7;

/**
 * HRV rated from the numbers only. Garmin's HRV status stays in `value` for reference and never
 * sets the rating; Garmin's 7-day average and baseline are its rolling averages of the raw nights,
 * kept as references. The own mean of the previous nights counts from `HRV_MEAN_MIN_NIGHTS` on.
 */
function hrvSignal(row: ReadinessInput['hrv'][number] | undefined, previous: readonly number[], r: ReadinessRules): ReadinessSignal {
  const hrv = row?.last_night_avg;
  if (!row || !finite(hrv)) return unknown('hrv', 'No overnight HRV for the day.');
  const status = row.status ?? undefined;
  const low = finite(row.baseline_low) ? row.baseline_low : undefined;
  const weekly = finite(row.weekly_avg) ? row.weekly_avg : undefined;
  const enough = previous.length >= HRV_MEAN_MIN_NIGHTS;
  const m = enough ? mean(previous) : undefined;
  const m28 = m !== undefined && m > 0 ? m : undefined;
  const red =
    low !== undefined && hrv < low * r.hrv_red_base_factor
      ? `HRV ${hrv} ms < ${r.hrv_red_base_factor} × baseline low ${low} ms.`
      : m28 !== undefined && hrv < m28 * r.hrv_red_mean28_factor
        ? `HRV ${hrv} ms < ${r.hrv_red_mean28_factor} × 28-day mean ${round(m28, 0)} ms.`
        : undefined;
  const yellow =
    low !== undefined && hrv < low
      ? `HRV ${hrv} ms below the baseline low ${low} ms.`
      : weekly !== undefined && hrv < weekly * r.hrv_yellow_weekly_factor
        ? `HRV ${hrv} ms < ${r.hrv_yellow_weekly_factor} × 7-day average ${weekly} ms.`
        : undefined;
  const { rating, detail } = rate(red, yellow);
  const skipped = enough
    ? ''
    : ` 28-day mean not compared: ${previous.length} of ${HRV_MEAN_MIN_NIGHTS} nights needed.`;
  return {
    name: 'hrv',
    rating,
    value: vals({ last_night_ms: hrv, status }),
    reference: vals({
      garmin_weekly_avg_ms: weekly,
      garmin_baseline_low_ms: low,
      garmin_baseline_high_ms: row.baseline_high,
      mean28_ms: round(m28, 0),
    }),
    detail: (detail ?? `HRV ${hrv} ms within the baseline and the averages.`) + skipped,
  };
}

function rhrSignal(rhr: number | null | undefined, mean28: number | undefined, r: ReadinessRules): ReadinessSignal {
  if (!finite(rhr)) return unknown('rhr', 'No resting HR for the day.');
  if (mean28 === undefined || mean28 <= 0) return unknown('rhr', 'No resting HR in the previous 28 days to compare with.');
  const m = round(mean28, 1) ?? mean28;
  const { rating, detail } = rate(
    rhr >= mean28 + r.rhr_red_delta ? `Resting HR ${rhr} ≥ 28-day mean ${m} + ${r.rhr_red_delta} bpm.` : undefined,
    rhr >= mean28 + r.rhr_yellow_delta ? `Resting HR ${rhr} ≥ 28-day mean ${m} + ${r.rhr_yellow_delta} bpm.` : undefined,
  );
  return {
    name: 'rhr',
    rating,
    value: { bpm: rhr },
    reference: { mean28_bpm: m },
    detail: detail ?? `Resting HR ${rhr} below the 28-day mean ${m} + ${r.rhr_yellow_delta} bpm.`,
  };
}

function sleepSignal(row: ReadinessInput['sleep'][number] | undefined, r: ReadinessRules): ReadinessSignal {
  const score = finite(row?.score) ? row.score : undefined;
  // Hours to 0.1, as plan-v2 compared them.
  const hours = finite(row?.duration_s) ? round(row.duration_s / 3600, 1) : undefined;
  if (score === undefined && hours === undefined) return unknown('sleep', 'No sleep score or duration for the night before the day.');
  const below = (limitScore: number, limitH: number): string | undefined => {
    const parts = [
      score !== undefined && score < limitScore ? `score ${score} < ${limitScore}` : undefined,
      hours !== undefined && hours < limitH ? `${hours} h < ${limitH} h` : undefined,
    ].filter(Boolean);
    return parts.length ? `Sleep ${parts.join(', ')}.` : undefined;
  };
  const { rating, detail } = rate(below(r.sleep_score_red, r.sleep_h_red), below(r.sleep_score_yellow, r.sleep_h_yellow));
  return {
    name: 'sleep',
    rating,
    value: vals({ score, hours }),
    detail: detail ?? `Sleep at least score ${r.sleep_score_yellow} and ${r.sleep_h_yellow} h.`,
  };
}

function bodyBatterySignal(high: number | null | undefined, r: ReadinessRules): ReadinessSignal {
  if (!finite(high)) return unknown('body_battery', 'No Body Battery high for the day.');
  const { rating, detail } = rate(
    high < r.bb_red ? `Body Battery high ${high} < ${r.bb_red}.` : undefined,
    high < r.bb_yellow ? `Body Battery high ${high} < ${r.bb_yellow}.` : undefined,
  );
  return { name: 'body_battery', rating, value: { high }, detail: detail ?? `Body Battery high ${high} ≥ ${r.bb_yellow}.` };
}

type ReadinessEntry = { score?: unknown; level?: unknown; inputContext?: unknown; timestamp?: unknown; recoveryTime?: unknown };

/**
 * The morning Training Readiness snapshot of a `training_status.raw`: the newest
 * AFTER_WAKEUP_RESET entry by timestamp, else the newest entry of the day.
 */
export function morningReadiness(raw: unknown): { score?: number; level?: string; recovery_h?: number } | undefined {
  const list = (raw as { readiness?: unknown } | null)?.readiness;
  if (!Array.isArray(list)) return undefined;
  const entries = list.filter((e): e is ReadinessEntry => e !== null && typeof e === 'object');
  const wakeup = entries.filter((e) => e.inputContext === 'AFTER_WAKEUP_RESET');
  const pool = wakeup.length ? wakeup : entries;
  const ts = (e: ReadinessEntry) => (typeof e.timestamp === 'string' ? e.timestamp : '');
  const pick = pool.toSorted((a, b) => ts(a).localeCompare(ts(b))).at(-1);
  if (!pick) return undefined;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const recovery = num(pick.recoveryTime);
  return {
    score: num(pick.score),
    level: typeof pick.level === 'string' && pick.level !== '' ? pick.level : undefined,
    recovery_h: recovery === undefined ? undefined : round(recovery / 60, 1),
  };
}

/**
 * Garmin Training Readiness, always `info`: Garmin's score is itself made of HRV, sleep,
 * recovery and load, which vote on their own, so counting it would count them twice.
 */
function trainingReadinessSignal(row: ReadinessInput['training'][number] | undefined): ReadinessSignal {
  const morning = row ? morningReadiness(row.raw) : undefined;
  const score = morning?.score ?? (finite(row?.readiness_score) ? row.readiness_score : undefined);
  if (score === undefined) return unknown('training_readiness', 'No Garmin Training Readiness for the day.');
  return {
    name: 'training_readiness',
    rating: 'info',
    value: vals({ score, level: morning?.level, recovery_h: morning?.recovery_h }),
    detail: "Garmin's own score, shown for reference, not counted",
  };
}

function stressSignal(avg: number | null | undefined, date: IsoDate, r: ReadinessRules): ReadinessSignal {
  if (!finite(avg)) return unknown('stress', `No average stress for ${date} (the day before).`);
  const yellow = avg > r.stress_yellow;
  return {
    name: 'stress',
    rating: yellow ? 'yellow' : 'ok',
    value: { avg, date },
    detail: yellow
      ? `Average stress ${avg} on ${date} > ${r.stress_yellow}.`
      : `Average stress ${avg} on ${date} ≤ ${r.stress_yellow}.`,
  };
}

function loadSignal(load: ReadinessInput['load'], start: IsoDate | undefined, r: ReadinessRules): ReadinessSignal {
  if (!load) return unknown('load', 'No load model point on or before the day.');
  if (load.warming_up) {
    const progress = start === undefined ? `fewer than ${CTL_WARMUP_DAYS}` : `${daysBetween(start, load.date)} of ${CTL_WARMUP_DAYS}`;
    return unknown('load', `load model warming up (${progress} days)`);
  }
  const why = (acwr: number, tsb: number): string | undefined => {
    const parts = [
      load.acwr > acwr ? `ACWR ${load.acwr} > ${acwr}` : undefined,
      load.tsb < tsb ? `TSB ${load.tsb} < ${tsb}` : undefined,
    ].filter(Boolean);
    return parts.length ? `Own load: ${parts.join(', ')}.` : undefined;
  };
  const { rating, detail } = rate(why(r.acwr_red, r.tsb_red), why(r.acwr_yellow, r.tsb_yellow));
  return {
    name: 'load',
    rating,
    value: { tsb: load.tsb, acwr: load.acwr, monotony: load.monotony, date: load.date },
    detail: detail ?? `Own load: ACWR ${load.acwr} ≤ ${r.acwr_yellow}, TSB ${load.tsb} ≥ ${r.tsb_yellow}.`,
  };
}

/**
 * Morning GO / MODIFY / REST decision for `date` (spec 5.7): seven signals rated red,
 * yellow, ok, info (Garmin's Training Readiness, shown only) or unknown (no data, or the load
 * model still warming up); info and unknown never count. REST at `decision_red_min` red signals,
 * else MODIFY at `decision_yellow_min` yellow ones, else GO. Stress is taken from the day
 * before (the day itself is still running). `partial` when the day is today or later, or a
 * row of the day was fetched before the day had ended (local date of `fetched_at` ≤ D).
 */
export function readiness(input: ReadinessInput): Readiness {
  const { date: d } = input;
  const rules = resolveReadinessRules(input.rules);
  const from = addDays(d, -READINESS_WINDOW_DAYS);
  const yesterday = addDays(d, -1);
  const before = (r: { date: IsoDate }) => r.date >= from && r.date < d;
  const on = <T extends { date: IsoDate }>(rows: readonly T[], day: IsoDate) => rows.findLast((r) => r.date === day);

  const daily = on(input.daily, d);
  const sleep = on(input.sleep, d);
  const hrv = on(input.hrv, d);
  const training = on(input.training, d);

  const signals = [
    hrvSignal(hrv, input.hrv.filter(before).map((r) => r.last_night_avg).filter(finite), rules),
    rhrSignal(daily?.resting_hr, mean(input.daily.filter(before).map((r) => r.resting_hr)), rules),
    sleepSignal(sleep, rules),
    bodyBatterySignal(daily?.body_battery_high, rules),
    trainingReadinessSignal(training),
    stressSignal(on(input.daily, yesterday)?.avg_stress, yesterday, rules),
    loadSignal(input.load, input.load_start, rules),
  ];

  const counts: Record<ReadinessRating, number> = { red: 0, yellow: 0, ok: 0, info: 0, unknown: 0 };
  for (const s of signals) counts[s.rating] += 1;
  const decision: ReadinessDecision =
    counts.red >= rules.decision_red_min ? 'REST' : counts.yellow >= rules.decision_yellow_min ? 'MODIFY' : 'GO';

  const fetchedEarly = [daily, sleep, hrv, training].some(
    (r) => r !== undefined && dateIn(input.timeZone, new Date(r.fetched_at)) <= d,
  );

  return {
    date: d,
    decision,
    counts,
    signals,
    partial: d >= input.today || fetchedEarly,
    rules_used: rules,
    recommendation: [...RECOMMENDATIONS[decision]],
  };
}
