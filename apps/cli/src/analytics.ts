import type { LoadData, Readiness, SetThresholdData, ThresholdHistoryRow, ThresholdsData } from 'garmin-mcp-analytics';
import { csvLine, parseCsv } from 'garmin-mcp-analytics';
import { assertIsoDate, InputError } from 'garmin-mcp-config';
import type { Envelope, ResponseMeta } from 'garmin-mcp-domain';
import { THRESHOLD_PARAMS, type NewThreshold, type ThresholdParam, type ThresholdSource } from 'garmin-mcp-store';
import fs from 'node:fs';

/** Markdown table; `|` and line breaks in cells are escaped. */
export function mdTable(rows: readonly object[], columns?: readonly string[]): string {
  if (rows.length === 0) return '_(no rows)_';
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v: unknown) =>
    v === undefined || v === null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v)).replaceAll('|', String.raw`\|`).replaceAll(/\r?\n/g, ' ');
  return [`| ${cols.join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${cols.map((c) => cell((r as Record<string, unknown>)[c])).join(' | ')} |`)].join('\n');
}

const hm = (s: number | undefined) => (s === undefined ? undefined : `${Math.floor(s / 3600)}:${String(Math.round((s % 3600) / 60)).padStart(2, '0')}`);
const km = (m: number | undefined) => (m === undefined ? undefined : Math.round(m / 10) / 100);

/** Notes of `meta` (defaults, approximations, missing data with the sync command) as a quote block. */
function metaBlock(meta: ResponseMeta): string[] {
  const lines = [meta.source === 'partial' ? 'Some data is still being synced.' : undefined, meta.note].filter((l): l is string => !!l);
  return lines.length ? ['', ...lines.map((l) => `> ${l}`)] : [];
}

/** Reads a JSON object (flags, rules) from a file. */
export function readJsonObject(file: string, option: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new InputError(`${option}: cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`, 'Pass a JSON file with an object, e.g. {"acwr_high": 1.4}.');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new InputError(`${option}: ${file} must hold a JSON object`);
  return value as Record<string, unknown>;
}

export function loadMarkdown({ data, meta }: Envelope<LoadData>): string {
  const l = data.latest;
  const out = [`# Load ${data.from}..${data.to} (${data.source})`, ''];
  out.push(l ? mdTable([l], ['date', 'tss', 'ctl', 'atl', 'tsb', 'acwr', 'monotony', 'strain']) : `No activity up to ${data.to}.`);
  if (data.flags?.length) out.push('', '## Flags', '', ...data.flags.map((f) => `- **${f.code}**: ${f.text}`));
  out.push('', '## Weeks', '', mdTable(data.weeks ?? [], ['week', 'sport', 'sessions', 'hours', 'km', 'elev_m', 'hrtss', 'g_load', 'z12_h', 'z3_h', 'z45_h']));
  const i = data.intensity;
  out.push(
    '',
    `## Intensity ${i.from}..${i.to} (run and bike)`,
    '',
    mdTable(
      [
        { zone: 'Z1 (below LT1)', min: i.z1_min, pct: i.z1_pct },
        { zone: 'Z2 (LT1 to LTHR)', min: i.z2_min, pct: i.z2_pct },
        { zone: 'Z3 (above LTHR)', min: i.z3_min, pct: i.z3_pct },
      ],
      ['zone', 'min', 'pct'],
    ),
    '',
    `Sessions with Garmin HR zones: ${i.sessions_with_zones}, by average HR: ${i.sessions_by_avg_hr}.`,
  );
  const t = data.thresholds_used;
  out.push(
    '',
    `## Thresholds on ${t.date}`,
    '',
    mdTable(
      Object.entries(t.by_sport).map(([sport, s]) => ({ sport, lthr: s.lthr, lt1: s.lt1, note: [s.lthr_note, s.lt1_note].filter(Boolean).join(' ') })),
      ['sport', 'lthr', 'lt1', 'note'],
    ),
    '',
    `Resting HR: ${t.rhr}`,
  );
  if (data.series) out.push('', '## Series', '', mdTable(data.series, ['date', 'tss', 'ctl', 'atl', 'tsb', 'acwr', 'monotony', 'strain']));
  if (data.activities) {
    out.push(
      '',
      '## Activities',
      '',
      mdTable(
        data.activities.map((a) => ({ ...a, duration: hm(a.duration_s), km: km(a.distance_m) })),
        ['date', 'sport', 'type', 'name', 'duration', 'km', 'avg_hr', 'if', 'hrtss', 'ef', 'ef_gap', 'lthr_used', 'lt1_used', 'rhr_used', 'source'],
      ),
    );
  }
  if (data.efficiency) out.push('', '## Efficiency (aerobic sessions)', '', mdTable(data.efficiency, ['period', 'sport', 'n', 'ef_avg', 'ef_max', 'ef_gap_avg']));
  out.push('', data.note, ...metaBlock(meta));
  return out.join('\n');
}

export function readinessMarkdown({ data, meta }: Envelope<Readiness>): string {
  const out = [`# Readiness ${data.date}: ${data.decision}${data.partial ? ' (partial day)' : ''}`, ''];
  out.push(`Red ${data.counts.red}, yellow ${data.counts.yellow}, ok ${data.counts.ok}, unknown ${data.counts.unknown}.`, '');
  out.push(mdTable(data.signals.map((s) => ({ signal: s.name, rating: s.rating, detail: s.detail })), ['signal', 'rating', 'detail']));
  const advice = data.recommendation ?? [];
  if (advice.length) out.push('', '## Advice', '', ...advice.map((r) => `- ${r}`));
  out.push(...metaBlock(meta));
  return out.join('\n');
}

export function thresholdsMarkdown({ data, meta }: Envelope<ThresholdsData>): string {
  const out = [`# Thresholds on ${data.date}`, ''];
  out.push(
    mdTable(
      Object.entries(data.effective ?? {}).map(([param, e]) => ({ param, value: e.value, since: e.since, source: e.source, note: e.note })),
      ['param', 'value', 'since', 'source', 'note'],
    ),
  );
  out.push(
    '',
    '## By sport',
    '',
    mdTable(
      Object.entries(data.by_sport).map(([sport, s]) => ({ sport, lthr: s.lthr, lt1: s.lt1, note: [s.lthr_note, s.lt1_note].filter(Boolean).join(' ') })),
      ['sport', 'lthr', 'lt1', 'note'],
    ),
    '',
    `HRmax: ${data.hrmax.value ?? '-'}${data.hrmax.note ? ` (${data.hrmax.note})` : ''}`,
    `Resting HR (28 days): ${data.rhr_28d.value} from ${data.rhr_28d.samples} days${data.rhr_28d.note ? ` (${data.rhr_28d.note})` : ''}`,
  );
  if (data.history) out.push('', '## History', '', mdTable(data.history, ['date', 'param', 'value', 'source', 'note']));
  out.push(...metaBlock(meta));
  return out.join('\n');
}

export function setThresholdText({ data }: Envelope<SetThresholdData>): string {
  const r = data.row;
  const e = data.effective;
  const head = data.added ? `Added ${r.param} = ${r.value} from ${r.date} (${r.source}).` : `Not added: ${r.param} on ${r.date} (${r.source}) is already ${r.value}.`;
  return [head, `In effect on ${e.date}: ${e.param} = ${e.value} (since ${e.since}, ${e.source}).`, ...(data.note ? [data.note] : [])].join('\n');
}

// ------------------------------------------------------------ threshold history as CSV

export const THRESHOLDS_CSV_HEADER = ['date', 'param', 'value', 'source', 'note'] as const;
/** Sources a threshold CSV may bring in; `garmin-auto` rows come from the Garmin profile and are left out. */
export const IMPORT_THRESHOLD_SOURCES = ['test', 'manual', 'import'] as const satisfies readonly ThresholdSource[];

export function thresholdsCsv(rows: readonly ThresholdHistoryRow[]): string {
  return [csvLine(THRESHOLDS_CSV_HEADER), ...rows.map((r) => csvLine([r.date, r.param, r.value, r.source, r.note]))].join('\n') + '\n';
}

/**
 * Rows of a threshold CSV (`date,param,value,source,note`, header required). An empty source
 * is `import`; `garmin-auto` rows are counted and left out. Any other invalid row rejects the
 * whole file, so nothing is half imported.
 */
export function parseThresholdsCsv(text: string, file: string, now: number): { rows: NewThreshold[]; garminAuto: number } {
  const [head, ...records] = parseCsv(text);
  const cols = head?.fields.map((h) => h.trim().toLowerCase()) ?? [];
  const idx = Object.fromEntries(THRESHOLDS_CSV_HEADER.map((c) => [c, cols.indexOf(c)])) as Record<(typeof THRESHOLDS_CSV_HEADER)[number], number>;
  if (idx.date < 0 || idx.param < 0 || idx.value < 0) throw new InputError(`${file}: the header must have date,param,value (and optionally source,note)`);
  const rows: NewThreshold[] = [];
  const errors: string[] = [];
  let garminAuto = 0;
  for (const r of records) {
    const get = (c: keyof typeof idx) => (idx[c] < 0 ? '' : (r.fields[idx[c]] ?? '').trim());
    const source = get('source') || 'import';
    if (source === 'garmin-auto') {
      garminAuto++;
      continue;
    }
    const value = Number(get('value'));
    const problems = [
      /^\d{4}-\d{2}-\d{2}$/.test(get('date')) ? undefined : `date "${get('date')}"`,
      (THRESHOLD_PARAMS as readonly string[]).includes(get('param')) ? undefined : `param "${get('param')}"`,
      get('value') !== '' && Number.isFinite(value) && value > 0 ? undefined : `value "${get('value')}"`,
      (IMPORT_THRESHOLD_SOURCES as readonly string[]).includes(source) ? undefined : `source "${source}"`,
    ].filter(Boolean);
    if (problems.length) {
      errors.push(`line ${r.line}: ${problems.join(', ')}`);
      continue;
    }
    rows.push({
      date: assertIsoDate(get('date'), 'date'),
      param: get('param') as ThresholdParam,
      value,
      source: source as ThresholdSource,
      note: get('note') || null,
      created_at: now,
    });
  }
  if (errors.length) {
    throw new InputError(
      `${file}: ${errors.length} invalid row(s), nothing imported: ${errors.slice(0, 5).join('; ')}${errors.length > 5 ? '; ...' : ''}`,
      `Params: ${THRESHOLD_PARAMS.join(', ')}; sources: ${IMPORT_THRESHOLD_SOURCES.join(', ')}; value > 0.`,
    );
  }
  return { rows, garminAuto };
}
