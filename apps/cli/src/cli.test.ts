import type { Command } from 'commander';
import { AnalyticsService } from 'garmin-mcp-analytics';
import { eachDay, type GarminConfig } from 'garmin-mcp-config';
import { GarminService } from 'garmin-mcp-domain';
import { addRange, parseRangeSet, Store, Syncer, SyncJobRunner } from 'garmin-mcp-store';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProgram, VERSION, type ProgramDeps } from './commands.js';
import { table } from './io.js';
import { anonymize, RECORDABLE } from './record.js';

const NO_SHIFT = { lat: 0, lon: 0 };

describe('anonymize', () => {
  it('scrubs personal fields but keeps data ids and shapes', () => {
    const out = anonymize({
      displayName: 'jan.kowalski',
      fullName: 'Jan Kowalski',
      profileId: 123456,
      activityId: 99,
      note: 'mail me at jan@example.org',
      polyline: [{ lat: 52.2297, lon: 21.0122 }],
      nested: { ownerId: 5, garminGUID: 'abc' },
    }, NO_SHIFT);
    expect(out).toEqual({
      displayName: 'anon-displayName',
      fullName: 'anon-fullName',
      profileId: 90001,
      activityId: 99,
      note: 'mail me at anon@example.com',
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
      activityName: 'Siechnice - BC1 5km',
      workoutName: 'LONG 26 km',
      description: 'Nd 20.09 RANO',
      calendarItems: [{ id: 1, title: 'UltraKotlina 50 2026 59/425' }],
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
        activityDetailMetrics: [{ metrics: [150, 51.0123, 17.0456] }, { metrics: [151, null, null] }],
        geoPolylineDTO: { minLat: 51.0123, maxLon: 17.9, polyline: [{ lat: 51.0123, lon: 17.0456 }] },
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
      activityDetailMetrics: [{ metrics: [150, 0.5123, 0.2956] }, { metrics: [151, null, null] }],
      geoPolylineDTO: { minLat: 0.5123, maxLon: 0.15, polyline: [{ lat: 0.5123, lon: 0.2956 }] },
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

  it('covers every client fixture name', () => {
    expect(Object.keys(RECORDABLE)).toContain('training-status');
    expect(Object.keys(RECORDABLE)).toHaveLength(38);
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
      'doctor',
      'serve',
      'record',
    ]);
    const thresholds = buildProgram().commands.find((c) => c.name() === 'thresholds');
    expect(thresholds?.commands.map((c) => c.name())).toEqual(['list', 'add', 'export', 'import']);
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
    expect(stdout).toContain('# Load 2026-09-11..2026-10-08 (hrtss)');
    expect(stdout).toContain('| date | tss | ctl | atl | tsb | acwr | monotony | strain |');
    expect(stdout).toMatch(/\| 2026-10-08 \| 69\.4 \| \d+(\.\d)? \|/);
    expect(stdout).toContain('| 2026-W41 | run | 4 | 4 | 40 |');
    expect(stdout).toContain('## Intensity 2026-09-11..2026-10-08 (run and bike)');
    expect(stdout).toContain('| bike | 170 | 146 | No lthr_bike in the threshold history; the running LTHR is used. LT1 approximated');
    expect(stdout).toContain('\n> ');
    expect(stdout).not.toContain('## Series');
    expect(opened[0]?.autoFetch).toBe(false);
    expect(calls).toEqual([]);
  });

  it('adds the optional sections and prints the tool envelope with --json', async () => {
    const { deps } = fake();
    const md = (await run(deps, 'load', '--from', '2026-10-01', '--series', '--activities', '--efficiency')).stdout;
    expect(md).toContain('## Series');
    expect(md).toContain('| 2026-10-01 | run | running | Run 2026-10-01 | 1:00 | 10 | 150 | 0.833 | 69.4 |');
    expect(md).toContain('## Efficiency (aerobic sessions)');
    const res = json<{ data: { latest: { tss: number }; series: unknown[]; flags_used: Record<string, number> }; meta: { source: string } }>(
      (await run(deps, 'load', '--from', '2026-10-01', '--series', '--json')).stdout,
    );
    expect(res.meta.source).toBe('cache');
    expect(res.data.latest.tss).toBe(69.4);
    expect(res.data.series).toHaveLength(8);
    expect(res.data.flags_used.acwr_high).toBe(1.5);
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
    expect(res.meta.note).toContain('Ignored flags (unknown key or not a number): nope');
    fs.writeFileSync(file, '[1]');
    await expect(run(deps, 'load', '--flags', file)).rejects.toThrow('must hold a JSON object');
    await expect(run(deps, 'load', '--source', 'epoc')).rejects.toThrow('Allowed choices are hrtss, garmin_load');
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
    fs.writeFileSync(file, JSON.stringify({ sleep_h_red: 9 }));
    const res = json<{ data: { decision: string; rules_used: Record<string, number>; signals: { name: string; rating: string }[] } }>(
      (await run(deps, 'readiness', '2026-10-07', '--rules', file, '--json')).stdout,
    );
    expect(res.data.decision).toBe('REST');
    expect(res.data.rules_used.sleep_h_red).toBe(9);
    expect(res.data.signals.find((s) => s.name === 'sleep')?.rating).toBe('red');
    await expect(run(deps, 'readiness', '2099-01-01')).rejects.toThrow('is in the future');
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
