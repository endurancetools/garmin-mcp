import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { csvLine, parseCsv } from './csv.js';
import { activityTypeKey, csvDuration, csvNumber, importActivities, importedActivityId, parseGarminConnectCsv } from './imported.js';
import { sportGroup } from './sport.js';
import { NOW, setup } from './test-utils/fake.js';

const FIXTURES = path.resolve(import.meta.dirname, '../fixtures');
const file = (name: string) => ({ name, text: fs.readFileSync(path.join(FIXTURES, name), 'utf8') });
const EN = file('garmin-connect-en.csv');
const EN_ASCENT = file('garmin-connect-en-ascent.csv');
const PL = file('garmin-connect-pl.csv');

describe('parseCsv', () => {
  it('reads quotes, escaped quotes, line breaks in quotes, CRLF, a BOM and drops blank lines', () => {
    const text = '﻿a,b,c\r\n1,"x, y","say ""hi"""\r\n\r\n2,"two\nlines",\n';
    expect(parseCsv(text)).toEqual([
      { line: 1, fields: ['a', 'b', 'c'] },
      { line: 2, fields: ['1', 'x, y', 'say "hi"'] },
      { line: 4, fields: ['2', 'two\nlines', ''] },
    ]);
  });

  it('writes lines it reads back', () => {
    const line = csvLine(['2026-01-01', 'lthr_run', 171, 'test', 'test 30 min, "Siechnice"', null]);
    expect(line).toBe('2026-01-01,lthr_run,171,test,"test 30 min, ""Siechnice""",');
    expect(parseCsv(line)[0]?.fields).toEqual(['2026-01-01', 'lthr_run', '171', 'test', 'test 30 min, "Siechnice"', '']);
  });
});

describe('cell values', () => {
  it('reads thousands commas and treats -- as missing', () => {
    expect(csvNumber('1,234')).toBe(1234);
    expect(csvNumber('15.42')).toBe(15.42);
    expect(csvNumber('--')).toBeNull();
    expect(csvNumber('')).toBeNull();
    expect(csvNumber('n/a')).toBeNull();
  });

  it('reads h:mm:ss, mm:ss and fractions', () => {
    expect(csvDuration('01:45:30')).toBe(6330);
    expect(csvDuration('1:00:00')).toBe(3600);
    expect(csvDuration('45:00')).toBe(2700);
    expect(csvDuration('00:35:10.5')).toBe(2110.5);
    expect(csvDuration('--')).toBeNull();
    expect(csvDuration('1:2:3:4')).toBeNull();
  });

  it('turns export labels into type keys sportGroup knows', () => {
    expect(activityTypeKey('Trail Running')).toBe('trail_running');
    expect(activityTypeKey('Pool Swim')).toBe('pool_swim');
    expect(activityTypeKey('Strength Training')).toBe('strength_training');
    expect(activityTypeKey('Bieg')).toBe('running');
    expect(activityTypeKey('Kolarstwo szosowe')).toBe('cycling');
    expect(activityTypeKey('Pływanie w basenie')).toBe('swimming');
    expect(activityTypeKey('Paddleboarding')).toBe('paddleboarding');
  });

  // The Polish fixture has only Bieg, Kolarstwo szosowe and Pływanie w basenie: the labels below are
  // the expected Garmin Connect names and their variants, not checked on a real Polish export.
  it.each([
    ['Narciarstwo biegowe', 'nordic'],
    ['Narciarstwo biegowe – styl klasyczny', 'nordic'],
    ['Narciarstwo biegowe – styl łyżwowy', 'nordic'],
    ['Narciarstwo łyżwowe', 'nordic'],
    ['Narciarstwo klasyczne', 'nordic'],
    ['Bieg narciarski', 'nordic'],
    ['Narciarstwo skiturowe', 'nordic'],
    ['Skitury', 'nordic'],
    ['Rakiety śnieżne', 'nordic'],
    ['Chodzenie w rakietach śnieżnych', 'nordic'],
    ['Wioślarstwo', 'row'],
    ['Wioślarstwo w pomieszczeniu', 'row'],
    ['Narciarstwo', 'hike'],
    ['Narciarstwo zjazdowe', 'hike'],
    ['Narty', 'hike'],
    ['Łyżwiarstwo', 'other'],
    ['Bieg na bieżni', 'run'],
  ])('maps the Polish label %s to the %s group', (label, group) => {
    expect(sportGroup(activityTypeKey(label))).toBe(group);
  });

  it('keeps English labels of the new groups as their own keys', () => {
    expect(activityTypeKey('Cross Country Classic Skiing')).toBe('cross_country_classic_skiing');
    expect(activityTypeKey('Indoor Rowing')).toBe('indoor_rowing');
    expect(activityTypeKey('Backcountry Skiing')).toBe('backcountry_skiing');
  });
});

describe('parseGarminConnectCsv', () => {
  it('maps an English export: first of duplicated columns, swim in metres, incidents skipped, long rows reported', () => {
    const { rows, skipped, warnings } = parseGarminConnectCsv(EN.text, EN.name, NOW);
    expect(rows.map((r) => r.type)).toEqual(['trail_running', 'pool_swim', 'indoor_cycling', 'strength_training', 'gravel_cycling', 'running']);
    expect(skipped).toBe(1);
    expect(warnings).toEqual([
      'garmin-connect-en.csv:7: 27 fields, the header has 26; mapped by position (a comma in an unquoted title?)',
    ]);
    expect(rows[0]).toEqual({
      id: importedActivityId({ start_time_local: '2025-03-01 08:15:00', type: 'trail_running', distance_m: 15_420, duration_s: 6330 }),
      start_time_local: '2025-03-01 08:15:00',
      type: 'trail_running',
      name: 'Morning trail',
      duration_s: 6330,
      moving_s: 6000,
      distance_m: 15_420,
      elevation_gain_m: 1050,
      elevation_loss_m: 1020,
      avg_hr: 148,
      max_hr: 172,
      avg_power: 280,
      norm_power: null,
      avg_cadence: 168,
      calories: 1234,
      training_effect_aerobic: 3.4,
      training_effect_anaerobic: null,
      source_file: 'garmin-connect-en.csv',
      imported_at: NOW,
    });
    expect(rows[0]?.id).toMatch(/^csv-[0-9a-f]{10}$/);
    expect(rows[1]).toMatchObject({ type: 'pool_swim', distance_m: 1225, duration_s: 2110, avg_cadence: null, elevation_gain_m: null });
    expect(rows[2]).toMatchObject({ distance_m: 30_000, norm_power: 210, avg_power: 200, avg_cadence: 88, elevation_gain_m: 0 });
    expect(rows[3]).toMatchObject({ distance_m: null, duration_s: 2700, moving_s: 2400 });
    // Shifted by the unquoted comma: the title is cut and the distance column holds text.
    expect(rows[4]).toMatchObject({ start_time_local: '2025-03-06 09:00:00', name: 'Gravel ride', distance_m: null });
    expect(rows[5]).toMatchObject({ name: 'Easy, recovery', distance_m: 10_000, duration_s: 3300, avg_cadence: 172 });
  });

  it('maps the Ascent/Descent variant of the English headers', () => {
    const { rows, warnings } = parseGarminConnectCsv(EN_ASCENT.text, EN_ASCENT.name, NOW);
    expect(warnings).toEqual([]);
    expect(rows[1]).toMatchObject({ type: 'running', distance_m: 25_000, duration_s: 7800, moving_s: 7680, elevation_gain_m: 120, elevation_loss_m: 118, calories: 1800 });
  });

  it('maps Polish headers and labels', () => {
    const { rows, skipped, warnings } = parseGarminConnectCsv(PL.text, PL.name, NOW);
    expect(skipped).toBe(0);
    expect(warnings).toEqual([]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ type: 'running', name: 'Rozbieganie', distance_m: 8500, duration_s: 2880, moving_s: 2850, avg_hr: 142, max_hr: 158, avg_cadence: 170, elevation_gain_m: 45, training_effect_aerobic: 2.8 });
    expect(rows[1]).toMatchObject({ type: 'cycling', distance_m: 60_200, calories: 1450, elevation_gain_m: 1100, elevation_loss_m: 1090, avg_power: 190, norm_power: 205 });
    expect(rows[2]).toMatchObject({ type: 'swimming', distance_m: 1500 });
  });

  it('reports files that are not activity exports and unreadable dates', () => {
    expect(parseGarminConnectCsv('', 'empty.csv', NOW)).toEqual({ rows: [], skipped: 0, warnings: ['empty.csv: empty file'] });
    expect(parseGarminConnectCsv('a,b\n1,2\n', 'x.csv', NOW)).toMatchObject({ rows: [], skipped: 1 });
    const bad = parseGarminConnectCsv('Activity Type,Date\nRunning,yesterday\n', 'bad.csv', NOW);
    expect(bad).toEqual({ rows: [], skipped: 1, warnings: ['bad.csv:2: unreadable date "yesterday"; row skipped'] });
  });
});

describe('importActivities', () => {
  it('deduplicates across files and re-imports and counts rows on synced dates', () => {
    const t = setup();
    t.activities([], '2025-03-01', '2025-03-03');
    const first = importActivities(t.store, [EN, EN_ASCENT, PL], NOW);
    expect(first).toEqual({ files: 3, rows: 11, added: 10, updated: 0, duplicates: 1, skipped: 1, covered: 3, warnings: [expect.stringContaining('garmin-connect-en.csv:7')] });
    expect(t.store.countImportedActivities()).toBe(10);
    const again = importActivities(t.store, [EN_ASCENT], NOW + 1);
    expect(again).toMatchObject({ rows: 2, added: 0, updated: 2, duplicates: 0, covered: 1 });
    expect(t.store.countImportedActivities()).toBe(10);
  });

  it('feeds the load model only on dates outside the synced activities', async () => {
    const t = setup();
    t.activities([], '2025-03-01', '2025-03-03');
    importActivities(t.store, [EN, EN_ASCENT, PL], NOW);
    const res = await t.analytics.getLoad({ from: '2025-02-01', to: '2025-03-31', include_activities: true });
    const sessions = res.data.activities ?? [];
    expect(sessions.every((s) => s.source === 'import')).toBe(true);
    expect(sessions.map((s) => s.date)).toEqual(['2025-02-10', '2025-02-11', '2025-02-12', '2025-03-04', '2025-03-06', '2025-03-07', '2025-03-08']);
    expect(sessions.map((s) => s.sport)).toEqual(['run', 'bike', 'swim', 'strength', 'bike', 'run', 'run']);
    expect(sessions[0]).toMatchObject({ distance_m: 8500, avg_hr: 142 });
    expect(sessions[0]?.hrtss).toBeGreaterThan(0);
  });
});
