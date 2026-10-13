import { addDays, eachDay } from 'garmin-mcp-config';
import { describe, expect, it } from 'vitest';
import { loadOn, loadSeries } from './load.js';
import {
  DEFAULT_READINESS_RULES,
  READINESS_RED_PAIRS,
  READINESS_SIGNALS,
  decide,
  isReadinessRuleValue,
  morningReadiness,
  readiness,
  resolveReadinessRules,
  type ReadinessInput,
  type ReadinessSignal,
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
  it('all signals ok: GO with four counted ok signals and three Garmin scores as info, in a fixed order', () => {
    const r = readiness(input());
    expect(r.decision).toBe('GO');
    expect(r.signals.map((s) => s.name)).toEqual(READINESS_SIGNALS);
    expect(r.counts).toEqual({ red: 0, yellow: 0, ok: 4, info: 3, unknown: 0 });
    expect(r.signals.filter((s) => s.rating === 'info').map((s) => s.name)).toEqual(['body_battery', 'training_readiness', 'stress']);
    expect(r.partial).toBe(false);
    expect(r.rules_used).toEqual(DEFAULT_READINESS_RULES);
    expect(r.recommendation[0]).toBe('GO: no red or yellow signal.');
    expect(r.recommendation[1]).toMatch(/^Follow the planned microcycle/);
  });

  it('reports values and references of a signal', () => {
    const hrv = signal(input(), 'hrv');
    expect(hrv.value).toEqual({ last_night_ms: 60, status: 'BALANCED' });
    expect(hrv.reference).toEqual({ garmin_weekly_avg_ms: 60, garmin_baseline_low_ms: 50, garmin_baseline_high_ms: 70, mean28_ms: 60 });
    expect(signal(input(), 'training_readiness').value).toEqual({ score: 70, level: 'HIGH', recovery_h: 10 });
    expect(signal(input(), 'rhr').reference).toEqual({ mean28_bpm: 50 });
  });

  describe('hrv', () => {
    it.each(['LOW', 'POOR', 'UNBALANCED'])('Garmin status %s with the numbers in range: ok, status kept in value', (status) => {
      const s = signal(input({ hrv: { status } }), 'hrv');
      expect(s.rating).toBe('ok');
      expect(s.value).toEqual({ last_night_ms: 60, status });
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
    it('yellow below the baseline low or below hrv_yellow_weekly_factor × weekly', () => {
      expect(rating(input({ hrv: { baseline_low: 62 } }), 'hrv')).toBe('yellow');
      expect(rating(input({ hrv: { weekly_avg: 70 } }), 'hrv')).toBe('yellow');
      expect(rating(input({ hrv: { weekly_avg: 66 } }), 'hrv')).toBe('ok');
    });
    it('unknown without the night value', () => {
      expect(rating(input({ hrv: { last_night_avg: null } }), 'hrv')).toBe('unknown');
    });
    it('compares with the own mean only from 7 nights in the 28 before', () => {
      // 50 < 0.85 × 60 = 51 (red from the mean alone); baseline low 40 and weekly 50 do not fire.
      const withNights = (n: number): ReadinessInput => {
        const i = input({ hrv: { last_night_avg: 50, weekly_avg: 50, baseline_low: 40 } });
        return { ...i, hrv: [...history.slice(-n).map((d) => hrvRow(d)), i.hrv.at(-1)!] };
      };
      const six = signal(withNights(6), 'hrv');
      expect(six.rating).toBe('ok');
      expect(six.detail).toContain('28-day mean not compared: 6 of 7 nights needed.');
      expect(six.reference).not.toHaveProperty('mean28_ms');
      expect(signal(withNights(7), 'hrv')).toMatchObject({ rating: 'red', detail: expect.stringContaining('28-day mean 60') });
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
    it('red below sleep_h_red, yellow below sleep_h_yellow, from the hours alone', () => {
      expect(signal(input({ sleep: { duration_s: 5.9 * 3600 } }), 'sleep')).toMatchObject({ rating: 'red', detail: 'Sleep 5.9 h < 6 h.' });
      expect(rating(input({ sleep: { duration_s: 6.9 * 3600 } }), 'sleep')).toBe('yellow');
      expect(signal(input({ sleep: { score: 75, duration_s: 7 * 3600 } }), 'sleep')).toMatchObject({ rating: 'ok', detail: 'Sleep 7 h ≥ 7 h.' });
    });
    it('score 59 and 74 with 8 h: ok (red and yellow before E6-32), the score kept in value', () => {
      expect(signal(input({ sleep: { score: 59 } }), 'sleep')).toMatchObject({ rating: 'ok', value: { score: 59, hours: 8 } });
      expect(rating(input({ sleep: { score: 74 } }), 'sleep')).toBe('ok');
    });
    it('compares hours rounded to 0.1; score 70 without hours: unknown (yellow before E6-32), score shown', () => {
      expect(signal(input({ sleep: { duration_s: 6.96 * 3600 } }), 'sleep')).toMatchObject({ rating: 'ok', value: { score: 85, hours: 7 } });
      expect(rating(input({ sleep: { score: null, duration_s: 5 * 3600 } }), 'sleep')).toBe('red');
      expect(signal(input({ sleep: { score: 70, duration_s: null } }), 'sleep')).toMatchObject({ rating: 'unknown', value: { score: 70 } });
      expect(signal(input({ sleep: { score: null, duration_s: null } }), 'sleep')).toMatchObject({ rating: 'unknown', value: {} });
    });
  });

  describe('body_battery', () => {
    it('high 29, 49 and 50: info (red, yellow and ok before E6-32), unknown without the value', () => {
      for (const high of [29, 49, 50]) {
        expect(signal(input({ day: { body_battery_high: high } }), 'body_battery')).toEqual({
          name: 'body_battery',
          rating: 'info',
          value: { high },
          detail: "Garmin's Body Battery high, shown for reference, not counted",
        });
      }
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
      expect(r.counts).toEqual({ red: 0, yellow: 0, ok: 4, info: 3, unknown: 0 });
      // With the strictest count rule a single red or yellow would decide; info still does not.
      const strict = readiness(input({ training: trainingRow(20), rules: { decision_rule: 'count', decision_red_min: 1, decision_yellow_min: 1 } }));
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
    it('51 and 99 on the day before: info (yellow before E6-32); the day itself is ignored', () => {
      expect(signal(input({ yesterday: { avg_stress: 51 } }), 'stress')).toEqual({
        name: 'stress',
        rating: 'info',
        value: { avg: 51, date: '2026-05-09' },
        detail: "Garmin's average stress of 2026-05-09 (the day before), shown for reference, not counted",
      });
      expect(rating(input({ yesterday: { avg_stress: 99 } }), 'stress')).toBe('info');
      expect(signal(input({ day: { avg_stress: 90 } }), 'stress').value).toEqual({ avg: 30, date: '2026-05-09' });
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
    const LOAD = { date: D, tsb: 0, monotony: 1, warming_up: false };
    /** Input with the named signals red (and `extra` merged in). */
    const withRed = (names: readonly ReadinessSignalName[], extra: Parameters<typeof input>[0] = {}): ReadinessInput => {
      const over: Parameters<typeof input>[0] = { ...extra, day: { ...extra.day } };
      for (const name of names) {
        // HRV 50 < 0.85 × the 28-night mean 60; resting HR 55 = mean 50 + 5; sleep 5 h < 6 h; ACWR 1.6 > 1.5.
        if (name === 'hrv') over.hrv = { last_night_avg: 50, weekly_avg: 50, baseline_low: 40 };
        if (name === 'rhr') over.day = { ...over.day, resting_hr: 55 };
        if (name === 'sleep') over.sleep = { duration_s: 5 * 3600 };
        if (name === 'load') over.load = { ...LOAD, acwr: 1.6 };
      }
      return input(over);
    };
    const COUNT = { decision_rule: 'count' } as const;

    describe('decision_rule pairs (default)', () => {
      it.each(READINESS_RED_PAIRS.map(([a, b]) => [a, b]))('red %s with red %s: REST, naming the pair', (a, b) => {
        const r = readiness(withRed([a, b]));
        expect(r.counts.red).toBe(2);
        expect(r.decision).toBe('REST');
        expect(r.recommendation[0]).toBe(`REST: red ${a} + ${b} (decision_rule pairs).`);
        expect(r.recommendation).toHaveLength(4);
      });
      it.each(['hrv', 'rhr', 'sleep', 'load'] as const)('a single red %s: MODIFY, naming it', (name) => {
        const r = readiness(withRed([name]));
        expect(r.counts.red).toBe(1);
        expect(r.decision).toBe('MODIFY');
        expect(r.recommendation[0]).toBe(`MODIFY: 1 red (${name}) without a red pair (decision_rule pairs).`);
        expect(r.recommendation).toHaveLength(3);
      });
      it('two reds outside the pairs: MODIFY', () => {
        const r = readiness(withRed(['rhr', 'sleep'], { hrv: { weekly_avg: 70 } }));
        expect(r.decision).toBe('MODIFY');
        expect(r.recommendation[0]).toBe('MODIFY: 2 red (rhr, sleep) without a red pair (decision_rule pairs); 1 yellow (hrv).');
      });
      it('red hrv with Body Battery 20 and stress 60: MODIFY from hrv alone (2 red and 1 yellow before E6-32)', () => {
        const r = readiness(withRed(['hrv'], { day: { body_battery_high: 20 }, yesterday: { avg_stress: 60 } }));
        expect(r.decision).toBe('MODIFY');
        expect(r.counts).toEqual({ red: 1, yellow: 0, ok: 3, info: 3, unknown: 0 });
        expect(r.recommendation[0]).toBe('MODIFY: 1 red (hrv) without a red pair (decision_rule pairs).');
      });
      it('sleep score 50 with red hrv: no pair, MODIFY (REST hrv + sleep before E6-32)', () => {
        expect(readiness(withRed(['hrv'], { sleep: { score: 50 } })).decision).toBe('MODIFY');
      });
      it('Training Readiness 20 (info) alone: GO', () => {
        const r = readiness(input({ training: trainingRow(20), rules: { decision_rule: 'pairs' } }));
        expect(r.signals.find((s) => s.name === 'training_readiness')?.rating).toBe('info');
        expect(r.decision).toBe('GO');
        expect(r.recommendation[0]).toBe('GO: no red or yellow signal.');
      });
      it('Training Readiness 20 (info) with red hrv: no pair, MODIFY not REST', () => {
        const r = readiness(withRed(['hrv'], { training: trainingRow(20), rules: { decision_rule: 'pairs' } }));
        expect(r.counts).toEqual({ red: 1, yellow: 0, ok: 3, info: 3, unknown: 0 });
        expect(r.decision).toBe('MODIFY');
        expect(r.recommendation[0]).toBe('MODIFY: 1 red (hrv) without a red pair (decision_rule pairs).');
      });
      it('decide goes by rating, not by name: an info signal never completes a pair', () => {
        const rules = { ...DEFAULT_READINESS_RULES, decision_rule: 'pairs' } as const;
        const red = (name: ReadinessSignalName): ReadinessSignal => ({ name, rating: 'red', value: {}, detail: '' });
        const info = (name: ReadinessSignalName): ReadinessSignal => ({ name, rating: 'info', value: {}, detail: '' });
        for (const [a, b] of READINESS_RED_PAIRS) {
          expect(decide([red(a), info(b)], rules).decision).toBe('MODIFY');
          expect(decide([info(a), red(b)], rules).decision).toBe('MODIFY');
          expect(decide([info(a), info(b)], rules).decision).toBe('GO');
        }
      });
      it('every pair found is named', () => {
        const r = readiness(withRed(['hrv', 'rhr', 'sleep']));
        expect(r.recommendation[0]).toBe('REST: red hrv + rhr, hrv + sleep (decision_rule pairs).');
      });
      it('MODIFY at decision_yellow_min yellow signals, GO below it', () => {
        const r = readiness(input({ day: { resting_hr: 53 }, sleep: { duration_s: 6.5 * 3600 } }));
        expect(r.decision).toBe('MODIFY');
        expect(r.recommendation[0]).toBe('MODIFY: 2 yellow (rhr, sleep), at least decision_yellow_min 2.');
        const one = readiness(input({ sleep: { duration_s: 6.5 * 3600 } }));
        expect(one.decision).toBe('GO');
        expect(one.recommendation[0]).toBe('GO: 1 yellow (sleep), below decision_yellow_min 2.');
        expect(readiness(input({ sleep: { duration_s: 6.5 * 3600 }, rules: { decision_yellow_min: 1 } })).decision).toBe('MODIFY');
      });
      it('Body Battery 40 with sleep score 70: GO (MODIFY by 2 yellow before E6-32)', () => {
        const r = readiness(input({ day: { body_battery_high: 40 }, sleep: { score: 70 } }));
        expect(r.decision).toBe('GO');
        expect(r.recommendation[0]).toBe('GO: no red or yellow signal.');
      });
      it('decision_red_min does not change it', () => {
        expect(readiness(withRed(['rhr'], { rules: { decision_red_min: 1 } })).decision).toBe('MODIFY');
        expect(readiness(withRed(['hrv', 'rhr'], { rules: { decision_red_min: 3 } })).decision).toBe('REST');
      });
    });

    describe('decision_rule count', () => {
      it('REST at decision_red_min red signals, MODIFY at decision_yellow_min yellow ones', () => {
        const red = readiness(withRed(['sleep'], { rules: COUNT }));
        expect(red.decision).toBe('REST');
        expect(red.recommendation[0]).toBe('REST: 1 red (sleep), at least decision_red_min 1.');
        const r = readiness(input({ day: { resting_hr: 53 }, sleep: { duration_s: 6.5 * 3600 }, rules: COUNT }));
        expect(r.decision).toBe('MODIFY');
        expect(r.counts).toEqual({ red: 0, yellow: 2, ok: 2, info: 3, unknown: 0 });
        expect(r.recommendation).toHaveLength(3);
      });
      it('Body Battery 20 alone: GO (REST before E6-32); Body Battery 40 with sleep score 70: GO (MODIFY before E6-32)', () => {
        const bb = readiness(input({ day: { body_battery_high: 20 }, rules: COUNT }));
        expect(bb.decision).toBe('GO');
        expect(bb.recommendation[0]).toBe('GO: no red or yellow signal.');
        expect(readiness(input({ day: { body_battery_high: 40 }, sleep: { score: 70 }, rules: COUNT })).decision).toBe('GO');
      });
      it('decision_yellow_min and decision_red_min come from the rules', () => {
        const twoYellow = { day: { resting_hr: 53 }, sleep: { duration_s: 6.5 * 3600 } };
        expect(readiness(input({ ...twoYellow, rules: { ...COUNT, decision_yellow_min: 3 } })).decision).toBe('GO');
        expect(readiness(input({ day: { resting_hr: 53 }, rules: { ...COUNT, decision_yellow_min: 1 } })).decision).toBe('MODIFY');
        const below = readiness(withRed(['load'], { rules: { ...COUNT, decision_red_min: 2 } }));
        expect(below.decision).toBe('GO');
        expect(below.recommendation[0]).toBe('GO: 1 red (load), below decision_red_min 2 and decision_yellow_min 2.');
        const r = readiness(withRed(['rhr', 'sleep'], { rules: { ...COUNT, decision_red_min: 2 } }));
        expect(r.decision).toBe('REST');
        expect(r.recommendation).toHaveLength(4);
      });
      it('count and pairs on the data of the earlier tests: Body Battery and stress no longer vote, sleep red only from the hours (E6-32)', () => {
        // [reds, extra input, decision with count (red_min 1, yellow_min 2), decision with pairs]; before E6-32 in the comment.
        const cases: [ReadinessSignalName[], Parameters<typeof input>[0], string, string][] = [
          [[], {}, 'GO', 'GO'],
          [[], { day: { body_battery_high: 40 } }, 'GO', 'GO'],
          [[], { day: { body_battery_high: 40 }, yesterday: { avg_stress: 60 } }, 'GO', 'GO'], // was MODIFY, MODIFY
          [[], { day: { body_battery_high: 20 } }, 'GO', 'GO'], // was REST, MODIFY
          [[], { sleep: { score: 50 } }, 'GO', 'GO'], // was REST, MODIFY
          [['hrv'], { sleep: { score: 50 } }, 'REST', 'MODIFY'], // was REST, REST
          [['hrv'], {}, 'REST', 'MODIFY'],
          [['rhr'], {}, 'REST', 'MODIFY'],
          [['sleep'], {}, 'REST', 'MODIFY'],
          [['load'], {}, 'REST', 'MODIFY'],
          [['rhr', 'sleep'], {}, 'REST', 'MODIFY'],
          [['hrv', 'rhr'], {}, 'REST', 'REST'],
          [['load', 'sleep'], {}, 'REST', 'REST'],
        ];
        for (const [reds, extra, count, pairs] of cases) {
          const i = withRed(reds, extra);
          const c = readiness({ ...i, rules: { decision_rule: 'count', decision_red_min: 1, decision_yellow_min: 2 } }).counts;
          expect(c.red >= 1 ? 'REST' : c.yellow >= 2 ? 'MODIFY' : 'GO').toBe(count);
          expect(readiness({ ...i, rules: COUNT }).decision).toBe(count);
          expect(readiness(i).decision).toBe(pairs);
        }
      });
    });
  });

  describe('rules', () => {
    it('own rules override the defaults and are reported in rules_used', () => {
      const r = readiness(input({ rules: { sleep_h_yellow: 9, rhr_yellow_delta: 0 } }));
      expect(r.signals.find((s) => s.name === 'sleep')?.rating).toBe('yellow');
      expect(r.signals.find((s) => s.name === 'rhr')?.rating).toBe('yellow');
      expect(r.decision).toBe('MODIFY');
      expect(r.rules_used).toEqual({ ...DEFAULT_READINESS_RULES, sleep_h_yellow: 9, rhr_yellow_delta: 0 });
    });
    it('bb_yellow 85 with stress_yellow 25: ignored, GO (MODIFY before E6-32); sleep_score_* and bb_red are no rules either', () => {
      for (const key of ['sleep_score_red', 'sleep_score_yellow', 'bb_red', 'bb_yellow', 'stress_yellow']) {
        expect(DEFAULT_READINESS_RULES).not.toHaveProperty(key);
        expect(isReadinessRuleValue(key, 50)).toBe(false);
      }
      const r = readiness(input({ rules: { bb_yellow: 85, stress_yellow: 25, sleep_score_red: 90 } as ReadinessInput['rules'] }));
      expect(r.decision).toBe('GO');
      expect(r.rules_used).toEqual(DEFAULT_READINESS_RULES);
      expect(r.signals.find((s) => s.name === 'body_battery')?.rating).toBe('info');
      expect(r.signals.find((s) => s.name === 'stress')?.rating).toBe('info');
    });
    it('decision_rule is count or pairs; anything else keeps the default', () => {
      expect(resolveReadinessRules({ decision_rule: 'count' }).decision_rule).toBe('count');
      expect(resolveReadinessRules({ decision_rule: 'any' }).decision_rule).toBe('pairs');
      expect(resolveReadinessRules({ decision_rule: 1 }).decision_rule).toBe('pairs');
      expect(isReadinessRuleValue('decision_rule', 'pairs')).toBe(true);
      expect(isReadinessRuleValue('decision_rule', 'PAIRS')).toBe(false);
      expect(isReadinessRuleValue('sleep_h_red', 'count')).toBe(false);
      expect(isReadinessRuleValue('bogus', 1)).toBe(false);
      expect(readiness(input({ rules: { decision_rule: 'count' } })).rules_used.decision_rule).toBe('count');
    });
    it('resolveReadinessRules ignores missing and non-finite values', () => {
      expect(resolveReadinessRules()).toEqual(DEFAULT_READINESS_RULES);
      expect(resolveReadinessRules({ sleep_h_red: Number.NaN, sleep_h_yellow: undefined, rhr_red_delta: 6 })).toEqual({
        ...DEFAULT_READINESS_RULES,
        rhr_red_delta: 6,
      });
    });
    it('defaults match the spec 5.7 table without the Garmin score thresholds (E6-28, E6-32), with decision_rule pairs (E6-23)', () => {
      expect(DEFAULT_READINESS_RULES).toEqual({
        hrv_red_base_factor: 0.9,
        hrv_red_mean28_factor: 0.85,
        hrv_yellow_weekly_factor: 0.9,
        rhr_red_delta: 5,
        rhr_yellow_delta: 3,
        sleep_h_red: 6,
        sleep_h_yellow: 7,
        acwr_red: 1.5,
        acwr_yellow: 1.3,
        tsb_red: -30,
        tsb_yellow: -20,
        decision_rule: 'pairs',
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
