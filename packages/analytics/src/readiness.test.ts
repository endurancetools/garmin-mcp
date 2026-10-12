import { addDays, eachDay } from 'garmin-mcp-config';
import { describe, expect, it } from 'vitest';
import { loadOn, loadSeries } from './load.js';
import {
  DEFAULT_READINESS_RULES,
  READINESS_SIGNALS,
  morningReadiness,
  readiness,
  resolveReadinessRules,
  type ReadinessInput,
  type ReadinessSignalName,
} from './readiness.js';

const D = '2026-05-10';
const FETCHED_LATER = Date.parse('2026-05-12T06:00:00Z');
const history = eachDay(addDays(D, -28), addDays(D, -1));

type Day = ReadinessInput['daily'][number];
type Hrv = ReadinessInput['hrv'][number];
type Sleep = ReadinessInput['sleep'][number];
type Training = ReadinessInput['training'][number];

const dailyRow = (date: string, extra: Partial<Day> = {}): Day => ({
  date,
  fetched_at: FETCHED_LATER,
  resting_hr: 50,
  avg_stress: 30,
  body_battery_high: 80,
  ...extra,
});
const hrvRow = (date: string, extra: Partial<Hrv> = {}): Hrv => ({
  date,
  fetched_at: FETCHED_LATER,
  last_night_avg: 60,
  weekly_avg: 60,
  status: 'BALANCED',
  baseline_low: 50,
  baseline_high: 70,
  ...extra,
});
const sleepRow = (extra: Partial<Sleep> = {}): Sleep => ({ date: D, fetched_at: FETCHED_LATER, score: 85, duration_s: 8 * 3600, ...extra });
const trainingRow = (score: number, extra: Partial<Training> = {}): Training => ({
  date: D,
  fetched_at: FETCHED_LATER,
  readiness_score: score,
  raw: { readiness: [{ score, level: 'HIGH', inputContext: 'AFTER_WAKEUP_RESET', timestamp: `${D}T05:30:00.0`, recoveryTime: 600 }] },
  ...extra,
});

/** Every signal ok: decision GO. */
function input(over: {
  day?: Partial<Day>;
  yesterday?: Partial<Day>;
  hrv?: Partial<Hrv>;
  sleep?: Partial<Sleep>;
  training?: Training;
  load?: ReadinessInput['load'] | null;
  rules?: ReadinessInput['rules'];
  today?: string;
} = {}): ReadinessInput {
  return {
    date: D,
    today: over.today ?? '2026-05-12',
    timeZone: 'UTC',
    daily: [
      ...history.map((d) => dailyRow(d, d === addDays(D, -1) ? over.yesterday : {})),
      dailyRow(D, over.day),
    ],
    hrv: [...history.map((d) => hrvRow(d)), hrvRow(D, over.hrv)],
    sleep: [sleepRow(over.sleep)],
    training: [over.training ?? trainingRow(70)],
    load: over.load === null ? undefined : (over.load ?? { date: D, tsb: 0, acwr: 1, monotony: 1, warming_up: false }),
    rules: over.rules,
  };
}

const signal = (i: ReadinessInput, name: ReadinessSignalName) => readiness(i).signals.find((s) => s.name === name)!;
const rating = (i: ReadinessInput, name: ReadinessSignalName) => signal(i, name).rating;

describe('readiness', () => {
  it('all signals ok: GO with six ok signals and Training Readiness as info, in a fixed order', () => {
    const r = readiness(input());
    expect(r.decision).toBe('GO');
    expect(r.signals.map((s) => s.name)).toEqual(READINESS_SIGNALS);
    expect(r.counts).toEqual({ red: 0, yellow: 0, ok: 6, info: 1, unknown: 0 });
    expect(r.partial).toBe(false);
    expect(r.rules_used).toEqual(DEFAULT_READINESS_RULES);
    expect(r.recommendation[0]).toMatch(/^Follow the planned microcycle/);
  });

  it('reports values and references of a signal', () => {
    const hrv = signal(input(), 'hrv');
    expect(hrv.value).toEqual({ last_night_ms: 60, status: 'BALANCED' });
    expect(hrv.reference).toEqual({ weekly_avg_ms: 60, baseline_low_ms: 50, baseline_high_ms: 70, mean28_ms: 60 });
    expect(signal(input(), 'training_readiness').value).toEqual({ score: 70, level: 'HIGH', recovery_h: 10 });
    expect(signal(input(), 'rhr').reference).toEqual({ mean28_bpm: 50 });
  });

  describe('hrv', () => {
    it.each(['LOW', 'POOR'])('red on Garmin status %s', (status) => {
      expect(rating(input({ hrv: { status } }), 'hrv')).toBe('red');
    });
    it('red below hrv_red_base_factor × baseline low', () => {
      // Baseline low 60: 52 < 0.9 × 60 = 54, while 52 ≥ 0.85 × 28-day mean 60 = 51.
      const i = input({ hrv: { last_night_avg: 52, weekly_avg: 52, baseline_low: 60 } });
      expect(signal(i, 'hrv')).toMatchObject({ rating: 'red', detail: expect.stringContaining('baseline low 60') });
      expect(rating(input({ hrv: { last_night_avg: 55, weekly_avg: 55, baseline_low: 60 } }), 'hrv')).toBe('yellow');
    });
    it('red below hrv_red_mean28_factor × the previous 28 nights', () => {
      // 50 < 0.85 × 60 = 51, baseline low 40 and weekly 50 do not fire.
      const i = input({ hrv: { last_night_avg: 50, weekly_avg: 50, baseline_low: 40 } });
      expect(signal(i, 'hrv')).toMatchObject({ rating: 'red', detail: expect.stringContaining('28-day mean 60') });
      expect(rating(input({ hrv: { last_night_avg: 52, weekly_avg: 52, baseline_low: 40 } }), 'hrv')).toBe('ok');
    });
    it('yellow on UNBALANCED, below the baseline low or below hrv_yellow_weekly_factor × weekly', () => {
      expect(rating(input({ hrv: { status: 'UNBALANCED' } }), 'hrv')).toBe('yellow');
      expect(rating(input({ hrv: { baseline_low: 62 } }), 'hrv')).toBe('yellow');
      expect(rating(input({ hrv: { weekly_avg: 70 } }), 'hrv')).toBe('yellow');
      expect(rating(input({ hrv: { weekly_avg: 66 } }), 'hrv')).toBe('ok');
    });
    it('unknown without the night value', () => {
      expect(rating(input({ hrv: { last_night_avg: null } }), 'hrv')).toBe('unknown');
    });
  });

  describe('rhr', () => {
    it('red at mean28 + rhr_red_delta, yellow at mean28 + rhr_yellow_delta', () => {
      expect(rating(input({ day: { resting_hr: 55 } }), 'rhr')).toBe('red');
      expect(rating(input({ day: { resting_hr: 53 } }), 'rhr')).toBe('yellow');
      expect(rating(input({ day: { resting_hr: 52 } }), 'rhr')).toBe('ok');
    });
    it('unknown without a value or without the 28-day history', () => {
      expect(rating(input({ day: { resting_hr: null } }), 'rhr')).toBe('unknown');
      const i = input();
      expect(rating({ ...i, daily: i.daily.filter((r) => r.date === D) }, 'rhr')).toBe('unknown');
    });
  });

  describe('sleep', () => {
    it('red below sleep_score_red or sleep_h_red', () => {
      expect(rating(input({ sleep: { score: 59 } }), 'sleep')).toBe('red');
      expect(rating(input({ sleep: { duration_s: 5.9 * 3600 } }), 'sleep')).toBe('red');
    });
    it('yellow below sleep_score_yellow or sleep_h_yellow', () => {
      expect(rating(input({ sleep: { score: 74 } }), 'sleep')).toBe('yellow');
      expect(rating(input({ sleep: { duration_s: 6.9 * 3600 } }), 'sleep')).toBe('yellow');
      expect(rating(input({ sleep: { score: 75, duration_s: 7 * 3600 } }), 'sleep')).toBe('ok');
    });
    it('compares hours rounded to 0.1 and rates on either value alone', () => {
      expect(signal(input({ sleep: { duration_s: 6.96 * 3600 } }), 'sleep')).toMatchObject({ rating: 'ok', value: { score: 85, hours: 7 } });
      expect(rating(input({ sleep: { score: null, duration_s: 5 * 3600 } }), 'sleep')).toBe('red');
      expect(rating(input({ sleep: { score: 70, duration_s: null } }), 'sleep')).toBe('yellow');
      expect(rating(input({ sleep: { score: null, duration_s: null } }), 'sleep')).toBe('unknown');
    });
  });

  describe('body_battery', () => {
    it('red below bb_red, yellow below bb_yellow', () => {
      expect(rating(input({ day: { body_battery_high: 29 } }), 'body_battery')).toBe('red');
      expect(rating(input({ day: { body_battery_high: 49 } }), 'body_battery')).toBe('yellow');
      expect(rating(input({ day: { body_battery_high: 50 } }), 'body_battery')).toBe('ok');
      expect(rating(input({ day: { body_battery_high: null } }), 'body_battery')).toBe('unknown');
    });
  });

  describe('training_readiness', () => {
    it.each([20, 49, 70])('score %i is info, shown and never rated', (score) => {
      const s = signal(input({ training: trainingRow(score) }), 'training_readiness');
      expect(s.rating).toBe('info');
      expect(s.value).toEqual({ score, level: 'HIGH', recovery_h: 10 });
      expect(s.detail).toBe("Garmin's own score, shown for reference, not counted");
    });
    it('a score of 20 alone does not change the decision', () => {
      const r = readiness(input({ training: trainingRow(20) }));
      expect(r.decision).toBe('GO');
      expect(r.counts).toEqual({ red: 0, yellow: 0, ok: 6, info: 1, unknown: 0 });
      // With the strictest count rule a single red or yellow would decide; info still does not.
      const strict = readiness(input({ training: trainingRow(20), rules: { decision_red_min: 1, decision_yellow_min: 1 } }));
      expect(strict.decision).toBe('GO');
    });
    it('falls back to the stored column without readiness snapshots, unknown without both', () => {
      expect(signal(input({ training: trainingRow(20, { raw: {} }) }), 'training_readiness')).toMatchObject({ rating: 'info', value: { score: 20 } });
      expect(rating(input({ training: trainingRow(20, { raw: {}, readiness_score: null }) }), 'training_readiness')).toBe('unknown');
    });
    it('readiness_red and readiness_yellow are no longer rules', () => {
      expect(DEFAULT_READINESS_RULES).not.toHaveProperty('readiness_red');
      expect(DEFAULT_READINESS_RULES).not.toHaveProperty('readiness_yellow');
      const r = readiness(input({ training: trainingRow(20), rules: { readiness_red: 90 } as ReadinessInput['rules'] }));
      expect(r.rules_used).toEqual(DEFAULT_READINESS_RULES);
      expect(rating(input({ training: trainingRow(20) }), 'training_readiness')).toBe('info');
    });
  });

  describe('morningReadiness', () => {
    it('takes the newest AFTER_WAKEUP_RESET entry, else the newest entry', () => {
      const raw = {
        readiness: [
          { score: 40, inputContext: 'AFTER_WAKEUP_RESET', timestamp: '2026-05-10T07:00:00.0', recoveryTime: 90 },
          { score: 20, timestamp: '2026-05-10T12:00:00.0' },
          { score: 35, inputContext: 'AFTER_WAKEUP_RESET', timestamp: '2026-05-10T05:00:00.0' },
        ],
      };
      expect(morningReadiness(raw)).toEqual({ score: 40, level: undefined, recovery_h: 1.5 });
      expect(morningReadiness({ readiness: [{ score: 20, timestamp: 'b' }, { score: 10, timestamp: 'a' }] })?.score).toBe(20);
      expect(morningReadiness(null)).toBeUndefined();
      expect(morningReadiness({ readiness: [] })).toBeUndefined();
    });
  });

  describe('stress', () => {
    it('yellow above stress_yellow on the day before; never red; the day itself is ignored', () => {
      const yellow = signal(input({ yesterday: { avg_stress: 51 } }), 'stress');
      expect(yellow).toMatchObject({ rating: 'yellow', value: { avg: 51, date: '2026-05-09' } });
      expect(rating(input({ yesterday: { avg_stress: 50 } }), 'stress')).toBe('ok');
      expect(rating(input({ yesterday: { avg_stress: 99 } }), 'stress')).toBe('yellow');
      expect(rating(input({ day: { avg_stress: 90 } }), 'stress')).toBe('ok');
      expect(rating(input({ yesterday: { avg_stress: null } }), 'stress')).toBe('unknown');
    });
  });

  describe('load', () => {
    it('red above acwr_red or below tsb_red, yellow above acwr_yellow or below tsb_yellow', () => {
      const at = (acwr: number, tsb: number) => rating(input({ load: { date: D, acwr, tsb, monotony: 1, warming_up: false } }), 'load');
      expect(at(1.51, 0)).toBe('red');
      expect(at(1, -31)).toBe('red');
      expect(at(1.31, 0)).toBe('yellow');
      expect(at(1, -21)).toBe('yellow');
      expect(at(1.3, -20)).toBe('ok');
    });
    it('unknown without a load point', () => {
      expect(rating(input({ load: null }), 'load')).toBe('unknown');
    });
    it('unknown while the model warms up: 7 days of 60 a day is not yellow or red, 43 days is rated', () => {
      const at = (days: number) => {
        const start = addDays(D, -(days - 1));
        const sessions = eachDay(start, D).map((date) => ({ date, hrtss: 60 }));
        const point = loadOn(loadSeries(sessions, 'hrtss', D), D)!;
        return { point, signal: signal({ ...input({ load: point }), load_start: start }, 'load') };
      };
      const week = at(7);
      expect(week.point.warming_up).toBe(true);
      // without the guard the unsettled TSB would rate it
      expect(week.point.tsb).toBeLessThan(DEFAULT_READINESS_RULES.tsb_yellow);
      expect(week.signal).toEqual({ name: 'load', rating: 'unknown', value: {}, detail: 'load model warming up (6 of 42 days)' });
      expect(readiness({ ...input({ load: week.point }), load_start: addDays(D, -6) }).decision).toBe('GO');
      const settled = at(43);
      expect(settled.point.warming_up).toBe(false);
      expect(settled.signal.rating).not.toBe('unknown');
      expect(settled.signal.value).toMatchObject({ date: D });
    });
    it('warming up without the series start: no day count in the detail', () => {
      const s = signal(input({ load: { date: D, tsb: -40, acwr: 1, monotony: 1, warming_up: true } }), 'load');
      expect(s).toMatchObject({ rating: 'unknown', detail: 'load model warming up (fewer than 42 days)' });
    });
  });

  it('without any data: every signal unknown, GO, nothing counted', () => {
    const r = readiness({ date: D, today: '2026-05-12', timeZone: 'UTC', daily: [], hrv: [], sleep: [], training: [] });
    expect(r.counts).toEqual({ red: 0, yellow: 0, ok: 0, info: 0, unknown: 7 });
    expect(r.signals.every((s) => s.rating === 'unknown' && Object.keys(s.value).length === 0)).toBe(true);
    expect(r.decision).toBe('GO');
    expect(r.partial).toBe(false);
  });

  describe('decision', () => {
    it('REST at decision_red_min red signals, MODIFY at decision_yellow_min yellow ones', () => {
      expect(readiness(input({ day: { body_battery_high: 20 } })).decision).toBe('REST');
      expect(readiness(input({ day: { body_battery_high: 40 } })).decision).toBe('GO');
      const twoYellow = input({ day: { body_battery_high: 40 }, sleep: { score: 70 } });
      const r = readiness(twoYellow);
      expect(r.decision).toBe('MODIFY');
      expect(r.counts).toEqual({ red: 0, yellow: 2, ok: 4, info: 1, unknown: 0 });
      expect(r.recommendation).toHaveLength(2);
    });
    it('decision_yellow_min and decision_red_min come from the rules', () => {
      const twoYellow = { day: { body_battery_high: 40 }, sleep: { score: 70 } };
      expect(readiness(input({ ...twoYellow, rules: { decision_yellow_min: 3 } })).decision).toBe('GO');
      expect(readiness(input({ day: { body_battery_high: 40 }, rules: { decision_yellow_min: 1 } })).decision).toBe('MODIFY');
      const oneRed = { day: { body_battery_high: 20 } };
      expect(readiness(input({ ...oneRed, rules: { decision_red_min: 2 } })).decision).toBe('GO');
      const r = readiness(input({ ...oneRed, sleep: { score: 50 }, rules: { decision_red_min: 2 } }));
      expect(r.decision).toBe('REST');
      expect(r.recommendation).toHaveLength(3);
    });
  });

  describe('rules', () => {
    it('own rules override the defaults and are reported in rules_used', () => {
      const r = readiness(input({ rules: { bb_yellow: 85, stress_yellow: 25 } }));
      expect(r.signals.find((s) => s.name === 'body_battery')?.rating).toBe('yellow');
      expect(r.signals.find((s) => s.name === 'stress')?.rating).toBe('yellow');
      expect(r.decision).toBe('MODIFY');
      expect(r.rules_used).toEqual({ ...DEFAULT_READINESS_RULES, bb_yellow: 85, stress_yellow: 25 });
    });
    it('resolveReadinessRules ignores missing and non-finite values', () => {
      expect(resolveReadinessRules()).toEqual(DEFAULT_READINESS_RULES);
      expect(resolveReadinessRules({ bb_red: Number.NaN, bb_yellow: undefined, rhr_red_delta: 6 })).toEqual({
        ...DEFAULT_READINESS_RULES,
        rhr_red_delta: 6,
      });
    });
    it('defaults match the spec 5.7 table without the Training Readiness thresholds (E6-28)', () => {
      expect(DEFAULT_READINESS_RULES).toEqual({
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
      });
    });
  });

  describe('partial', () => {
    it('when the day is today or later', () => {
      expect(readiness(input({ today: D })).partial).toBe(true);
      expect(readiness(input({ today: addDays(D, -1) })).partial).toBe(true);
    });
    it('when a row of the day was fetched on that day or earlier (local date)', () => {
      const early = Date.parse(`${D}T20:00:00Z`);
      expect(readiness(input({ sleep: { fetched_at: early } })).partial).toBe(true);
      expect(readiness(input({ day: { fetched_at: early } })).partial).toBe(true);
      expect(readiness(input({ training: trainingRow(70, { fetched_at: early }) })).partial).toBe(true);
      // 23:30 UTC on D is the next day in Warsaw: complete there, partial in UTC.
      const late = Date.parse(`${D}T23:30:00Z`);
      expect(readiness({ ...input({ hrv: { fetched_at: late } }), timeZone: 'Europe/Warsaw' }).partial).toBe(false);
      expect(readiness(input({ hrv: { fetched_at: late } })).partial).toBe(true);
    });
    it('rows of the day before do not make the day partial', () => {
      expect(readiness(input({ yesterday: { fetched_at: Date.parse(`${addDays(D, -1)}T10:00:00Z`) } })).partial).toBe(false);
    });
  });
});
