import { addDays, assertIsoDate, InputError, type IsoDate } from 'garmin-mcp-config';
import { compact, type Envelope, type GarminService, type ResponseMeta, type SyncProgressOptions } from 'garmin-mcp-domain';
import {
  parseRangeSet,
  SCOPE_DAILY,
  THRESHOLD_PARAMS,
  type DailyKind,
  type EnsureResult,
  type RangeSet,
  type ThresholdParam,
  type ThresholdRow,
  type ThresholdSource,
} from 'garmin-mcp-store';
import { efficiencyTrend, type EfficiencyRow } from './efficiency.js';
import { intensityDistribution, type IntensityDistribution } from './intensity.js';
import {
  DEFAULT_LOAD_FLAGS,
  LOAD_SOURCES,
  loadFlags,
  loadOn,
  loadSeries,
  resolveLoadFlags,
  weeklyBySport,
  type LoadDay,
  type LoadFlag,
  type LoadFlags,
  type LoadSource,
  type WeekSport,
} from './load.js';
import { DEFAULT_READINESS_RULES, readiness, READINESS_WINDOW_DAYS, type Readiness } from './readiness.js';
import { buildSessions, sessionFromActivity, sessionFromImported, type Session, type SessionInput } from './session.js';
import {
  hrmaxOn,
  recordProfileThresholds,
  restingHrOn,
  RHR_MIN_SAMPLES,
  RHR_WINDOW_DAYS,
  thresholdsBySport,
  type SportThresholds,
  type ThresholdSport,
} from './thresholds.js';

/** Default `get_load` range: the last 28 days. */
export const DEFAULT_LOAD_DAYS = 28;
/** CTL needs about this many days of history before `from` to settle (EWMA 42 days). */
export const CTL_WARMUP_DAYS = 42;
/** Sources `set_threshold` may write; `garmin-auto` and `import` come from the profile and the CSV import. */
export const SET_THRESHOLD_SOURCES = ['test', 'manual'] as const satisfies readonly ThresholdSource[];

export interface AnalyticsServiceOptions {
  /** Max time a read waits for on-demand fetches (only with `fetchOnDemand`), as in `GarminService` (20 s). */
  budgetMs?: number;
  now?: () => number;
}

export interface LoadQuery {
  from?: string;
  to?: string;
  source?: LoadSource;
  include_series?: boolean;
  include_activities?: boolean;
  include_efficiency?: boolean;
  /** Overrides of `DEFAULT_LOAD_FLAGS`; unknown keys and non-numbers are ignored with a note. */
  flags?: Record<string, unknown>;
}

/** Thresholds the load model used on `to`: `by_sport` as in `get_thresholds`, and the resting HR. */
export interface ThresholdsUsed {
  date: IsoDate;
  by_sport: Record<ThresholdSport, SportThresholds>;
  rhr: number;
}

export interface LoadData {
  from: IsoDate;
  to: IsoDate;
  source: LoadSource;
  /** The load model on `to` (absent without any activity up to `to`). */
  latest?: LoadDay;
  flags: LoadFlag[];
  flags_used: LoadFlags;
  weeks: WeekSport[];
  /** Run and bike intensity of the last 28 days of the range. */
  intensity: IntensityDistribution;
  thresholds_used: ThresholdsUsed;
  series?: LoadDay[];
  activities?: Session[];
  efficiency?: EfficiencyRow[];
  note: string;
}

export interface ReadinessQuery {
  date?: string;
  /** Overrides of `DEFAULT_READINESS_RULES`; unknown keys and non-numbers are ignored with a note. */
  rules?: Record<string, unknown>;
}

export interface ThresholdsQuery {
  date?: string;
  param?: string;
  history?: boolean;
}

/** The row a threshold value comes from on a date. */
export interface EffectiveThreshold {
  value: number;
  /** Date of the row; later than the asked date when the value is carried back. */
  since: IsoDate;
  source: ThresholdSource;
  note?: string;
}

export interface ThresholdHistoryRow {
  date: IsoDate;
  param: ThresholdParam;
  value: number;
  source: ThresholdSource;
  note?: string;
}

export interface ThresholdsData {
  date: IsoDate;
  effective: Partial<Record<ThresholdParam, EffectiveThreshold>>;
  history?: ThresholdHistoryRow[];
  /** LTHR and LT1 per sport on `date` (`lthrFor`/`lt1For`), the contract plan-v2 builds its zones from. */
  by_sport: Record<ThresholdSport, SportThresholds>;
  /** HRmax on `date`; without any `hrmax` row only a note. */
  hrmax: { value?: number; note?: string };
  /** Resting HR the load model uses on `date`: mean of the 28 days before, else the `rhr` row, else 50. */
  rhr_28d: { value: number; samples: number; note?: string };
}

export interface SetThresholdInput {
  date: string;
  param: string;
  value: number;
  source?: string;
  note?: string;
}

export interface SetThresholdData {
  added: boolean;
  row: ThresholdHistoryRow;
  /** The value of `param` analytics uses from now on (on today). */
  effective: EffectiveThreshold & { date: IsoDate; param: ThresholdParam };
  note?: string;
}

const PARTIAL_NOTE = 'Garmin is still being synced in the background; ask again shortly for complete data.';

function mergeSource(results: readonly EnsureResult[]): ResponseMeta['source'] {
  if (results.some((r) => r.source === 'partial')) return 'partial';
  if (results.some((r) => r.source === 'live')) return 'live';
  return 'cache';
}

/** `meta` of a read: source of the on-demand fetches, the service's coverage gap, then the notes. */
function readMeta(results: readonly EnsureResult[], gap: Partial<ResponseMeta>, notes: readonly string[] = []): ResponseMeta {
  const source = mergeSource(results);
  const all = [source === 'partial' ? PARTIAL_NOTE : undefined, gap.note, ...notes].filter((n): n is string => !!n);
  return compact({ ...gap, source, note: all.length ? all.join(' ') : undefined });
}

/**
 * A read's data gap joined with the profile gap: one `sync_hint` (both missing: `scope: "all"`
 * over the data range, which includes the reference sync), notes in that order.
 */
function withProfileGap(data: Partial<ResponseMeta>, profile: Partial<ResponseMeta>): Partial<ResponseMeta> {
  if (!profile.sync_hint) return data;
  if (!data.sync_hint) return profile;
  const note = data.note ? `${data.note} The Garmin profile is missing too.` : profile.note;
  return compact({ ...data, note, sync_hint: { ...data.sync_hint, scope: 'all' as const } });
}

const inRanges = (set: RangeSet, date: IsoDate): boolean => set.some(([a, b]) => date >= a && date <= b);

/** Finite-number overrides for the known keys; the rest is reported in a note. */
function overrides(input: Record<string, unknown> | undefined, defaults: object, what: string): { values: Record<string, number>; note?: string } {
  const values: Record<string, number> = {};
  const ignored: string[] = [];
  for (const [k, v] of Object.entries(input ?? {})) {
    if (Object.hasOwn(defaults, k) && typeof v === 'number' && Number.isFinite(v)) values[k] = v;
    else ignored.push(k);
  }
  if (ignored.length === 0) return { values };
  return { values, note: `Ignored ${what} (unknown key or not a number): ${ignored.join(', ')}; valid keys: ${Object.keys(defaults).join(', ')}.` };
}

function assertParam(param: string): ThresholdParam {
  if ((THRESHOLD_PARAMS as readonly string[]).includes(param)) return param as ThresholdParam;
  throw new InputError(`Unknown threshold param "${param}"`, `Valid params: ${THRESHOLD_PARAMS.join(', ')}.`);
}

/** The row `thresholdOn` takes its value from: latest date ≤ `date` (same date: the later row), else the first. */
function effectiveRow(rows: readonly ThresholdRow[], param: ThresholdParam, date: IsoDate): ThresholdRow | undefined {
  const own = rows.filter((r) => r.param === param).toSorted((a, b) => a.date.localeCompare(b.date));
  return own.findLast((r) => r.date <= date) ?? own[0];
}

const effectiveOf = (r: ThresholdRow): EffectiveThreshold => ({ value: r.value, since: r.date, source: r.source, note: r.note ?? undefined });
const historyOf = (r: Pick<ThresholdRow, 'date' | 'param' | 'value' | 'source' | 'note'>): ThresholdHistoryRow => ({
  date: r.date,
  param: r.param,
  value: r.value,
  source: r.source,
  note: r.note ?? undefined,
});

/**
 * Use cases of the analytics tools and CLI commands: read the cache through `GarminService`
 * (never the Garmin client), compute with the pure functions of this package, and answer
 * with the `{ data, meta }` envelope of the other tools. `meta.sync_hint` comes from
 * `GarminService.coverage`, and each read goes through `withAutoSync`. Every read first makes
 * sure the Garmin profile is cached (`ensureReference`, as `get_profile`; without auto fetch a
 * missing profile is a `sync_hint` with `scope: "reference"`), then records its changed
 * thresholds (`recordProfileThresholds`, offline), as `setThreshold` does without the fetch.
 */
export class AnalyticsService {
  readonly garmin: GarminService;
  readonly #budget: number;
  readonly #now: () => number;

  constructor(garmin: GarminService, opts: AnalyticsServiceOptions = {}) {
    this.garmin = garmin;
    this.#budget = opts.budgetMs ?? 20_000;
    this.#now = opts.now ?? Date.now;
  }

  get #store() {
    return this.garmin.store;
  }

  #recordProfile(): void {
    recordProfileThresholds(this.#store, this.#now(), this.garmin.timeZone);
  }

  /** Fetch the Garmin profile when missing or stale (only with `fetchOnDemand`), then record its thresholds. */
  async #profile(): Promise<{ ensured: EnsureResult; gap: Partial<ResponseMeta> }> {
    const ensured = await this.garmin.syncer.ensureReference('profile', this.#budget);
    this.#recordProfile();
    return { ensured, gap: this.garmin.referenceCoverage('profile') };
  }

  /**
   * Every session up to `to`: stored activities (RPE/feel from their summary detail, when
   * fetched) plus imported CSV activities on dates outside `activities:covered`, with the
   * thresholds valid on each date.
   */
  #sessions(to: IsoDate): { sessions: Session[]; notes: string[]; thresholds: ThresholdRow[]; daily: { date: IsoDate; resting_hr: number | null }[] } {
    const store = this.#store;
    const inputs: SessionInput[] = store
      .queryActivities({ to, sort: 'asc' })
      .flatMap((a) => sessionFromActivity(a, store.getActivityDetail(a.id, 'summary')?.raw) ?? []);
    const covered = parseRangeSet(store.getMeta('activities:covered'));
    for (const r of store.getImportedActivities('0000-01-01', to)) {
      if (!inRanges(covered, r.date)) inputs.push(sessionFromImported(r));
    }
    const thresholds = store.listThresholds();
    const first = inputs.reduce<IsoDate | undefined>((m, s) => (m === undefined || s.date < m ? s.date : m), undefined);
    const daily = store
      .getDaily('daily_summary', addDays(first !== undefined && first < to ? first : to, -RHR_WINDOW_DAYS), to)
      .map((d) => ({ date: d.date, resting_hr: d.resting_hr }));
    const { sessions, notes } = buildSessions(inputs, { thresholds, daily });
    return { sessions, notes, thresholds, daily };
  }

  // ------------------------------------------------------------ get_load

  /** Own load model over [from, to] (default: the last 28 days); the series always starts at the first stored activity. */
  async getLoad(q: LoadQuery = {}, opts: SyncProgressOptions = {}): Promise<Envelope<LoadData>> {
    return this.garmin.withAutoSync(() => this.#load(q), opts);
  }

  async #load(q: LoadQuery): Promise<Envelope<LoadData>> {
    const { from, to } = this.garmin.range(q.from, q.to, DEFAULT_LOAD_DAYS);
    const source = q.source ?? 'hrtss';
    if (!LOAD_SOURCES.includes(source)) throw new InputError(`Unknown load source "${String(source)}"`, `Use one of: ${LOAD_SOURCES.join(', ')}.`);
    const flagInput = overrides(q.flags, DEFAULT_LOAD_FLAGS, 'flags');
    const flags = resolveLoadFlags(flagInput.values);
    const today = this.garmin.today();
    const end = to > today ? to : today;
    const [profile, ...ensured] = await Promise.all([
      this.#profile(),
      this.garmin.syncer.ensureActivities(from, to, this.#budget),
      this.garmin.syncer.ensureDaily(['daily_summary'], addDays(from, -RHR_WINDOW_DAYS), to, this.#budget),
    ]);

    const { sessions, notes, thresholds, daily } = this.#sessions(end);
    const series = loadSeries(sessions, source, end);
    const latest = loadOn(series, to);
    const inRange = sessions.filter((s) => s.date >= from && s.date <= to);
    const last28 = addDays(to, -(DEFAULT_LOAD_DAYS - 1));
    const intensity = intensityDistribution(sessions, thresholds, last28 > from ? last28 : from, to, flags.z1_min_pct);
    const flagList = loadFlags(latest, sessions, flags);
    if (intensity.z1_below_target) {
      flagList.push({
        code: 'z1_below_target',
        text: `Z1 is ${intensity.z1_pct}% of run and bike time (${intensity.from}..${intensity.to}), below ${flags.z1_min_pct}%: more easy volume below LT1 is needed for a polarized or pyramidal distribution.`,
      });
    }

    const bySport = thresholdsBySport(thresholds, to);
    const rhr = restingHrOn(daily, thresholds, to);
    const allNotes = new Set(notes);
    // The default-LTHR and LT1-approximation notes are the same for every sport, so the running
    // ones cover them; the bike/swim fallback notes stay in by_sport.
    for (const n of [bySport.run.lthr_note, bySport.run.lt1_note, rhr.note]) if (n) allNotes.add(n);
    const firstDay = series[0]?.date;
    if (firstDay !== undefined && firstDay > addDays(from, -CTL_WARMUP_DAYS)) {
      allNotes.add(`The activity history starts on ${firstDay}; CTL needs about ${CTL_WARMUP_DAYS} days before ${from} to settle, so it reads low until then.`);
    }
    if (flagInput.note) allNotes.add(flagInput.note);

    const note =
      source === 'hrtss'
        ? "Own load model: daily hrTSS from heart rate with the thresholds valid on each date (LTHR per sport, 28-day resting HR); CTL/ATL are 42/7-day EWMAs, TSB = CTL - ATL at the start of the day, ACWR = 7-day / 28-day mean. It differs from computed_load in get_training_status, which runs the same EWMA on Garmin's EPOC training load."
        : "Daily load is the sum of Garmin's per-activity training load (EPOC), as in computed_load of get_training_status; imported activities have no Garmin load and count 0.";

    const data: LoadData = {
      from,
      to,
      source,
      latest,
      flags: flagList,
      flags_used: flags,
      weeks: weeklyBySport(inRange),
      intensity,
      thresholds_used: { date: to, by_sport: bySport, rhr: rhr.value },
      series: q.include_series ? series.filter((d) => d.date >= from && d.date <= to) : undefined,
      activities: q.include_activities ? inRange : undefined,
      efficiency: q.include_efficiency ? efficiencyTrend(inRange, 'month') : undefined,
      note,
    };
    const gap = withProfileGap(this.garmin.coverage('period', from, to, ['daily_summary']), profile.gap);
    return { data: compact(data), meta: readMeta([profile.ensured, ...ensured], gap, [...allNotes]) };
  }

  // ------------------------------------------------------------ get_readiness

  /** Morning GO / MODIFY / REST decision for `date` (default: today) from the rows of [date − 28, date]. */
  async getReadiness(q: ReadinessQuery = {}, opts: SyncProgressOptions = {}): Promise<Envelope<Readiness>> {
    return this.garmin.withAutoSync(() => this.#readiness(q), opts);
  }

  async #readiness(q: ReadinessQuery): Promise<Envelope<Readiness>> {
    const today = this.garmin.today();
    const date = q.date ? assertIsoDate(q.date, 'date') : today;
    if (date > today) throw new InputError(`date (${date}) is in the future`, `Readiness needs the night and morning of the day; use a date up to ${today}.`);
    const ruleInput = overrides(q.rules, DEFAULT_READINESS_RULES, 'rules');
    const from = addDays(date, -READINESS_WINDOW_DAYS);
    const kinds: readonly DailyKind[] = SCOPE_DAILY.all;
    const [profile, ...ensured] = await Promise.all([
      this.#profile(),
      this.garmin.syncer.ensureDaily(kinds, from, date, this.#budget),
      this.garmin.syncer.ensureActivities(from, date, this.#budget),
    ]);

    const store = this.#store;
    const { sessions, notes } = this.#sessions(date);
    const load = loadOn(loadSeries(sessions, 'hrtss', date), date);
    const result = readiness({
      date,
      today,
      timeZone: this.garmin.timeZone,
      daily: store.getDaily('daily_summary', from, date),
      sleep: store.getDaily('sleep', from, date),
      hrv: store.getDaily('hrv', from, date),
      training: store.getDaily('training_status', from, date),
      load,
      rules: ruleInput.values,
    });
    const allNotes = ruleInput.note ? [...notes, ruleInput.note] : notes;
    const gap = withProfileGap(this.garmin.coverage('period', from, date, kinds), profile.gap);
    return { data: compact(result), meta: readMeta([profile.ensured, ...ensured], gap, allNotes) };
  }

  // ------------------------------------------------------------ get_thresholds

  /** Threshold values effective on `date` (default: today), optionally with the whole history. */
  async getThresholds(q: ThresholdsQuery = {}, opts: SyncProgressOptions = {}): Promise<Envelope<ThresholdsData>> {
    return this.garmin.withAutoSync(() => this.#thresholds(q), opts);
  }

  async #thresholds(q: ThresholdsQuery): Promise<Envelope<ThresholdsData>> {
    const date = q.date ? assertIsoDate(q.date, 'date') : this.garmin.today();
    const param = q.param === undefined ? undefined : assertParam(q.param);
    const window = { from: addDays(date, -RHR_WINDOW_DAYS), to: addDays(date, -1) };
    const [profile, ensured] = await Promise.all([
      this.#profile(),
      this.garmin.syncer.ensureDaily(['daily_summary'], window.from, window.to, this.#budget),
    ]);

    const rows = this.#store.listThresholds();
    const effective: ThresholdsData['effective'] = {};
    for (const p of param ? [param] : THRESHOLD_PARAMS) {
      const r = effectiveRow(rows, p, date);
      if (r) effective[p] = effectiveOf(r);
    }
    const daily = this.#store.getDaily('daily_summary', window.from, window.to).map((d) => ({ date: d.date, resting_hr: d.resting_hr }));
    const samples = daily.filter((d) => d.resting_hr !== null && Number.isFinite(d.resting_hr) && d.resting_hr > 0).length;
    const rhr = restingHrOn(daily, rows, date);
    const rhrNote =
      rhr.note ?? (samples < RHR_MIN_SAMPLES ? `Fewer than ${RHR_MIN_SAMPLES} days with a resting HR in the 28 before ${date}; the rhr threshold is used.` : undefined);
    const data: ThresholdsData = {
      date,
      effective,
      history: q.history ? rows.filter((r) => !param || r.param === param).map(historyOf) : undefined,
      by_sport: thresholdsBySport(rows, date),
      hrmax: hrmaxOn(rows, date),
      rhr_28d: { value: rhr.value, samples, note: rhrNote },
    };
    const gap = withProfileGap(this.garmin.coverage('daily', window.from, window.to, ['daily_summary']), profile.gap);
    return { data: compact(data), meta: readMeta([profile.ensured, ensured], gap) };
  }

  // ------------------------------------------------------------ set_threshold

  /**
   * Records a threshold (field test or manual value) effective from `date`. A row with the
   * same date, param and source is left as it is (`added: false`, see the note). Local only.
   */
  async setThreshold(input: SetThresholdInput): Promise<Envelope<SetThresholdData>> {
    const today = this.garmin.today();
    const date = assertIsoDate(input.date, 'date');
    if (date > today) throw new InputError(`date (${date}) is in the future`, `A threshold is recorded from the day it was measured; use a date up to ${today}.`);
    const param = assertParam(input.param);
    const source = input.source ?? 'test';
    if (!(SET_THRESHOLD_SOURCES as readonly string[]).includes(source)) {
      throw new InputError(`Unknown threshold source "${source}"`, `Use one of: ${SET_THRESHOLD_SOURCES.join(', ')}.`);
    }
    if (!Number.isFinite(input.value) || input.value <= 0) throw new InputError(`value must be a positive number, got ${input.value}`);
    const note = input.note?.trim() || undefined;
    this.#recordProfile();

    const row = { date, param, value: input.value, source: source as ThresholdSource, note: note ?? null, created_at: this.#now() };
    const { added } = this.#store.addThreshold(row);
    const rows = this.#store.listThresholds(param);
    const existing = added ? undefined : rows.find((r) => r.date === date && r.source === source);
    // The date is not in the future, so the value in use from now on is today's.
    const asOf = today;
    const eff = effectiveRow(rows, param, asOf) as ThresholdRow;
    const data: SetThresholdData = {
      added,
      row: historyOf(existing ?? row),
      effective: { date: asOf, param, ...effectiveOf(eff) },
      note: existing
        ? `A ${source} row for ${param} on ${date} already exists (value ${existing.value}); it was not changed. Use another date or source to record a different value.`
        : eff.date > date
          ? `A later row (${eff.date}, ${eff.source}) stays in effect on ${asOf}; the new value applies to ${date}..${addDays(eff.date, -1)}.`
          : undefined,
    };
    return { data: compact(data), meta: { source: 'local' } };
  }
}
