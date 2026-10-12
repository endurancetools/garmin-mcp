import { parseRangeSet, type ImportedActivityInput, type Store } from 'garmin-mcp-store';
import { createHash } from 'node:crypto';
import { parseCsv } from './csv.js';
import { sportGroup } from './sport.js';

/** Fields read from a Garmin Connect "Activities" CSV export. */
type Field =
  | 'type'
  | 'date'
  | 'name'
  | 'distance'
  | 'duration'
  | 'moving'
  | 'avg_hr'
  | 'max_hr'
  | 'gain'
  | 'loss'
  | 'calories'
  | 'avg_power'
  | 'norm_power'
  | 'cadence'
  | 'te_aerobic'
  | 'te_anaerobic';

/**
 * Header names per field, English and Polish, compared lower-case without `®`/`™`. The
 * first alias whose column has a value wins (so a bike row without `Avg Run Cadence`
 * takes `Avg Bike Cadence`); a header repeated in the file counts by its first column.
 */
const ALIASES: Record<Field, readonly string[]> = {
  type: ['activity type', 'typ aktywności'],
  date: ['date', 'data'],
  name: ['title', 'tytuł'],
  distance: ['distance', 'dystans'],
  duration: ['time', 'czas', 'elapsed time', 'czas, który upłynął'],
  moving: ['moving time', 'czas w ruchu'],
  avg_hr: ['avg hr', 'śr. tętno'],
  max_hr: ['max hr', 'maks. tętno'],
  gain: ['total ascent', 'ascent', 'wzniesienie', 'całkowite wzniesienie'],
  loss: ['total descent', 'descent', 'zejście', 'całkowite zejście'],
  calories: ['calories', 'kalorie'],
  avg_power: ['avg power', 'śr. moc'],
  norm_power: ['normalized power (np)', 'normalized power', 'znormalizowana moc (np)', 'znormalizowana moc'],
  cadence: ['avg run cadence', 'avg bike cadence', 'avg cadence', 'śr. kadencja biegu', 'śr. kadencja roweru', 'śr. kadencja'],
  te_aerobic: ['aerobic te', 'te aerobowy'],
  te_anaerobic: ['anaerobic te', 'te anaerobowy'],
};

/** Activity types of the export that are not training (fall detection entries). */
const SKIPPED_TYPES = new Set(['incident detected', 'wykryto incydent']);

// Polish labels of the export mapped to an English word `sportGroup` knows; first match wins.
const POLISH_TYPES: readonly (readonly [RegExp, string])[] = [
  [/bieg/, 'running'],
  [/kolarstwo|rower/, 'cycling'],
  [/pływanie/, 'swimming'],
  [/siłow/, 'strength_training'],
  [/kardio/, 'cardio'],
  [/joga/, 'yoga'],
  [/wędrówk|turystyk/, 'hiking'],
  [/chód|spacer/, 'walking'],
  [/narciarstwo|narty/, 'skiing'],
];

const header = (h: string): string => h.replaceAll(/[®™]/g, '').replaceAll(/\s+/g, ' ').trim().toLowerCase();

/** `--` and empty cells are missing. */
const missing = (v: string | undefined): boolean => v === undefined || v.trim() === '' || v.trim() === '--';

/** A number with thousands commas (`1,234`); `--` and anything else non-numeric is null. */
export function csvNumber(v: string | undefined): number | null {
  if (missing(v)) return null;
  const n = Number((v as string).trim().replaceAll(',', ''));
  return Number.isFinite(n) ? n : null;
}

/** Seconds from `h:mm:ss`, `mm:ss` (optionally with a fraction) or plain seconds; null when unreadable. */
export function csvDuration(v: string | undefined): number | null {
  if (missing(v)) return null;
  const parts = (v as string).trim().split(':');
  if (parts.length > 3) return null;
  let s = 0;
  for (const p of parts) {
    const n = Number(p.replaceAll(',', ''));
    if (p === '' || !Number.isFinite(n) || n < 0) return null;
    s = s * 60 + n;
  }
  return Math.round(s * 10) / 10;
}

/** Type key from the export's label: `Trail Running` → `trail_running`, Polish labels → the English sport word. */
export function activityTypeKey(label: string): string {
  const l = label.trim().toLowerCase();
  const key = l.replaceAll(/[^\p{L}\p{N}]+/gu, '_').replaceAll(/^_|_$/g, '');
  if (sportGroup(key) !== 'other') return key;
  return POLISH_TYPES.find(([re]) => re.test(l))?.[1] ?? key;
}

/** `csv-` + the first 10 hex digits of SHA-1 over start, type, distance and duration: a re-import keeps the id. */
export function importedActivityId(row: Pick<ImportedActivityInput, 'start_time_local' | 'type' | 'distance_m' | 'duration_s'>): string {
  const key = [row.start_time_local, row.type ?? '', row.distance_m ?? '', row.duration_s ?? ''].join('|');
  return `csv-${createHash('sha1').update(key).digest('hex').slice(0, 10)}`;
}

export interface ParsedExport {
  rows: ImportedActivityInput[];
  /** Rows left out: fall detection entries and rows without a readable date. */
  skipped: number;
  /** Irregular rows that were still imported or skipped, with their line. */
  warnings: string[];
}

const START = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/;

/**
 * Rows of a Garmin Connect "Activities" CSV export (English or Polish headers). Distance is
 * in km, except for swimming, where Garmin writes metres. A row with more fields than the
 * header (a comma in an unquoted title) is mapped by position and reported, not dropped.
 */
export function parseGarminConnectCsv(text: string, sourceFile: string, importedAt: number): ParsedExport {
  const [head, ...records] = parseCsv(text);
  const warnings: string[] = [];
  if (!head) return { rows: [], skipped: 0, warnings: [`${sourceFile}: empty file`] };
  const names = head.fields.map(header);
  const column = {} as Record<Field, number[]>;
  for (const f of Object.keys(ALIASES) as Field[]) {
    column[f] = ALIASES[f].map((a) => names.indexOf(a)).filter((i) => i >= 0);
  }
  if (column.date.length === 0) {
    return { rows: [], skipped: records.length, warnings: [`${sourceFile}: no Date column; not a Garmin Connect activities export`] };
  }

  const rows: ImportedActivityInput[] = [];
  let skipped = 0;
  for (const r of records) {
    if (r.fields.length !== names.length) {
      warnings.push(
        `${sourceFile}:${r.line}: ${r.fields.length} fields, the header has ${names.length}; mapped by position${r.fields.length > names.length ? ' (a comma in an unquoted title?)' : ''}`,
      );
    }
    const raw = (f: Field): string | undefined => {
      for (const i of column[f]) if (!missing(r.fields[i])) return (r.fields[i] as string).trim();
      return undefined;
    };
    const label = raw('type');
    if (label && SKIPPED_TYPES.has(label.toLowerCase())) {
      skipped++;
      continue;
    }
    const m = START.exec(raw('date') ?? '');
    if (!m) {
      warnings.push(`${sourceFile}:${r.line}: unreadable date "${raw('date') ?? ''}"; row skipped`);
      skipped++;
      continue;
    }
    const start = `${m[1]} ${(m[2] as string).padStart(2, '0')}:${m[3]}:${m[4] ?? '00'}`;
    const type = label ? activityTypeKey(label) : null;
    const distance = csvNumber(raw('distance'));
    const row: ImportedActivityInput = {
      id: '',
      start_time_local: start,
      type,
      name: raw('name') ?? null,
      duration_s: csvDuration(raw('duration')),
      moving_s: csvDuration(raw('moving')),
      distance_m: distance === null ? null : sportGroup(type) === 'swim' ? distance : Math.round(distance * 1000),
      elevation_gain_m: csvNumber(raw('gain')),
      elevation_loss_m: csvNumber(raw('loss')),
      avg_hr: csvNumber(raw('avg_hr')),
      max_hr: csvNumber(raw('max_hr')),
      avg_power: csvNumber(raw('avg_power')),
      norm_power: csvNumber(raw('norm_power')),
      avg_cadence: csvNumber(raw('cadence')),
      calories: csvNumber(raw('calories')),
      training_effect_aerobic: csvNumber(raw('te_aerobic')),
      training_effect_anaerobic: csvNumber(raw('te_anaerobic')),
      source_file: sourceFile,
      imported_at: importedAt,
    };
    row.id = importedActivityId(row);
    rows.push(row);
  }
  return { rows, skipped, warnings };
}

export interface ImportReport {
  files: number;
  /** Activities read from the files (after skipping), duplicates included. */
  rows: number;
  added: number;
  /** Already stored from an earlier import; overwritten with the same id. */
  updated: number;
  /** The same activity more than once in this import (e.g. overlapping exports); stored once. */
  duplicates: number;
  /** Fall detection entries and rows without a readable date. */
  skipped: number;
  /** Stored activities on dates the synced Garmin activities cover; analytics ignores them there. */
  covered: number;
  warnings: string[];
}

/**
 * Imports Garmin Connect CSV exports into `imported_activities`: deduplicated by content id
 * across the files and earlier imports. Rows on dates inside `activities:covered` are stored
 * too but counted as `covered`, because the analytics reads take the synced activities there.
 */
export function importActivities(store: Store, files: readonly { name: string; text: string }[], now: number): ImportReport {
  const unique = new Map<string, ImportedActivityInput>();
  const report: ImportReport = { files: files.length, rows: 0, added: 0, updated: 0, duplicates: 0, skipped: 0, covered: 0, warnings: [] };
  for (const f of files) {
    const parsed = parseGarminConnectCsv(f.text, f.name, now);
    report.rows += parsed.rows.length;
    report.skipped += parsed.skipped;
    report.warnings.push(...parsed.warnings);
    for (const r of parsed.rows) {
      if (unique.has(r.id)) report.duplicates++;
      else unique.set(r.id, r);
    }
  }
  const rows = [...unique.values()];
  const { added, updated } = store.upsertImportedActivities(rows);
  report.added = added;
  report.updated = updated;
  const covered = parseRangeSet(store.getMeta('activities:covered'));
  report.covered = rows.filter((r) => {
    const d = r.start_time_local.slice(0, 10);
    return covered.some(([a, b]) => d >= a && d <= b);
  }).length;
  return report;
}
