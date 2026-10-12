import { addDays, daysBetween, type IsoDate } from 'garmin-mcp-config';
import { round, trainingLoadSeries } from 'garmin-mcp-domain';
import type { Session } from './session.js';
import type { SportGroup } from './sport.js';

/**
 * Daily stress source: `auto` the per-session hierarchy (power → pace → heart rate → session RPE, `tss`),
 * `hrtss` heart rate only, or Garmin's per-activity training load (EPOC).
 */
export const LOAD_SOURCES = ['auto', 'hrtss', 'garmin_load'] as const;
export type LoadSource = (typeof LOAD_SOURCES)[number];

/**
 * Warm-up of the load model: CTL (EWMA 42 days) needs about this many days of history to
 * settle. Before that it reads low, so TSB reads deeply negative after a few normal days.
 */
export const CTL_WARMUP_DAYS = 42;
/**
 * Session RPE (Foster) to the scale where an hour at threshold is 100: CR-10 × minutes alone
 * gives about 360 an hour for an RPE of 6, against about 80 from heart rate, so the product is
 * multiplied by this. An approximation; `flags.rpe_calibration` of `get_load` overrides it.
 */
export const RPE_LOAD_CALIBRATION = 0.23;
/**
 * How the heart-rate candidate (`hrtss`) is computed: `zones` from the time in Garmin's HR zones
 * and the profile's zone bounds, `avg` from the average heart rate.
 */
export const HR_METHODS = ['zones', 'avg'] as const;
export type HrMethod = (typeof HR_METHODS)[number];

/** ACWR acute and chronic windows (rolling means, days). */
export const ACWR_ACUTE_DAYS = 7;
export const ACWR_CHRONIC_DAYS = 28;
/** Monotony and strain window (days). */
export const MONOTONY_DAYS = 7;
/** `acwr_low` is raised only above this CTL (a low ratio on almost no training says nothing). */
export const ACWR_LOW_MIN_CTL = 20;

/** One day of the load model. */
export interface LoadDay {
  date: IsoDate;
  /** Daily stress (sum of TSS, hrTSS or Garmin load), 1 place. */
  tss: number;
  ctl: number;
  atl: number;
  /** CTL − ATL at the start of the day. */
  tsb: number;
  /** Mean of the last 7 days / mean of the last 28 days, windows cut at the series start; 0 when the chronic mean is 0. */
  acwr: number;
  /** Mean / sample SD of the last 7 days (Foster); 0 when the SD is 0 or there are fewer than 2 days. */
  monotony: number;
  /** Sum of the last 7 days × monotony. */
  strain: number;
  /** Fewer than `CTL_WARMUP_DAYS` days from the first session to this day: CTL and TSB are not settled yet. */
  warming_up: boolean;
}

/** Thresholds of the load flags; every one can be overridden in the tool input. */
export interface LoadFlags {
  /** ACWR above this: high injury risk zone (Gabbett). */
  acwr_high: number;
  /** ACWR above this (up to `acwr_high`): caution. */
  acwr_warn: number;
  /** ACWR below this, with CTL above 20: undertraining or taper. */
  acwr_low: number;
  /** 7-day monotony above this (Foster). */
  monotony_high: number;
  /** TSB below this: deep fatigue. */
  tsb_low: number;
  /** TSB above this: fresh (taper, rest). */
  tsb_fresh: number;
  /** Week-to-week growth of total hours or running km above this percentage. */
  week_jump_pct: number;
  /** Share of Z1 (below LT1) in run, bike, nordic and row time under this percentage (spec 5.5). */
  z1_min_pct: number;
  /** Multiplier of session RPE × minutes (`load_source: "rpe"`); not a flag threshold, but overridden the same way. */
  rpe_calibration: number;
  /** Heart-rate candidate from the time in zones (`zones`) or from the average heart rate (`avg`); not a flag threshold, but overridden the same way. */
  hr_method: HrMethod;
}

export const DEFAULT_LOAD_FLAGS: Readonly<LoadFlags> = {
  acwr_high: 1.5,
  acwr_warn: 1.3,
  acwr_low: 0.8,
  monotony_high: 2,
  tsb_low: -30,
  tsb_fresh: 15,
  week_jump_pct: 15,
  z1_min_pct: 75,
  rpe_calibration: RPE_LOAD_CALIBRATION,
  hr_method: 'zones',
};

export type LoadFlagCode =
  | 'acwr_high'
  | 'acwr_warn'
  | 'acwr_low'
  | 'monotony_high'
  | 'tsb_low'
  | 'tsb_fresh'
  | 'week_jump'
  | 'z1_below_target';

export interface LoadFlag {
  code: LoadFlagCode;
  text: string;
}

/** Is `v` a valid value of the load flag `key`: a finite number, or for `hr_method` one of {@link HR_METHODS}. */
export function isLoadFlagValue(key: string, v: unknown): boolean {
  if (key === 'hr_method') return typeof v === 'string' && (HR_METHODS as readonly string[]).includes(v);
  return Object.hasOwn(DEFAULT_LOAD_FLAGS, key) && typeof v === 'number' && Number.isFinite(v);
}

/** Defaults overridden by the valid values in `overrides` (finite numbers; `hr_method` one of {@link HR_METHODS}). */
export function resolveLoadFlags(overrides?: Partial<Record<keyof LoadFlags, unknown>>): LoadFlags {
  const out: Record<string, unknown> = { ...DEFAULT_LOAD_FLAGS };
  for (const key of Object.keys(DEFAULT_LOAD_FLAGS)) {
    const v = overrides?.[key as keyof LoadFlags];
    if (isLoadFlagValue(key, v)) out[key] = v;
  }
  return out as unknown as LoadFlags;
}

/** The fields of a session the load model reads. */
export type LoadSession = Pick<Session, 'date' | 'tss' | 'hrtss' | 'g_load'>;

/** Daily stress per date: Σ TSS (`auto`), Σ hrTSS, or Σ Garmin load; a session without that value counts 0. */
export function dailyTss(sessions: readonly LoadSession[], source: LoadSource): Map<IsoDate, number> {
  const out = new Map<IsoDate, number>();
  for (const s of sessions) {
    const v = source === 'auto' ? (s.tss ?? 0) : source === 'hrtss' ? s.hrtss : (s.g_load ?? 0);
    out.set(s.date, (out.get(s.date) ?? 0) + v);
  }
  return out;
}

const mean = (xs: readonly number[]): number => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);

/** Sample standard deviation (n − 1); 0 for fewer than 2 values. */
export function sampleSd(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1));
}

// Below this the SD of a constant week is floating-point noise.
const SD_EPSILON = 1e-9;

/**
 * Load model (spec 5.4) from the first day with an activity to `to` (the service passes
 * max(to, today)), days without activities as 0. CTL/ATL/TSB come from `trainingLoadSeries`
 * (EWMA 42/7, k = 1 − e^(−1/N)) on the daily stress; ACWR 7:28 and monotony/strain on the
 * same daily stress. `warming_up` marks the first `CTL_WARMUP_DAYS` days. Empty without sessions.
 */
export function loadSeries(
  sessions: readonly LoadSession[],
  source: LoadSource,
  to: IsoDate,
): LoadDay[] {
  const daily = dailyTss(sessions, source);
  if (daily.size === 0) return [];
  const first = [...daily.keys()].reduce((a, b) => (b < a ? b : a));
  const ewma = trainingLoadSeries(
    [...daily].map(([date, load]) => ({ date, training_load: load })),
    first,
    to,
  );
  const hist: number[] = [];
  return ewma.map((p) => {
    const warmingUp = daysBetween(first, p.date) < CTL_WARMUP_DAYS;
    const tss = daily.get(p.date) ?? 0;
    hist.push(tss);
    const acute = hist.slice(-ACWR_ACUTE_DAYS);
    const m7 = mean(acute);
    const m28 = mean(hist.slice(-ACWR_CHRONIC_DAYS));
    const week = hist.slice(-MONOTONY_DAYS);
    const sd = sampleSd(week);
    const monotony = sd > SD_EPSILON ? mean(week) / sd : 0;
    const sum7 = week.reduce((s, v) => s + v, 0);
    return {
      date: p.date,
      tss: round(tss, 1) ?? 0,
      ctl: p.ctl,
      atl: p.atl,
      tsb: p.tsb,
      acwr: m28 > 0 ? (round(m7 / m28, 2) ?? 0) : 0,
      monotony: round(monotony, 2) ?? 0,
      strain: round(sum7 * monotony, 0) ?? 0,
      warming_up: warmingUp,
    };
  });
}

/** The last day of the series on or before `date`. */
export function loadOn(series: readonly LoadDay[], date: IsoDate): LoadDay | undefined {
  return series.findLast((d) => d.date <= date);
}

/** Volume of one sport in one ISO week. */
export interface WeekSport {
  week: string;
  sport: SportGroup;
  sessions: number;
  hours: number;
  km: number;
  elev_m: number;
  /** Σ session TSS of the hierarchy (`tss`; sessions without load count 0). */
  tss: number;
  hrtss: number;
  g_load: number;
  /** Hours in HR zones 1–2, 3 and 4–5 (sessions with Garmin zones only). */
  z12_h: number;
  z3_h: number;
  z45_h: number;
}

/** ISO week × sport volume of the sessions, sorted by week and sport. */
export function weeklyBySport(sessions: readonly Session[]): WeekSport[] {
  const acc = new Map<string, WeekSport>();
  for (const s of sessions) {
    const key = `${s.week}|${s.sport}`;
    const w = acc.get(key) ?? {
      week: s.week,
      sport: s.sport,
      sessions: 0,
      hours: 0,
      km: 0,
      elev_m: 0,
      tss: 0,
      hrtss: 0,
      g_load: 0,
      z12_h: 0,
      z3_h: 0,
      z45_h: 0,
    };
    w.sessions += 1;
    w.hours += (s.duration_s ?? 0) / 3600;
    w.km += (s.distance_m ?? 0) / 1000;
    w.elev_m += s.elev_gain_m ?? 0;
    w.tss += s.tss ?? 0;
    w.hrtss += s.hrtss;
    w.g_load += s.g_load ?? 0;
    w.z12_h += ((s.z1_s ?? 0) + (s.z2_s ?? 0)) / 3600;
    w.z3_h += (s.z3_s ?? 0) / 3600;
    w.z45_h += ((s.z4_s ?? 0) + (s.z5_s ?? 0)) / 3600;
    acc.set(key, w);
  }
  return [...acc.values()]
    .map((w) => ({
      ...w,
      hours: round(w.hours, 2) ?? 0,
      km: round(w.km, 1) ?? 0,
      elev_m: round(w.elev_m, 0) ?? 0,
      tss: round(w.tss, 0) ?? 0,
      hrtss: round(w.hrtss, 0) ?? 0,
      g_load: round(w.g_load, 0) ?? 0,
      z12_h: round(w.z12_h, 2) ?? 0,
      z3_h: round(w.z3_h, 2) ?? 0,
      z45_h: round(w.z45_h, 2) ?? 0,
    }))
    .toSorted((a, b) => a.week.localeCompare(b.week) || a.sport.localeCompare(b.sport));
}

const pct = (cur: number, prev: number): number | undefined => (prev > 0 ? ((cur - prev) / prev) * 100 : undefined);

/** Hours in the reference window below which `week_jump` is not raised (percentages of almost nothing). */
export const WEEK_JUMP_MIN_REF_H = 1;

/**
 * Week-to-week jump on rolling windows: total hours (all sports) and running km of the 7 days
 * ending on `asOf` against the 7 days before (no ISO weeks, so a Tuesday after a heavy week
 * still sees it); `undefined` when neither grew by more than `limitPct` or the reference
 * window has less than {@link WEEK_JUMP_MIN_REF_H} hour.
 */
export function weekJump(
  sessions: readonly Pick<Session, 'date' | 'sport' | 'duration_s' | 'distance_m'>[],
  asOf: IsoDate,
  limitPct: number,
): LoadFlag | undefined {
  const curFrom = addDays(asOf, -6);
  const prevFrom = addDays(asOf, -13);
  const c = { h: 0, km: 0 };
  const p = { h: 0, km: 0 };
  for (const s of sessions) {
    if (s.date > asOf || s.date < prevFrom) continue;
    const t = s.date >= curFrom ? c : p;
    t.h += (s.duration_s ?? 0) / 3600;
    if (s.sport === 'run') t.km += (s.distance_m ?? 0) / 1000;
  }
  if (p.h < WEEK_JUMP_MIN_REF_H) return undefined;
  const span = 'last 7 days vs the 7 before';
  const parts: string[] = [];
  const dh = pct(c.h, p.h);
  if (dh !== undefined && dh > limitPct) parts.push(`hours +${Math.round(dh)}% (${round(p.h, 1)} → ${round(c.h, 1)} h, ${span})`);
  const dk = pct(c.km, p.km);
  if (dk !== undefined && dk > limitPct) parts.push(`running km +${Math.round(dk)}% (${round(p.km, 1)} → ${round(c.km, 1)} km, ${span})`);
  if (parts.length === 0) return undefined;
  return { code: 'week_jump', text: `${parts.join(', ')}; above the ${limitPct}% rule of thumb.` };
}

/**
 * Flags of one day of the load model (ACWR, monotony, TSB) plus the jump of its last 7 days.
 * ACWR raises at most one of `acwr_high`, `acwr_warn`, `acwr_low`. While the model warms up
 * (`warming_up`), `tsb_low` and `tsb_fresh` are not raised: TSB on an unsettled CTL is not fatigue.
 */
export function loadFlags(
  day: LoadDay | undefined,
  sessions: readonly Pick<Session, 'date' | 'sport' | 'duration_s' | 'distance_m'>[],
  flags: LoadFlags = DEFAULT_LOAD_FLAGS,
): LoadFlag[] {
  if (!day) return [];
  const out: LoadFlag[] = [];
  if (day.acwr > flags.acwr_high) {
    out.push({ code: 'acwr_high', text: `ACWR ${day.acwr} > ${flags.acwr_high}: high-risk zone for a load spike.` });
  } else if (day.acwr > flags.acwr_warn) {
    out.push({ code: 'acwr_warn', text: `ACWR ${day.acwr} > ${flags.acwr_warn}: load rising fast, watch recovery.` });
  } else if (day.acwr < flags.acwr_low && day.ctl > ACWR_LOW_MIN_CTL) {
    out.push({ code: 'acwr_low', text: `ACWR ${day.acwr} < ${flags.acwr_low}: load well below the chronic level (taper or undertraining).` });
  }
  if (day.monotony > flags.monotony_high) {
    out.push({ code: 'monotony_high', text: `Monotony ${day.monotony} > ${flags.monotony_high}: days too similar, vary hard and easy days.` });
  }
  if (!day.warming_up && day.tsb < flags.tsb_low) {
    out.push({ code: 'tsb_low', text: `TSB ${day.tsb} < ${flags.tsb_low}: deep fatigue, fine only in a planned overload week.` });
  }
  if (!day.warming_up && day.tsb > flags.tsb_fresh) {
    out.push({ code: 'tsb_fresh', text: `TSB ${day.tsb} > ${flags.tsb_fresh}: fresh (taper or rest).` });
  }
  const jump = weekJump(sessions, day.date, flags.week_jump_pct);
  if (jump) out.push(jump);
  return out;
}

/** Length of the windows of the own vs Garmin load ratio (days). */
export const LOAD_RATIO_DAYS = 28;
/** Earlier windows with a ratio needed before the usual ratio (their median) exists. */
export const LOAD_RATIO_MIN_WINDOWS = 8;
/** Relative distance of the current ratio from the usual one above which the load has drifted. */
export const LOAD_RATIO_DRIFT = 0.25;

/** Own daily load against Garmin's training load (EPOC): the current window, the usual ratio and whether it drifted. */
export interface LoadRatio {
  /** Σ own load / Σ Garmin load of the 28 days ending on `to`, on days that have both; 2 places. */
  ratio_28d?: number;
  /** Median of the same ratio over the consecutive 28-day windows before the current one; only with ≥ 8 such windows. */
  usual?: number;
  /** Earlier windows that have a ratio. */
  windows: number;
  /** The current ratio is more than {@link LOAD_RATIO_DRIFT} away from the usual one (relative). */
  drifted: boolean;
}

const median = (xs: readonly number[]): number => {
  const s = xs.toSorted((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
};

/**
 * Ratio of own daily load (`source`: the hierarchy `tss` or `hrtss`) to Garmin's daily training
 * load on the days that have both, over the 28 days ending on `to`, and its median over the
 * consecutive 28-day windows before that back to the first session (windows without a day
 * with both are skipped). A ratio that moves away from its usual value says that the own
 * model or Garmin's changed: outdated thresholds, a new HR strap, a power meter or pace source.
 */
export function loadRatio(sessions: readonly LoadSession[], source: Exclude<LoadSource, 'garmin_load'>, to: IsoDate): LoadRatio {
  const upTo = sessions.filter((s) => s.date <= to);
  const own = dailyTss(upTo, source);
  const garmin = dailyTss(upTo, 'garmin_load');
  const first = upTo.reduce<IsoDate | undefined>((m, s) => (m === undefined || s.date < m ? s.date : m), undefined);
  const ratioOf = (end: IsoDate): number | undefined => {
    const start = addDays(end, -(LOAD_RATIO_DAYS - 1));
    let o = 0;
    let g = 0;
    for (const [date, v] of own) {
      const gv = garmin.get(date) ?? 0;
      if (date < start || date > end || v <= 0 || gv <= 0) continue;
      o += v;
      g += gv;
    }
    return g > 0 ? o / g : undefined;
  };
  const current = ratioOf(to);
  const earlier: number[] = [];
  // Window k ends on to − 28k; the oldest one may start before the first session.
  const windows = first === undefined ? 0 : Math.max(0, Math.floor(daysBetween(first, to) / LOAD_RATIO_DAYS));
  for (let k = 1; k <= windows; k++) {
    const r = ratioOf(addDays(to, -k * LOAD_RATIO_DAYS));
    if (r !== undefined) earlier.push(r);
  }
  const usual = earlier.length >= LOAD_RATIO_MIN_WINDOWS ? median(earlier) : undefined;
  const drifted = current !== undefined && usual !== undefined && usual > 0 && Math.abs(current / usual - 1) > LOAD_RATIO_DRIFT;
  return { ratio_28d: round(current, 2), usual: round(usual, 2), windows: earlier.length, drifted };
}
