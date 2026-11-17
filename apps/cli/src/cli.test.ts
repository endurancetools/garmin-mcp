import type { Command } from 'commander';
import { AnalyticsService } from 'garmin-mcp-analytics';
import { ClientNetworkError } from 'garmin-mcp-client';
import { eachDay, type GarminConfig } from 'garmin-mcp-config';
import { GarminService } from 'garmin-mcp-domain';
import { addRange, parseRangeSet, Store, Syncer, SyncJobRunner } from 'garmin-mcp-store';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readinessMarkdown } from './analytics.js';
import { buildProgram, VERSION, type ProgramDeps } from './commands.js';
import { table } from './io.js';
import { anonymize, RECORDABLE, UNKNOWN_SHAPE, writeFixture } from './record.js';

const NO_SHIFT = { lat: 0, lon: 0 };

describe('anonymize', () => {
  it('scrubs personal fields but keeps data ids and shapes', () => {
    const out = anonymize({
      displayName: 'jan.kowalski',
      fullName: 'Jan Kowalski',
      profileId: 123456,
      activityId: 99,
      message: 'mail me at jan@example.org',
      note: 'po kontuzji kolana',
      polyline: [{ lat: 52.2297, lon: 21.0122 }],
      nested: { ownerId: 5, garminGUID: 'abc' },
    }, NO_SHIFT);
    expect(out).toEqual({
      displayName: 'anon-displayName',
      fullName: 'anon-fullName',
      profileId: 90001,
      activityId: 99,
      message: 'mail me at anon@example.com',
      note: 'anon-note',
      polyline: [{ lat: 0.2297, lon: 0.0122 }],
      nested: { ownerId: 90001, garminGUID: 'anon-garminGUID' },
    });
  });

  it('matches personal keys regardless of case and hides profile links', () => {
    const out = anonymize({
      metadataDTO: { userInfoDto: { userProfilePk: 123456, displayname: 'jan.kowalski', fullname: 'Jan Kowalski' } },
      userProfileFullName: 'Jan Kowalski',
      bio: 'Biegam w Lasku Bielańskim',
      facebookUrl: 'https://facebook.com/jan',
      userDailySummaryId: 123456,
    });
    expect(out).toEqual({
      metadataDTO: { userInfoDto: { userProfilePk: 90001, displayname: 'anon-displayname', fullname: 'anon-fullname' } },
      userProfileFullName: 'anon-userProfileFullName',
      bio: 'anon-bio',
      facebookUrl: 'anon-facebookUrl',
      userDailySummaryId: 90001,
    });
  });

  it('hides free text the owner typed, which names places and races', () => {
    const out = anonymize({
      activityId: 7,
      activityName: 'Exampleville - park loop 5km',
      workoutName: 'LONG 26 km',
      description: 'Nd 20.09 RANO',
      calendarItems: [{ id: 1, title: 'Example Ultra 50 2026 12/300' }],
      settings: [{ name: 'pl' }],
    });
    expect(out).toEqual({
      activityId: 7,
      activityName: 'anon-activityName',
      workoutName: 'anon-workoutName',
      description: 'anon-description',
      calendarItems: [{ id: 1, title: 'anon-title' }],
      settings: [{ name: 'pl' }],
    });
  });

  it('shifts every coordinate, including positional detail columns, and hides profile photos', () => {
    const shift = { lat: 0.5, lon: 0.25 };
    const out = anonymize(
      {
        metricDescriptors: [
          { metricsIndex: 0, key: 'directHeartRate' },
          { metricsIndex: 1, key: 'directLatitude' },
          { metricsIndex: 2, key: 'directLongitude' },
        ],
        activityDetailMetrics: [{ metrics: [150, 52.2297, 21.0122] }, { metrics: [151, null, null] }],
        geoPolylineDTO: { minLat: 52.2297, maxLon: 21.9, polyline: [{ lat: 52.2297, lon: 21.0122 }] },
        ownerProfileImageUrlSmall: 'https://s3.amazonaws.com/garmin-connect-prod/profile_images/x-prth.png',
        imageUrl: 'https://s3.amazonaws.com/garmin-connect-prod/profile_images/y-71.png',
      },
      shift,
    );
    expect(out).toEqual({
      metricDescriptors: [
        { metricsIndex: 0, key: 'directHeartRate' },
        { metricsIndex: 1, key: 'directLatitude' },
        { metricsIndex: 2, key: 'directLongitude' },
      ],
      activityDetailMetrics: [{ metrics: [150, 0.7297, 0.2622] }, { metrics: [151, null, null] }],
      geoPolylineDTO: { minLat: 0.7297, maxLon: 0.15, polyline: [{ lat: 0.7297, lon: 0.2622 }] },
      ownerProfileImageUrlSmall: 'anon-ownerProfileImageUrlSmall',
      imageUrl: 'anon-imageUrl',
    });
  });

  it('hides the weather station, which would reveal the location', () => {
    const out = anonymize({ temp: 59, weatherStationDTO: { id: 'EPWA', name: 'Warsaw Chopin', latitude: 52.1657, timezone: null } }, NO_SHIFT);
    expect(out).toEqual({
      temp: 59,
      weatherStationDTO: { id: 'anon-weatherStation', name: 'anon-weatherStation', latitude: 0.1657, timezone: null },
    });
  });

  it('hides device serial numbers, addresses and names but keeps device ids and settings', () => {
    const out = anonymize({
      deviceId: 3333,
      serialNumber: '3XY123456',
      wifiMacAddress: 'AA:BB:CC:DD:EE:FF',
      customDeviceName: "Jan's watch",
      timeFormat: 'time_twenty_four_hr',
      wifiNetworks: [{ ssid: 'Kowalscy-5G', classId: 3 }],
      alarms: [{ alarmId: 501, alarmTime: 375, alarmMessage: 'Trening z Anią' }],
    });
    expect(out).toEqual({
      deviceId: 3333,
      serialNumber: 'anon-serialNumber',
      wifiMacAddress: 'anon-wifiMacAddress',
      customDeviceName: 'anon-customDeviceName',
      timeFormat: 'time_twenty_four_hr',
      wifiNetworks: [{ ssid: 'anon-ssid', classId: 3 }],
      alarms: [{ alarmId: 501, alarmTime: 375, alarmMessage: 'anon-alarmMessage' }],
    });
  });

  it('keeps calendar item ids distinct but hides the profile id', () => {
    const out = anonymize({
      year: 2026,
      month: 9,
      calendarItems: [
        { id: 9900001, itemType: 'workout', date: '2026-10-10', workoutId: 700001 },
        { id: 30000003, itemType: 'event', date: '2026-10-25', location: 'Warszawa' },
      ],
    }) as { calendarItems: { id: number; location?: string }[] };
    expect(out.calendarItems.map((i) => i.id)).toEqual([9900001, 30000003]);
    expect(out.calendarItems[1]?.location).toBe('anon-location');
    expect(anonymize({ id: 123456, profileId: 123456, displayName: 'jan' })).toEqual({
      id: 90001,
      profileId: 90001,
      displayName: 'anon-displayName',
    });
  });

  it('hides course coordinates and place names, plan and event names', () => {
    const shift = { lat: 0.5, lon: 0.25 };
    const course = {
      courseId: 4242,
      courseName: 'Pętla Kampinos',
      startPoint: { latitude: 52.3311, longitude: 20.7712, elevation: 85 },
      boundingBox: { lowerLeftLatitude: 52.1, upperRightLongitude: 20.9 },
      coursePoints: [{ name: 'Bar Pod Lipami', pointType: 'FOOD', lat: 52.3, lon: 20.8 }],
      encodedPolyline: 'o}|~Hcj`}B??',
      flat: 1.25,
    };
    expect(anonymize(course, shift, { names: true })).toEqual({
      courseId: 4242,
      courseName: 'anon-courseName',
      startPoint: { latitude: 0.8311, longitude: 0.0212, elevation: 85 },
      boundingBox: { lowerLeftLatitude: 0.6, upperRightLongitude: 0.15 },
      coursePoints: [{ name: 'anon-name', pointType: 'FOOD', lat: 0.8, lon: 0.05 }],
      encodedPolyline: 'anon-encodedPolyline',
      flat: 1.25,
    });
    const plan = { trainingPlanId: 7, name: 'Półmaraton Warszawski - plan', targetEvent: { eventName: 'Bieg Niepodległości', location: 'Warszawa' } };
    expect(anonymize(plan, shift, { names: true })).toEqual({
      trainingPlanId: 7,
      name: 'anon-name',
      targetEvent: { eventName: 'anon-eventName', location: 'anon-location' },
    });
    // Without `names`, a bare `name` (exercise, setting) stays.
    expect(anonymize({ name: 'pl' }, shift)).toEqual({ name: 'pl' });
  });

  it('hides notes and food log text under any recording', () => {
    expect(anonymize({ notes: 'ból głowy', comment: 'u lekarza', foodName: 'Pierogi babci', mealName: 'Obiad u Ani', brandName: 'Biedronka' })).toEqual({
      notes: 'anon-notes',
      comment: 'anon-comment',
      foodName: 'anon-foodName',
      mealName: 'anon-mealName',
      brandName: 'anon-brandName',
    });
  });

  it('replaces any text in a recording of unknown shape but keeps constants, dates and units', () => {
    const out = anonymize(
      {
        measurements: [
          {
            systolic: 128,
            category: 'STAGE_1_HIGH',
            measurementTimestampLocal: '2026-10-10T07:15:00.0',
            calendarDate: '2026-10-10',
            symptom: 'zawroty głowy po bieganiu',
            memo: 'call jan@example.org',
            unit: 'mmHg',
            sourceType: 'MANUAL',
            empty: '',
          },
        ],
        activityType: { typeKey: 'running' },
      },
      NO_SHIFT,
      { unknownShape: true },
    );
    expect(out).toEqual({
      measurements: [
        {
          systolic: 128,
          category: 'STAGE_1_HIGH',
          measurementTimestampLocal: '2026-10-10T07:15:00.0',
          calendarDate: '2026-10-10',
          symptom: 'anon-symptom',
          memo: 'anon-memo',
          unit: 'mmHg',
          sourceType: 'MANUAL',
          empty: '',
        },
      ],
      activityType: { typeKey: 'running' },
    });
    // Without `unknownShape` (older recordings) unknown keys keep their text.
    expect(anonymize({ symptom: 'zawroty głowy', timeFormat: 'time_twenty_four_hr' })).toEqual({ symptom: 'zawroty głowy', timeFormat: 'time_twenty_four_hr' });
  });

  it('keeps no free text in the stage 8 fixtures and leaves the older ones out of the new rules', () => {
    // A stage 8 recording (UNKNOWN_SHAPE) hides all text: anonymizing it again
    // changes nothing. A zero shift keeps the already shifted coordinates.
    // Re-recording an older endpoint gives the same fixture as before: none of
    // the keys added for notes and food logs occurs in it.
    const fixtures = fileURLToPath(new URL('../../../packages/client/fixtures/', import.meta.url));
    const files = fs.readdirSync(fixtures).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(30);
    const recorded = files.filter((f) => UNKNOWN_SHAPE.has(f.replace(/\.json$/, '')));
    expect(recorded.length).toBeGreaterThan(10);
    for (const f of recorded) {
      const data: unknown = JSON.parse(fs.readFileSync(path.join(fixtures, f), 'utf8'));
      expect({ f, data: anonymize(data, { lat: 0, lon: 0 }, { unknownShape: true }) }).toEqual({ f, data });
    }
    const added = ['note', 'notes', 'comment', 'foodname', 'mealname', 'brandname'];
    for (const f of files.filter((name) => !recorded.includes(name))) {
      const keys = new Set<string>();
      const walk = (v: unknown): void => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') {
          for (const [k, item] of Object.entries(v)) {
            keys.add(k.toLowerCase());
            walk(item);
          }
        }
      };
      walk(JSON.parse(fs.readFileSync(path.join(fixtures, f), 'utf8')));
      expect({ f, added: added.filter((k) => keys.has(k)) }).toEqual({ f, added: [] });
    }
  });

  it('writes recordings with names or all text hidden and reports the keys where text is left', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'record-'));
    try {
      const plans = writeFixture(dir, 'training-plans', { trainingPlanList: [{ trainingPlanId: 1, name: 'Plan na Kraków', level: 'INTERMEDIATE' }] });
      expect(JSON.parse(fs.readFileSync(plans.file, 'utf8'))).toEqual({ trainingPlanList: [{ trainingPlanId: 1, name: 'anon-name', level: 'INTERMEDIATE' }] });
      expect(plans.textKeys).toEqual(['level']);
      const meals = writeFixture(dir, 'nutrition-day', { mealDate: '2026-10-10', meals: [{ label: 'Kolacja u Ani', calories: 640 }] });
      expect(JSON.parse(fs.readFileSync(meals.file, 'utf8'))).toEqual({ mealDate: '2026-10-10', meals: [{ label: 'anon-label', calories: 640 }] });
      expect(meals.textKeys).toEqual(['mealDate']);
      // Older recordings keep the key-based rules: a bare `name` stays.
      const types = writeFixture(dir, 'activity-types', [{ typeId: 1, typeKey: 'running', name: 'Bieg' }]);
      expect(JSON.parse(fs.readFileSync(types.file, 'utf8'))).toEqual([{ typeId: 1, typeKey: 'running', name: 'Bieg' }]);
      expect(types.textKeys).toEqual(['name', 'typeKey']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('covers every client fixture name and the stage 8 endpoints', () => {
    expect(Object.keys(RECORDABLE)).toContain('training-status');
    expect(Object.keys(RECORDABLE)).toEqual(
      expect.arrayContaining([
        'activity-typed-splits', 'activity-split-summaries', 'training-plans', 'training-plan', 'adaptive-plan',
        'lactate-threshold-range', 'lactate-threshold-speed-range', 'cycling-ftp', 'hydration-day', 'blood-pressure-range',
        'daily-events', 'goals', 'courses', 'course', 'device-solar', 'nutrition-day', 'menstrual-day', 'earned-badges',
        'badge-challenges',
      ]),
    );
    expect(Object.keys(RECORDABLE)).toHaveLength(58);
    // Every stage 8 endpoint is recorded with all text hidden.
    expect(Object.keys(RECORDABLE).slice(-UNKNOWN_SHAPE.size)).toEqual([...UNKNOWN_SHAPE]);
  });

  it('lists the recordable endpoints with `garmin record list`', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      await buildProgram().parseAsync(['node', 'garmin', 'record', 'list']);
    } finally {
      spy.mockRestore();
    }
    const listed = lines.join('').trim().split('\n');
    expect(listed).toEqual(Object.keys(RECORDABLE));
    expect(listed).toContain('earned-badges');
  });
});

describe('cli', () => {
  it('registers the CLI commands', () => {
    const names = buildProgram().commands.map((c) => c.name());
    expect(names).toEqual([
      'login',
      'import-tokens',
      'logout',
      'status',
      'sync',
      'activities',
      'health',
      'load',
      'readiness',
      'thresholds',
      'import-activities',
      'upload',
      'course',
      'log',
      'doctor',
      'serve',
      'record',
    ]);
    const thresholds = buildProgram().commands.find((c) => c.name() === 'thresholds');
    expect(thresholds?.commands.map((c) => c.name())).toEqual(['list', 'add', 'export', 'import']);
    const log = buildProgram().commands.find((c) => c.name() === 'log');
    expect(log?.commands.map((c) => c.name())).toEqual(['weight', 'bp', 'water']);
    const course = buildProgram().commands.find((c) => c.name() === 'course');
    expect(course?.commands.map((c) => c.name())).toEqual(['download', 'upload']);
  });

  it('reports the version from its own package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(VERSION).toBe(pkg.version);
    expect(buildProgram().version()).toBe(pkg.version);
  });

  it('renders tables', () => {
    expect(table([{ a: 1, b: 'x' }, { a: 22 }])).toBe('a   b\n--  -\n1   x\n22');
  });
});

// ------------------------------------------------------------ analytics commands on an in-memory store

/** 2026-10-08 12:00 UTC; the fake account lives in UTC. */
const NOW = Date.parse('2026-10-08T12:00:00Z');
const TODAY = '2026-10-08';

/**
 * Analytics over an in-memory store whose Garmin client fails every call: daily 1 h runs at
 * 150 bpm from June, resting HR 50, sleep 8 h, LTHR 170 (hrTSS 69.4 a day).
 */
function fake(opts: { seed?: boolean } = {}) {
  const calls: string[] = [];
  const client = new Proxy(
    {},
    {
      get: (_, name) =>
        name === 'then'
          ? undefined
          : () => {
              calls.push(String(name));
              return Promise.reject(new Error(`Unexpected Garmin call: ${String(name)}`));
            },
    },
  );
  const store = Store.open(':memory:');
  const syncer = new Syncer(client as never, store, { timeZone: 'UTC', now: () => NOW, fetchOnDemand: false });
  const jobs = new SyncJobRunner(syncer, store, { chunkDays: 7, pause: { minMs: 0, maxMs: 0 }, maxRequestsPerDay: 10_000, timeZone: 'UTC', now: () => NOW });
  const garmin = new GarminService({ client: client as never, store, syncer, jobs, timeZone: 'UTC', downloadDir: os.tmpdir(), budgetMs: 200, autoSync: false, now: () => NOW });
  const analytics = new AnalyticsService(garmin, { budgetMs: 200, now: () => NOW });
  if (opts.seed !== false) {
    store.upsertActivities(
      eachDay('2026-06-01', TODAY).map((d, i) => ({
        activityId: i + 1,
        activityName: `Run ${d}`,
        startTimeLocal: `${d} 07:00:00`,
        startTimeGMT: `${d} 07:00:00`,
        activityType: { typeId: 1, typeKey: 'running' },
        distance: 10_000,
        duration: 3600,
        averageHR: 150,
        activityTrainingLoad: 100,
      })) as Parameters<Store['upsertActivities']>[0],
      NOW,
    );
    store.setMeta('activities:covered', JSON.stringify(addRange(parseRangeSet(undefined), '2026-06-01', TODAY)));
    for (const d of eachDay('2026-05-01', TODAY)) {
      store.putDaily('daily_summary', d, { resting_hr: 50, avg_stress: 30, body_battery_high: 80 }, {}, NOW);
      store.putDaily('sleep', d, { score: 80, duration_s: 8 * 3600 }, {}, NOW);
    }
    store.addThreshold({ date: '2026-01-01', param: 'lthr_run', value: 170, source: 'manual', created_at: NOW });
  }
  const opened: GarminConfig[] = [];
  const deps: ProgramDeps = {
    analytics: (config) => {
      opened.push(config);
      return Promise.resolve({ analytics, close: () => {} });
    },
    store: () => store,
    now: () => NOW,
  };
  return { store, deps, opened, calls };
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'garmin-cli-'));
  // Never the user's real files: data dir and tokens live in the temp directory.
  vi.stubEnv('GARMIN_DATA_DIR', tmp);
  vi.stubEnv('GARMIN_TOKENS_FILE', path.join(tmp, 'tokens.json'));
  vi.stubEnv('GARMIN_TIMEZONE', 'UTC');
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Commander errors throw instead of exiting the test process, in every subcommand too. */
const throwing = (c: Command): Command => {
  c.exitOverride();
  for (const sub of c.commands) throwing(sub);
  return c;
};

/** Runs `garmin <args>` and returns what it printed. */
async function run(deps: ProgramDeps, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const o = vi.spyOn(process.stdout, 'write').mockImplementation((s) => (stdout.push(String(s)), true));
  const e = vi.spyOn(process.stderr, 'write').mockImplementation((s) => (stderr.push(String(s)), true));
  try {
    await throwing(buildProgram(deps)).parseAsync(args, { from: 'user' });
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
  return { stdout: stdout.join(''), stderr: stderr.join('') };
}

const json = <T>(s: string) => JSON.parse(s) as T;

describe('garmin load', () => {
  it('prints the load model as markdown, offline and without auto fetch', async () => {
    const { deps, opened, calls } = fake();
    const { stdout } = await run(deps, 'load');
    expect(stdout).toContain('# Load 2026-09-11..2026-10-08 (auto)');
    expect(stdout).toContain('| date | tss | ctl | atl | tsb | acwr | monotony | strain |');
    expect(stdout).toMatch(/\| 2026-10-08 \| 69\.4 \| \d+(\.\d)? \|/);
    expect(stdout).toContain('| 2026-W41 | run | 4 | 4 | 40 |');
    expect(stdout).toContain('## Intensity 2026-09-11..2026-10-08 (run, bike, nordic, row)');
    expect(stdout).toContain('| bike | 170 | 146 |  |  |  | No lthr_bike in the threshold history; the running LTHR is used. LT1 approximated');
    expect(stdout).toContain('\n> ');
    expect(stdout).not.toContain('## Series');
    expect(opened[0]?.autoFetch).toBe(false);
    expect(calls).toEqual([]);
  });

  it('adds the optional sections and prints the tool envelope with --json', async () => {
    const { deps } = fake();
    const md = (await run(deps, 'load', '--from', '2026-10-01', '--series', '--activities', '--efficiency')).stdout;
    expect(md).toContain('## Series');
    expect(md).toContain('| 2026-10-01 | run | running | Run 2026-10-01 | 1:00 | 10 | 150 | 69.4 | 0.833 | hr | 69.4 |');
    expect(md).toContain('## Efficiency (aerobic sessions)');
    const res = json<{ data: { latest: { tss: number }; series: unknown[]; flags_used: Record<string, number> }; meta: { source: string } }>(
      (await run(deps, 'load', '--from', '2026-10-01', '--series', '--json')).stdout,
    );
    expect(res.meta.source).toBe('cache');
    expect(res.data.latest.tss).toBe(69.4);
    expect(res.data.series).toHaveLength(8);
    expect(res.data.flags_used.acwr_high).toBe(1.5);
  });

  it('adds the per sport load with --by-sport, in markdown and in the envelope', async () => {
    const { deps } = fake();
    const md = (await run(deps, 'load', '--by-sport')).stdout;
    expect(md).toContain('## By sport on 2026-10-08');
    expect(md).toContain('| sport | ctl | atl | tsb | acwr |');
    expect(md).toMatch(/\| run \| \d+(\.\d)? \| \d+(\.\d)? \| -?\d+(\.\d)? \|/);
    expect((await run(deps, 'load')).stdout).not.toContain('## By sport');
    const res = json<{ data: { latest: { ctl: number; atl: number }; by_sport: Record<string, { ctl: number; atl: number }>; series: Record<string, unknown>[] } }>(
      (await run(deps, 'load', '--from', '2026-10-01', '--by-sport', '--series', '--json')).stdout,
    );
    expect(Object.keys(res.data.by_sport)).toEqual(['run']);
    expect(res.data.by_sport.run).toMatchObject({ ctl: res.data.latest.ctl, atl: res.data.latest.atl });
    expect(res.data.series.at(-1)).toHaveProperty('run_ctl');
    const plain = json<{ data: { by_sport?: unknown; series: Record<string, unknown>[] } }>((await run(deps, 'load', '--from', '2026-10-01', '--series', '--json')).stdout);
    expect(plain.data.by_sport).toBeUndefined();
    expect(plain.data.series.at(-1)).not.toHaveProperty('run_ctl');
  });

  it('reads flag thresholds from a JSON file and switches the source', async () => {
    const { deps } = fake();
    const file = path.join(tmp, 'flags.json');
    fs.writeFileSync(file, JSON.stringify({ acwr_high: 1.2, nope: 1 }));
    const res = json<{ data: { latest: { tss: number }; flags_used: Record<string, number> }; meta: { note: string } }>(
      (await run(deps, 'load', '--source', 'garmin_load', '--flags', file, '--json')).stdout,
    );
    expect(res.data.latest.tss).toBe(100);
    expect(res.data.flags_used.acwr_high).toBe(1.2);
    expect(res.meta.note).toContain('Ignored flags (unknown key or invalid value): nope');
    fs.writeFileSync(file, JSON.stringify({ intensity_sports: ['run', 'hike'] }));
    expect((await run(deps, 'load', '--flags', file)).stdout).toContain('## Intensity 2026-09-11..2026-10-08 (run, hike)');
    fs.writeFileSync(file, '[1]');
    await expect(run(deps, 'load', '--flags', file)).rejects.toThrow('must hold a JSON object');
    await expect(run(deps, 'load', '--source', 'epoc')).rejects.toThrow('Allowed choices are auto, hrtss, garmin_load');
    const hr = json<{ data: { source: string; latest: { tss: number } } }>((await run(deps, 'load', '--source', 'hrtss', '--json')).stdout);
    expect(hr.data).toMatchObject({ source: 'hrtss', latest: { tss: 69.4 } });
  });
});

describe('garmin readiness', () => {
  it('prints the decision with its signals and advice', async () => {
    const { deps } = fake();
    const { stdout } = await run(deps, 'readiness', '2026-10-07');
    expect(stdout).toMatch(/^# Readiness 2026-10-07: (GO|MODIFY|REST)\n/);
    expect(stdout).toContain('| signal | rating | detail |');
    expect(stdout).toMatch(/\| sleep \| ok \| /);
    expect(stdout).toMatch(/\| hrv \| unknown \| /);
    expect(stdout).toContain('## Advice');
  });

  it('applies rules from a JSON file and prints the envelope with --json', async () => {
    const { deps } = fake();
    const file = path.join(tmp, 'rules.json');
    fs.writeFileSync(file, JSON.stringify({ sleep_h_red: 9, decision_rule: 'count' }));
    const res = json<{ data: { decision: string; rules_used: Record<string, number | string>; signals: { name: string; rating: string }[] } }>(
      (await run(deps, 'readiness', '2026-10-07', '--rules', file, '--json')).stdout,
    );
    expect(res.data.decision).toBe('REST');
    expect(res.data.rules_used.sleep_h_red).toBe(9);
    expect(res.data.rules_used.decision_rule).toBe('count');
    expect(res.data.signals.find((s) => s.name === 'sleep')?.rating).toBe('red');
    await expect(run(deps, 'readiness', '2099-01-01')).rejects.toThrow('is in the future');
  });

  it('shows info signals in their own line, not in the table', () => {
    const md = readinessMarkdown({
      data: {
        date: '2026-10-07',
        decision: 'GO',
        counts: { red: 0, yellow: 0, ok: 1, info: 1, unknown: 0 },
        signals: [
          { name: 'hrv', rating: 'ok', value: { last_night_ms: 60 }, detail: 'HRV 60 ms within the baseline and the averages.' },
          { name: 'training_readiness', rating: 'info', value: { score: 20, level: 'LOW' }, detail: "Garmin's own score, shown for reference, not counted" },
        ],
        partial: false,
        rules_used: {} as never,
        recommendation: [],
      },
      meta: { source: 'cache' },
    });
    expect(md).toContain('| hrv | ok | ');
    expect(md).not.toContain('| training_readiness |');
    expect(md).toContain("training_readiness: score 20, level LOW. Garmin's own score, shown for reference, not counted.");
  });
});

describe('garmin thresholds', () => {
  it('lists the thresholds in effect by default, per sport, with the history on request', async () => {
    const { deps } = fake();
    const md = (await run(deps, 'thresholds')).stdout;
    expect(md).toContain('# Thresholds on 2026-10-08');
    expect(md).toContain('| lthr_run | 170 | 2026-01-01 | manual |');
    expect(md).toContain('| run | 170 | 153 |');
    expect(md).toContain('Resting HR (28 days): 50 from 28 days');
    expect(md).not.toContain('## History');
    expect((await run(deps, 'thresholds', 'list', '--history')).stdout).toContain('| 2026-01-01 | lthr_run | 170 | manual |');
    const res = json<{ data: { date: string; effective: Record<string, unknown> } }>(
      (await run(deps, 'thresholds', '--date', '2026-06-01', '--param', 'lthr_run', '--json')).stdout,
    );
    expect(res.data.date).toBe('2026-06-01');
    expect(Object.keys(res.data.effective)).toEqual(['lthr_run']);
  });

  it('shows the zones of the cached Garmin profile as a separate table', async () => {
    const { deps, store } = fake();
    expect((await run(deps, 'thresholds')).stdout).not.toContain('## Zones');
    const fixture = (name: string): unknown =>
      JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../../packages/client/fixtures', `${name}.json`), 'utf8')) as unknown;
    store.setProfile({ social: {}, settings: {}, heartRateZones: fixture('heart-rate-zones'), powerZones: fixture('power-zones') }, NOW);
    const md = (await run(deps, 'thresholds')).stdout;
    expect(md).toContain('## Zones (Garmin profile, fetched 2026-10-08)');
    expect(md).toContain('| zones | sport | method | floors | hrmax | rhr | lthr | ftp |');
    expect(md).toContain('| hr | default | HR_MAX | 94 / 134 / 154 / 163 / 174 | 185 | 55 | 168 |  |');
    expect(md).toContain('| power | running |  | 260 / 317 / 361 / 399 / 458 |  |  |  | 404 |');
    expect(md).toMatch(/not a history/);
  });

  it('adds a test result and refuses bad input', async () => {
    const { deps, store } = fake();
    const { stdout } = await run(deps, 'thresholds', 'add', '2026-10-01', 'lthr_run', '172', '--note', '30 min test');
    expect(stdout).toBe('Added lthr_run = 172 from 2026-10-01 (test).\nIn effect on 2026-10-08: lthr_run = 172 (since 2026-10-01, test).\n');
    expect(store.listThresholds('lthr_run').map((r) => [r.value, r.source, r.note])).toEqual([
      [170, 'manual', null],
      [172, 'test', '30 min test'],
    ]);
    const again = json<{ data: { added: boolean } }>((await run(deps, 'thresholds', 'add', '2026-10-01', 'lthr_run', '175', '--json')).stdout);
    expect(again.data.added).toBe(false);
    await expect(run(deps, 'thresholds', 'add', '2026-10-01', 'lthr_run', 'abc')).rejects.toThrow('value must be a number');
    await expect(run(deps, 'thresholds', 'add', '2026-10-01', 'lthr', '170')).rejects.toThrow('Unknown threshold param');
    await expect(run(deps, 'thresholds', 'add', '2026-10-01', 'lthr_run', '170', '--source', 'garmin-auto')).rejects.toThrow('Allowed choices are test, manual');
  });

  it('exports the history as CSV and imports it into another database', async () => {
    const { deps, store } = fake();
    store.addThreshold({ date: '2026-03-01', param: 'lt1_hr', value: 150, source: 'test', note: 'test, "flat"', created_at: NOW });
    store.addThreshold({ date: '2026-04-01', param: 'hrmax', value: 192, source: 'garmin-auto', created_at: NOW });
    const csv = (await run(deps, 'thresholds', 'export')).stdout;
    expect(csv).toBe('date,param,value,source,note\n2026-04-01,hrmax,192,garmin-auto,\n2026-03-01,lt1_hr,150,test,"test, ""flat"""\n2026-01-01,lthr_run,170,manual,\n');
    const file = path.join(tmp, 'thresholds.csv');
    expect((await run(deps, 'thresholds', 'export', '--out', file)).stdout).toBe(`Wrote 3 threshold rows to ${file}.\n`);
    expect(fs.readFileSync(file, 'utf8')).toBe(csv);

    const other = fake({ seed: false });
    expect((await run(other.deps, 'thresholds', 'import', file)).stdout).toBe(
      `Imported ${file}: 2 added, 0 updated, 0 unchanged.\n1 garmin-auto row(s) left out: those come from the Garmin profile.\n`,
    );
    expect(other.store.listThresholds().map((r) => [r.date, r.param, r.value, r.source, r.note])).toEqual([
      ['2026-03-01', 'lt1_hr', 150, 'test', 'test, "flat"'],
      ['2026-01-01', 'lthr_run', 170, 'manual', null],
    ]);
    expect((await run(other.deps, 'thresholds', 'import', file)).stdout).toContain('0 added, 0 updated, 2 unchanged.');
    fs.writeFileSync(file, 'date,param,value\n2026-05-01,lthr_run,171\n2026-05-02,lthr_run,171\n');
    expect((await run(other.deps, 'thresholds', 'import', file)).stdout).toContain('2 added, 0 updated, 0 unchanged.');
    expect(other.store.listThresholds('lthr_run').map((r) => r.source)).toEqual(['manual', 'import', 'import']);
  });

  it('rejects a CSV with an invalid row without importing anything', async () => {
    const { deps, store } = fake({ seed: false });
    const file = path.join(tmp, 'bad.csv');
    fs.writeFileSync(file, 'date,param,value,source\n2026-05-01,lthr_run,171,test\n2026-05-02,lthr,0,garmin\n');
    await expect(run(deps, 'thresholds', 'import', file)).rejects.toThrow('1 invalid row(s), nothing imported: line 3: param "lthr", value "0", source "garmin"');
    fs.writeFileSync(file, 'when,what\n1,2\n');
    await expect(run(deps, 'thresholds', 'import', file)).rejects.toThrow('the header must have date,param,value');
    expect(store.listThresholds()).toEqual([]);
  });
});

describe('garmin import-activities', () => {
  it('imports Garmin Connect exports and reports duplicates, skipped rows and synced dates', async () => {
    const { deps, store } = fake();
    const a = path.join(tmp, 'a.csv');
    const b = path.join(tmp, 'b.csv');
    const head = 'Activity Type,Date,Title,Distance,Calories,Time,Avg HR,Max HR';
    fs.writeFileSync(a, `${head}\nRunning,2025-03-01 07:00:00,Easy,10.00,600,0:55:00,140,155\nIncident Detected,2025-03-02 07:00:00,x,0,0,0:00:01,--,--\n`);
    fs.writeFileSync(b, `${head}\nRunning,2025-03-01 07:00:00,Easy,10.00,600,0:55:00,140,155\nRunning,2026-07-01 07:00:00,Long, hilly,20.00,1200,2:00:00,145,160\n`);
    const { stdout, stderr } = await run(deps, 'import-activities', a, b);
    expect(stdout).toBe(
      'Imported 3 activities from 2 file(s): 2 added, 0 already imported (updated), 1 duplicates, 1 skipped.\n1 of them fall on dates covered by synced activities; analytics uses the synced ones there.\n',
    );
    expect(stderr).toBe('warning: b.csv:3: 9 fields, the header has 8; mapped by position (a comma in an unquoted title?)\n');
    expect(store.countImportedActivities()).toBe(2);
    const report = json<{ added: number; updated: number; covered: number }>((await run(deps, 'import-activities', a, '--json')).stdout);
    expect(report).toMatchObject({ added: 0, updated: 1, covered: 0 });
  });
});

describe('garmin status', () => {
  it('shows the number of threshold rows and imported activities', async () => {
    const { deps, store } = fake();
    store.upsertImportedActivities([{ id: 'csv-0000000001', start_time_local: '2025-03-01 07:00:00', source_file: 'a.csv', imported_at: NOW }]);
    const res = json<{ analytics: unknown; auth: { logged_in: boolean; tokens_file: string } }>((await run(deps, 'status', '--json')).stdout);
    expect(res.analytics).toEqual({ thresholds: 1, imported_activities: 1 });
    expect(res.auth).toMatchObject({ logged_in: false, tokens_file: path.join(tmp, 'tokens.json') });
    const text = (await run({ ...deps, store: () => fake().store }, 'status')).stdout;
    expect(text).toContain('Analytics:      1 threshold rows, 0 imported activities');
  });
});

// ------------------------------------------------------------ writes to Garmin Connect on a mocked client

/**
 * A Garmin service over an in-memory store whose client answers only the write methods of
 * `upload` and `log` (and the reads that follow them); any other call fails the test.
 */
function writer(bodyUpload: unknown = { status: 'processing' }) {
  const calls: { name: string; args: unknown[] }[] = [];
  const ride = {
    activityId: 901,
    activityName: 'Morning Ride',
    activityTypeDTO: { typeId: 2, typeKey: 'cycling' },
    summaryDTO: { startTimeLocal: '2026-10-07T07:00:00.0', startTimeGMT: '2026-10-07T07:00:00.0', distance: 30_000, duration: 3600 },
  };
  const methods: Record<string, (...args: unknown[]) => unknown> = {
    uploadActivityFile: (name) => {
      if (name === 'body_composition.fit') return bodyUpload;
      if (name === 'new.fit') return { status: 'created', activityId: 901 };
      if (name === 'dup.gpx') return { status: 'duplicate', activityId: 900, message: 'Duplicate Activity.' };
      if (name === 'slow.tcx') return { status: 'processing' };
      throw new ClientNetworkError('/upload-service/upload', 'HTTP 400 - Bad file', 400);
    },
    getActivity: () => ride,
    addWeighIn: () => null,
    getWeighIns: () => ({
      dailyWeightSummaries: [{ summaryDate: '2026-10-08', allWeightMetrics: [{ samplePk: 1, date: Date.parse('2026-10-08T07:30:00Z'), calendarDate: '2026-10-08', weight: 72_400, sourceType: 'MANUAL', timestampGMT: Date.parse('2026-10-08T07:30:00Z') }] }],
    }),
    addBloodPressure: () => null,
    addHydration: () => ({ calendarDate: '2026-10-08', valueInML: 1500 }),
    downloadCourseGpx: () => ({ data: new TextEncoder().encode('<gpx/>'), contentType: 'application/gpx+xml', filename: 'Kampinos.gpx' }),
    uploadCourseGpx: () => ({ courseId: 900001, courseName: 'Evening Loop', distanceMeter: 5230, elevationGainMeter: 84.4 }),
  };
  const client = new Proxy(
    {},
    {
      get: (_, name) =>
        name === 'then'
          ? undefined
          : (...args: unknown[]) => {
              calls.push({ name: String(name), args });
              const fn = methods[String(name)];
              if (!fn) return Promise.reject(new Error(`Unexpected Garmin call: ${String(name)}`));
              try {
                return Promise.resolve(fn(...args));
              } catch (e) {
                return Promise.reject(e as Error);
              }
            },
    },
  );
  const store = Store.open(':memory:');
  const syncer = new Syncer(client as never, store, { timeZone: 'UTC', now: () => NOW, fetchOnDemand: false });
  const jobs = new SyncJobRunner(syncer, store, { chunkDays: 7, pause: { minMs: 0, maxMs: 0 }, maxRequestsPerDay: 10_000, timeZone: 'UTC', now: () => NOW });
  const garmin = new GarminService({ client: client as never, store, syncer, jobs, timeZone: 'UTC', downloadDir: os.tmpdir(), budgetMs: 200, autoSync: false, now: () => NOW });
  const deps: ProgramDeps = { garmin: () => Promise.resolve({ garmin, close: () => {} }), now: () => NOW };
  return { deps, store, calls };
}

describe('garmin upload', () => {
  const file = (name: string) => {
    const f = path.join(tmp, name);
    fs.writeFileSync(f, new Uint8Array([14, 0x20, 1, 2, 3]));
    return f;
  };

  it('uploads each file, stores a new activity and reports duplicates without failing', async () => {
    const { deps, store, calls } = writer();
    const { stdout } = await run(deps, 'upload', file('new.fit'), file('dup.gpx'), file('slow.tcx'));
    expect(stdout).toBe(
      [
        'new.fit: uploaded as activity 901 (2026-10-07 07:00 cycling "Morning Ride")',
        'dup.gpx: already in Garmin Connect as activity 900 (Duplicate Activity.), nothing uploaded',
        'slow.tcx: accepted, Garmin is still processing it; it comes with the next `garmin sync --scope activities`',
        '',
      ].join('\n'),
    );
    expect(process.exitCode ?? 0).toBe(0);
    expect(calls.map((c) => c.name)).toEqual(['uploadActivityFile', 'getActivity', 'uploadActivityFile', 'uploadActivityFile']);
    expect(calls[0]?.args).toEqual(['new.fit', new Uint8Array([14, 0x20, 1, 2, 3])]);
    // The new activity is in the cache before any sync.
    expect(store.queryActivities({}).map((a) => [a.id, a.name, a.type])).toEqual([[901, 'Morning Ride', 'cycling']]);
    expect(store.getActivityDetail(901, 'summary')).toBeDefined();
  });

  it('prints one JSON entry per file and fails on a refused file without stopping the others', async () => {
    const { deps } = writer();
    try {
      const res = json<{ file: string; status: string; activity_id?: number; stored?: boolean; message?: string }[]>(
        (await run(deps, 'upload', file('bad.fit'), file('new.fit'), '--json')).stdout,
      );
      expect(res).toEqual([
        { file: 'bad.fit', status: 'failed', message: expect.stringContaining('HTTP 400 - Bad file') },
        { file: 'new.fit', status: 'created', activity_id: 901, stored: true, name: 'Morning Ride', type: 'cycling', start_local: '2026-10-07 07:00' },
      ]);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = 0;
    }
  });

  it('checks every file before the first upload', async () => {
    const { deps, calls } = writer();
    await expect(run(deps, 'upload', file('new.fit'), file('track.kml'))).rejects.toThrow('track.kml: only .fit, .gpx, .tcx files can be uploaded');
    await expect(run(deps, 'upload', file('new.fit'), path.join(tmp, 'missing.fit'))).rejects.toThrow('ENOENT');
    expect(calls).toEqual([]);
  });
});

describe('garmin course', () => {
  it('saves a course as GPX into a directory or a file', async () => {
    const { deps, calls } = writer();
    const dir = fs.mkdtempSync(path.join(tmp, 'courses-'));
    expect((await run(deps, 'course', 'download', '102339772', '--out', dir)).stdout).toBe(`Saved course 102339772 as ${path.join(dir, 'Kampinos.gpx')} (6 bytes).\n`);
    expect(fs.readFileSync(path.join(dir, 'Kampinos.gpx'), 'utf8')).toBe('<gpx/>');
    const target = path.join(dir, 'race.gpx');
    expect(json<{ path: string; bytes: number }>((await run(deps, 'course', 'download', '102339772', '--out', target, '--json')).stdout)).toEqual({ course_id: 102339772, path: target, bytes: 6 });
    expect(calls.map((c) => [c.name, ...c.args])).toEqual([
      ['downloadCourseGpx', 102339772],
      ['downloadCourseGpx', 102339772],
    ]);
    await expect(run(deps, 'course', 'download', 'abc')).rejects.toThrow('course id must be a positive integer');
  });

  it('uploads a GPX file as a course and refuses other files before any request', async () => {
    const { deps, calls } = writer();
    const gpx = path.join(tmp, 'Evening Loop.gpx');
    fs.writeFileSync(gpx, '<gpx/>');
    expect((await run(deps, 'course', 'upload', gpx)).stdout).toBe('Evening Loop.gpx: uploaded as course 900001 ("Evening Loop", 5.23 km, 84 m up).\n');
    expect(calls.map((c) => c.name)).toEqual(['uploadCourseGpx']);
    expect(calls[0]?.args).toEqual(['Evening Loop.gpx', new TextEncoder().encode('<gpx/>')]);
    expect(json((await run(deps, 'course', 'upload', gpx, '--json')).stdout)).toEqual({ file: 'Evening Loop.gpx', id: 900001, name: 'Evening Loop', distance_km: 5.23, elevation_gain_m: 84 });
    await expect(run(deps, 'course', 'upload', path.join(tmp, 'route.fit'))).rejects.toThrow('only .gpx files can be uploaded as a course');
    expect(calls).toHaveLength(2);
  });
});

describe('garmin log', () => {
  it('adds a weigh-in and downloads that day again into the cache', async () => {
    const { deps, store, calls } = writer();
    expect((await run(deps, 'log', 'weight', '72.4')).stdout).toBe('Logged weight 72.4 kg at 2026-10-08 12:00.\n');
    expect(calls.map((c) => [c.name, ...c.args])).toEqual([
      ['addWeighIn', 72.4, { local: '2026-10-08T12:00:00', utc: new Date(NOW) }],
      ['getWeighIns', '2026-10-08', '2026-10-08'],
    ]);
    expect(store.getBodyComposition('2026-10-08', '2026-10-08').map((r) => r.weight_kg)).toEqual([72.4]);
    const res = json<{ logged: string; weight_kg: number; at: string; stored: boolean }>((await run(deps, 'log', 'weight', '72', '--date', '2026-10-01 07:15', '--json')).stdout);
    expect(res).toEqual({ logged: 'weight', weight_kg: 72, at: '2026-10-01 07:15', stored: true });
    await expect(run(deps, 'log', 'weight', 'abc')).rejects.toThrow('weight must be a number');
    await expect(run(deps, 'log', 'weight', '720')).rejects.toThrow('weight (kg) must be from 20 to 400');
    await expect(run(deps, 'log', 'weight', '72', '--date', '2026-10-09')).rejects.toThrow('is in the future');
    expect(calls.filter((c) => c.name === 'addWeighIn')).toHaveLength(2);
  });

  it('sends weight with body fat as a weight scale FIT file and downloads that day again', async () => {
    const { deps, calls } = writer();
    const { stdout } = await run(deps, 'log', 'weight', '72.4', '--fat', '18.5', '--date', '2026-10-07 07:30');
    expect(stdout).toBe(
      'Logged weight 72.4 kg, body fat 18.5 % at 2026-10-07 07:30.\n' +
        'Garmin is still processing the file; if the weigh-in is missing, run `garmin sync --scope health --from 2026-10-07 --to 2026-10-07 --force` later\n',
    );
    expect(calls.map((c) => c.name)).toEqual(['uploadActivityFile', 'getWeighIns']);
    expect(calls[0]?.args[0]).toBe('body_composition.fit');
    expect(calls[1]?.args).toEqual(['2026-10-07', '2026-10-07']);
    // FIT header, then the weight_scale message: timestamp (s since 1989-12-31), weight and fat in hundredths.
    const file = Buffer.from(calls[0]?.args[1] as Uint8Array);
    expect(file.subarray(8, 12).toString()).toBe('.FIT');
    const fitTime = Date.parse('2026-10-07T07:30:00Z') / 1000 - 631_065_600;
    const le = (v: number, n: number) => Array.from({ length: n }, (_, i) => Math.floor(v / 2 ** (8 * i)) % 256);
    expect(file.includes(Buffer.from([...le(fitTime, 4), ...le(7240, 2), ...le(1850, 2)]))).toBe(true);
  });

  it('reports a weigh-in Garmin already has and refuses a file Garmin rejects or a fat value out of range', async () => {
    const dup = writer({ status: 'duplicate', message: 'Duplicate Activity.' });
    const res = json<Record<string, unknown>>((await run(dup.deps, 'log', 'weight', '72', '--fat', '20', '--json')).stdout);
    expect(res).toEqual({
      logged: 'weight',
      weight_kg: 72,
      body_fat_pct: 20,
      at: '2026-10-08 12:00',
      stored: true,
      note: 'Garmin already has this measurement (Duplicate Activity.); nothing new was added',
    });
    const created = writer({ status: 'created', activityId: 5 });
    expect((await run(created.deps, 'log', 'weight', '72', '--fat', '20')).stdout).toBe('Logged weight 72 kg, body fat 20 % at 2026-10-08 12:00.\n');

    const refused = writer({ status: 'failed', message: 'Unrecognized file' });
    await expect(run(refused.deps, 'log', 'weight', '72', '--fat', '20')).rejects.toThrow('Garmin refused the body composition file: Unrecognized file');
    expect(refused.calls.map((c) => c.name)).toEqual(['uploadActivityFile']);
    await expect(run(refused.deps, 'log', 'weight', '72', '--fat', '90')).rejects.toThrow('body fat (%) must be from 1 to 75');
    await expect(run(refused.deps, 'log', 'weight', '72', '--fat', 'lean')).rejects.toThrow('--fat must be a number');
    expect(refused.calls).toHaveLength(1);
  });

  it('adds blood pressure with an optional pulse and note', async () => {
    const { deps, calls } = writer();
    expect((await run(deps, 'log', 'bp', '120/80', '--pulse', '62')).stdout).toBe('Logged blood pressure 120/80 mmHg, pulse 62 at 2026-10-08 12:00.\n');
    const res = json<Record<string, unknown>>((await run(deps, 'log', 'bp', '118/76', '--note', 'after coffee', '--date', '2026-10-07', '--json')).stdout);
    expect(res).toEqual({ logged: 'blood_pressure', systolic: 118, diastolic: 76, at: '2026-10-07 12:00' });
    expect(calls.map((c) => c.args[0])).toEqual([
      { systolic: 120, diastolic: 80, pulse: 62, notes: undefined, at: { local: '2026-10-08T12:00:00', utc: new Date(NOW) } },
      { systolic: 118, diastolic: 76, pulse: undefined, notes: 'after coffee', at: { local: '2026-10-07T12:00:00', utc: new Date('2026-10-07T12:00:00Z') } },
    ]);
    await expect(run(deps, 'log', 'bp', '80/120')).rejects.toThrow('systolic must be higher than diastolic');
    await expect(run(deps, 'log', 'bp', '120/80', '--pulse', 'fast')).rejects.toThrow('--pulse must be a number');
    expect(calls).toHaveLength(2);
  });

  it('adds water to a day and shows the day total Garmin answers with', async () => {
    const { deps, calls } = writer();
    expect((await run(deps, 'log', 'water', '500')).stdout).toBe('Logged 500 ml of water on 2026-10-08 (day total 1500 ml).\n');
    const res = json<Record<string, unknown>>((await run(deps, 'log', 'water', '250', '--date', '2026-10-06', '--json')).stdout);
    expect(res).toEqual({ logged: 'water', water_ml: 250, date: '2026-10-06', day_total_ml: 1500 });
    expect(calls.map((c) => [c.args[0], (c.args[1] as { local: string }).local])).toEqual([
      [500, '2026-10-08T12:00:00'],
      [250, '2026-10-06T12:00:00'],
    ]);
    await expect(run(deps, 'log', 'water', '0')).rejects.toThrow('water (ml) must be a whole number from 1 to 5000');
  });
});
