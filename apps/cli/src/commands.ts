import { Command, Option } from 'commander';
import { AnalyticsService, importActivities, LOAD_SOURCES, SET_THRESHOLD_SOURCES, type LoadSource } from 'garmin-mcp-analytics';
import { BrowserUnavailableError, diagnose, findBrowser, isAuthError, pythonFallbackCommand, type LoginResult } from 'garmin-mcp-auth';
import { addDays, assertIsoDate, GarminError, InputError, loadConfig, parsePauseSeconds, type GarminConfig, type RawConfig } from 'garmin-mcp-config';
import { activityBrief, createRuntime, healthTable, HEALTH_METRICS, type HealthMetric, type Runtime } from 'garmin-mcp-domain';
// The one sanctioned app-to-app import: `garmin serve` runs the MCP server in-process.
import { startServer } from 'garmin-mcp-server';
import { databasePath, forgetAccount, readAccount, SYNC_SCOPES, Store, type SyncScope } from 'garmin-mcp-store';
import fs from 'node:fs';
import path from 'node:path';
import { loadMarkdown, parseThresholdsCsv, readinessMarkdown, readJsonObject, setThresholdText, thresholdsCsv, thresholdsMarkdown } from './analytics.js';
import { err, out, prompt, promptHidden, table } from './io.js';
import { RECORDABLE, writeFixture } from './record.js';

/** Read from the package's own package.json (src/ in tests, dist/ when installed), so `nx release` bumps it. */
export const VERSION: string = (JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

interface GlobalOpts {
  dataDir?: string;
  region?: 'global' | 'cn';
  logLevel?: string;
}

function configFrom(cmd: Command, extra: RawConfig = {}): GarminConfig {
  const g = cmd.optsWithGlobals<GlobalOpts>();
  return loadConfig({
    overrides: {
      ...(g.dataDir ? { dataDir: g.dataDir } : {}),
      ...(g.region ? { region: g.region } : {}),
      ...(g.logLevel ? { logLevel: g.logLevel as RawConfig['logLevel'] } : { logLevel: 'warn' }),
      ...extra,
    },
  });
}

/** Open the local database read-only-ish without touching the network. */
function openLocalStore(config: GarminConfig): Store | undefined {
  const account = readAccount(config.dataDir);
  if (!account) return undefined;
  const file = databasePath(config.dataDir, account.hash);
  return fs.existsSync(file) ? Store.open(file) : undefined;
}

/** The analytics service of a command and how to release it. */
export interface AnalyticsHandle {
  analytics: AnalyticsService;
  close(): void;
}

/** Seams for tests: the analytics commands and `status` run on an in-memory store there. */
export interface ProgramDeps {
  /** Opens the analytics service (default: the account's database through `runtime.service()`). */
  analytics?: (config: GarminConfig) => Promise<AnalyticsHandle>;
  /** Opens the local database for `status` (default: the account's file, if it exists). */
  store?: (config: GarminConfig) => Store | undefined;
  now?: () => number;
}

/**
 * The analytics service over the account's database. The service opens like for any read
 * (the account from `account.json`, the profile from the cache); with auto fetch off the
 * commands never download, missing data comes back as a note with the `garmin sync` command.
 */
async function openAnalytics(config: GarminConfig): Promise<AnalyticsHandle> {
  const rt = createRuntime(config);
  const garmin = await rt.service();
  return { analytics: new AnalyticsService(garmin), close: () => rt.close() };
}

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString().replace('.000Z', 'Z') : '-');

export function buildProgram(deps: ProgramDeps = {}): Command {
  const now = deps.now ?? Date.now;
  const openStore = deps.store ?? openLocalStore;
  /** Runs `fn` with the analytics service of the command; never downloads from Garmin. */
  const withAnalytics = async <T>(cmd: Command, fn: (a: AnalyticsService) => Promise<T> | T): Promise<T> => {
    const handle = await (deps.analytics ?? openAnalytics)(configFrom(cmd, { autoFetch: false }));
    try {
      return await fn(handle.analytics);
    } finally {
      handle.close();
    }
  };
  const program = new Command()
    .name('garmin')
    .description('Garmin Connect MCP: login, sync to a local SQLite cache, previews and diagnostics')
    .version(VERSION)
    .option('--data-dir <dir>', 'data directory (default ~/.garmin-mcp, env GARMIN_DATA_DIR)')
    .addOption(new Option('--region <region>', 'Garmin region').choices(['global', 'cn']))
    .option('--log-level <level>', 'log level on stderr (default warn)');

  program
    .command('login')
    .description("sign in to Garmin Connect; by default in Garmin's own page in your browser (the password never reaches this tool)")
    .addOption(
      new Option('--strategy <strategy>', 'browser window, or terminal prompts sent via curl-impersonate / plain fetch').choices([
        'auto',
        'browser',
        'curl',
        'fetch',
      ]),
    )
    .option('--email <email>', 'terminal login: account e-mail (default GARMIN_EMAIL or prompt)')
    .option('--token-path <file>', 'where to write tokens (default <data dir>/tokens.json)')
    .action(async (opts: { email?: string; tokenPath?: string; strategy?: 'auto' | 'browser' | 'curl' | 'fetch' }, cmd: Command) => {
      const config = configFrom(cmd, {
        ...(opts.tokenPath ? { tokensFile: opts.tokenPath } : {}),
        ...(opts.strategy ? { ssoStrategy: opts.strategy } : {}),
      });
      const rt = createRuntime(config);
      const strategy = config.ssoStrategy;
      let result: LoginResult | undefined;
      if (strategy === 'browser' || (strategy === 'auto' && findBrowser(config.browserPath))) {
        try {
          result = await rt.auth.loginWithBrowser({ onStatus: (m) => err(m) });
        } catch (e) {
          // In auto mode a browser that cannot start falls back to the terminal; a closed window does not.
          if (strategy !== 'auto' || !(e instanceof BrowserUnavailableError)) throw e;
          err(`${e.message}\nFalling back to terminal login.`);
        }
      }
      if (!result) {
        const email = opts.email ?? config.email ?? (await prompt('Garmin e-mail: '));
        const password = config.password ?? (await promptHidden('Password: '));
        err('Logging in...');
        result = await rt.auth.login({ email, password }, async (method) => prompt(`MFA code (${method}): `));
      }
      const account = await rt.account({ fresh: true }).catch(() => undefined);
      out(`Logged in${account?.displayName ? ` as ${account.displayName}` : ''} via ${result.strategy}. Token valid until ${result.expiresAt.toISOString()}.`);
      out(`Tokens: ${config.tokensFile}`);
      out('Nothing is downloaded until you ask: e.g. `garmin sync --scope health --from 2026-09-01 --to 2026-09-30`.');
    });

  program
    .command('import-tokens <file>')
    .description('import tokens written by python-garminconnect 0.3.x (garmin_tokens.json or its directory)')
    .action(async (file: string, _opts: unknown, cmd: Command) => {
      const config = configFrom(cmd);
      const rt = createRuntime(config);
      await rt.auth.importTokens(path.resolve(file));
      const account = await rt.account({ fresh: true });
      out(`Imported tokens for ${account.displayName ?? 'account'} into ${config.tokensFile}.`);
    });

  program
    .command('logout')
    .description('delete stored tokens (the local database is kept)')
    .action(async (_opts: unknown, cmd: Command) => {
      const config = configFrom(cmd);
      await createRuntime(config).auth.logout();
      forgetAccount(config.dataDir);
      out(`Removed ${config.tokensFile}.`);
    });

  program
    .command('status')
    .description('token, database and last sync status')
    .option('--json', 'machine readable output')
    .action(async (opts: { json?: boolean }, cmd: Command) => {
      const config = configFrom(cmd);
      const rt = createRuntime(config);
      const auth = await rt.auth.status();
      const account = readAccount(config.dataDir);
      const store = openStore(config);
      const report = {
        auth: { logged_in: auth.loggedIn, tokens_file: auth.tokensFile, expires_at: auth.expiresAt?.toISOString(), client_id: auth.clientId },
        account: account && { display_name: account.displayName, database: databasePath(config.dataDir, account.hash) },
        tables: store?.tableStats(),
        limits: store && {
          requests_today: Number(store.getMeta(`sync:requests:${new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date())}`) ?? 0),
          max_requests_per_day: config.syncMaxRequestsPerDay,
          paused_until: Number(store.getMeta('sync:paused_until') ?? 0) > Date.now() ? iso(Number(store.getMeta('sync:paused_until'))) : undefined,
          pause_reason: Number(store.getMeta('sync:paused_until') ?? 0) > Date.now() ? store.getMeta('sync:pause_reason') : undefined,
        },
        synced: store && { activities: store.getMeta('activities:covered'), weigh_ins: store.getMeta('weighins:covered') },
        analytics: store && { thresholds: store.listThresholds().length, imported_activities: store.countImportedActivities() },
        recent_syncs: store?.recentSyncs(5).map((s) => ({ id: s.id, scope: s.scope, mode: s.mode, status: s.status, started: iso(s.started_at), finished: iso(s.finished_at) })),
      };
      store?.close();
      if (opts.json) return out(JSON.stringify(report, null, 2));
      out(`Logged in:      ${auth.loggedIn ? `yes (${auth.clientId ?? 'unknown client'}, access token until ${auth.expiresAt?.toISOString() ?? '?'})` : 'no - run `garmin login`'}`);
      out(`Tokens file:    ${auth.tokensFile}`);
      out(`Database:       ${report.account?.database ?? '(none yet)'}`);
      const l = report.limits;
      if (l) out(`Requests today: ${l.requests_today}/${l.max_requests_per_day}${l.paused_until ? ` - syncing paused until ${l.paused_until}: ${l.pause_reason ?? ''}` : ''}`);
      if (report.synced?.activities) out(`Activities synced: ${report.synced.activities}`);
      if (report.analytics) out(`Analytics:      ${report.analytics.thresholds} threshold rows, ${report.analytics.imported_activities} imported activities`);
      if (report.tables) out(`\n${table(report.tables)}`);
      if (report.recent_syncs?.length) out(`\n${table(report.recent_syncs)}`);
    });

  program
    .command('sync')
    .description('download from Garmin into the local database: any scope and date range, only on request; stored days are skipped')
    .addOption(new Option('--scope <scope>', 'what to sync').choices([...SYNC_SCOPES]).default('all'))
    .option('--from <date>', 'start date YYYY-MM-DD (default: 7 days before --to)')
    .option('--to <date>', 'end date YYYY-MM-DD (default: today)')
    .option('--force', 're-download days that are already stored')
    .option('--pause <seconds>', 'pause between 7-day chunks: a random range like 1-11, a fixed number, or 0 (default GARMIN_SYNC_PAUSE_S)')
    .action(async (opts: { scope: SyncScope; from?: string; to?: string; force?: boolean; pause?: string }, cmd: Command) => {
      const config = configFrom(cmd);
      const rt = createRuntime(config);
      const service = await rt.service();
      const to = opts.to ? assertIsoDate(opts.to, '--to') : service.today();
      const from = opts.from ? assertIsoDate(opts.from, '--from') : addDays(to, -6);
      const ac = new AbortController();
      const onSigint = () => {
        err('\nStopping after the current step (stored data is kept)...');
        ac.abort();
      };
      process.once('SIGINT', onSigint);
      out(`Syncing ${opts.scope} ${from}..${to}${opts.force ? ' (force)' : ''}`);
      const report = await service.jobs.run({
        scope: opts.scope,
        from,
        to,
        force: opts.force,
        signal: ac.signal,
        ...(opts.pause !== undefined ? { pause: parsePauseSeconds(opts.pause, '--pause') } : {}),
        onProgress: (p) => {
          if (p.phase === 'daily' && p.chunk) err(`  [${p.chunks_done + 1}/${p.chunks_total}] ${p.chunk.from}..${p.chunk.to}  (${p.requests} requests so far)`);
          else if (p.phase === 'pause' && p.next_at) err(`  pause until ${new Date(p.next_at).toLocaleTimeString()} (Ctrl+C is safe)`);
          else if (p.phase !== 'daily') err(`  ${p.phase}`);
        },
      });
      process.off('SIGINT', onSigint);
      rt.close();
      out(`\n${report.status === 'done' ? 'Done' : `Stopped: ${report.status}`} - ${report.requests} requests in ${((report.finished_at - report.started_at) / 1000).toFixed(0)} s`);
      const fetched = Object.entries(report.fetched).map(([what, n]) => ({ what, stored: n }));
      if (fetched.length) out(table(fetched));
      if (report.reason) err(report.reason);
      if (report.remaining) {
        const when = report.resume_at ? ` after ${new Date(report.resume_at).toLocaleString()}` : '';
        out(`Not synced yet: ${report.remaining.from}..${report.remaining.to}. Run the same command again${when} to continue.`);
      }
      if (report.errors.length) {
        err(`\n${report.errors.length} item(s) failed:`);
        for (const e of report.errors.slice(0, 10)) err(`  ${e.item}: ${e.code} ${e.message}`);
      }
      if (report.status === 'paused') process.exitCode = 1;
    });

  program
    .command('activities')
    .description('preview activities from the local database (no network)')
    .option('--from <date>')
    .option('--to <date>')
    .option('--type <type>', 'type key, e.g. running')
    .option('--limit <n>', 'rows', '20')
    .option('--json', 'JSON output')
    .action((opts: { from?: string; to?: string; type?: string; limit: string; json?: boolean }, cmd: Command) => {
      const store = openLocalStore(configFrom(cmd));
      if (!store) throw new GarminError('NO_DATABASE', 'No local database yet', { hint: 'Run `garmin login` and `garmin sync` first.' });
      const rows = store.queryActivities({ from: opts.from, to: opts.to, type: opts.type, limit: Number(opts.limit) }).map(activityBrief);
      store.close();
      if (opts.json) return out(JSON.stringify(rows, null, 2));
      out(table(rows.map((r) => ({ id: r.id, date: r.date, time: r.start_local, type: r.type, name: r.name, duration: r.duration, km: r.distance_km, pace: r.avg_pace ?? (r.avg_speed_kmh ? `${r.avg_speed_kmh} km/h` : undefined), hr: r.avg_hr_bpm, load: r.training_load }))));
    });

  program
    .command('health <metric>')
    .description(`preview a daily metric from the local database (${HEALTH_METRICS.join(', ')})`)
    .option('--from <date>')
    .option('--to <date>')
    .option('--week', 'aggregate by ISO week')
    .option('--json', 'JSON output')
    .action((metric: string, opts: { from?: string; to?: string; week?: boolean; json?: boolean }, cmd: Command) => {
      if (!(HEALTH_METRICS as readonly string[]).includes(metric)) throw new InputError(`Unknown metric "${metric}". Use one of: ${HEALTH_METRICS.join(', ')}`);
      const config = configFrom(cmd);
      const store = openLocalStore(config);
      if (!store) throw new GarminError('NO_DATABASE', 'No local database yet', { hint: 'Run `garmin login` and `garmin sync` first.' });
      const to = opts.to ?? new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date());
      const from = opts.from ?? addDays(to, -13);
      const rows = { daily: store.getDaily('daily_summary', from, to), sleep: store.getDaily('sleep', from, to), hrv: store.getDaily('hrv', from, to) };
      const result = healthTable([metric as HealthMetric], rows, from, to, opts.week ? 'week' : 'day');
      store.close();
      if (opts.json) return out(JSON.stringify(result, null, 2));
      out(table(result.rows));
      const s = result.summary[metric as HealthMetric];
      if (s) out(`\navg ${s.avg ?? '-'}  min ${s.min ?? '-'}  max ${s.max ?? '-'}  days ${s.days_with_data}  trend ${s.trend?.direction ?? '-'}`);
    });

  program
    .command('load')
    .description('own training load model from the local database: TSS from power, pace or HR, CTL/ATL/TSB, ACWR, monotony, weeks, intensity (no network)')
    .option('--from <date>', 'start date YYYY-MM-DD (default: 27 days before --to)')
    .option('--to <date>', 'end date YYYY-MM-DD (default: today)')
    .addOption(
      new Option('--source <source>', 'daily load: auto (power, pace, then heart rate per activity), hrtss (heart rate only), or Garmin training load')
        .choices([...LOAD_SOURCES])
        .default('auto'),
    )
    .option('--flags <file>', 'JSON object overriding flag thresholds, e.g. {"acwr_high": 1.4}')
    .option('--series', 'add the daily series of the range')
    .option('--activities', 'add per-activity metrics of the range')
    .option('--efficiency', 'add the monthly efficiency factor of aerobic sessions')
    .option('--json', 'the { data, meta } envelope of the get_load tool')
    .action(
      async (
        opts: { from?: string; to?: string; source: LoadSource; flags?: string; series?: boolean; activities?: boolean; efficiency?: boolean; json?: boolean },
        cmd: Command,
      ) => {
        const flags = opts.flags ? readJsonObject(opts.flags, '--flags') : undefined;
        const res = await withAnalytics(cmd, (a) =>
          a.getLoad({
            from: opts.from,
            to: opts.to,
            source: opts.source,
            include_series: opts.series,
            include_activities: opts.activities,
            include_efficiency: opts.efficiency,
            flags,
          }),
        );
        out(opts.json ? JSON.stringify(res, null, 2) : loadMarkdown(res));
      },
    );

  program
    .command('readiness [date]')
    .description('morning GO / MODIFY / REST decision from HRV, resting HR, sleep, body battery, training readiness, stress and load (no network)')
    .option('--rules <file>', 'JSON object overriding decision thresholds, e.g. {"sleep_h_red": 5.5}')
    .option('--json', 'the { data, meta } envelope of the get_readiness tool')
    .action(async (date: string | undefined, opts: { rules?: string; json?: boolean }, cmd: Command) => {
      const rules = opts.rules ? readJsonObject(opts.rules, '--rules') : undefined;
      const res = await withAnalytics(cmd, (a) => a.getReadiness({ date, rules }));
      out(opts.json ? JSON.stringify(res, null, 2) : readinessMarkdown(res));
    });

  const thresholds = program.command('thresholds').description('threshold history (LTHR, LT1, HRmax, FTP ...): list, add, export and import as CSV');
  thresholds
    .command('list', { isDefault: true })
    .description('thresholds in effect on a date, per sport, and optionally the whole history (default)')
    .option('--date <date>', 'date YYYY-MM-DD (default: today)')
    .option('--param <param>', 'only this parameter')
    .option('--history', 'add every stored row')
    .option('--json', 'the { data, meta } envelope of the get_thresholds tool')
    .action(async (opts: { date?: string; param?: string; history?: boolean; json?: boolean }, cmd: Command) => {
      const res = await withAnalytics(cmd, (a) => a.getThresholds({ date: opts.date, param: opts.param, history: opts.history }));
      out(opts.json ? JSON.stringify(res, null, 2) : thresholdsMarkdown(res));
    });
  thresholds
    .command('add <date> <param> <value>')
    .description('record a threshold (field test or manual value) effective from a date')
    .addOption(new Option('--source <source>', 'where the value comes from').choices([...SET_THRESHOLD_SOURCES]).default('test'))
    .option('--note <text>', 'e.g. "30 min test"')
    .option('--json', 'the { data, meta } envelope of the set_threshold tool')
    .action(async (date: string, param: string, value: string, opts: { source: string; note?: string; json?: boolean }, cmd: Command) => {
      const n = Number(value);
      if (value.trim() === '' || !Number.isFinite(n)) throw new InputError(`value must be a number, got "${value}"`);
      const res = await withAnalytics(cmd, (a) => a.setThreshold({ date, param, value: n, source: opts.source, note: opts.note }));
      out(opts.json ? JSON.stringify(res, null, 2) : setThresholdText(res));
    });
  thresholds
    .command('export')
    .description('write the threshold history as CSV (date,param,value,source,note)')
    .option('--out <file>', 'file to write (default: standard output)')
    .action(async (opts: { out?: string }, cmd: Command) => {
      const res = await withAnalytics(cmd, (a) => a.getThresholds({ history: true }));
      const rows = res.data.history ?? [];
      const csv = thresholdsCsv(rows);
      if (!opts.out) return void process.stdout.write(csv);
      fs.writeFileSync(path.resolve(opts.out), csv);
      out(`Wrote ${rows.length} threshold rows to ${opts.out}.`);
    });
  thresholds
    .command('import <file>')
    .description('add threshold rows from a CSV written by `thresholds export`; same date, param and source overwrite, identical rows are skipped')
    .action(async (file: string, _opts: unknown, cmd: Command) => {
      const { rows, garminAuto } = parseThresholdsCsv(fs.readFileSync(path.resolve(file), 'utf8'), file, now());
      const res = await withAnalytics(cmd, (a) => a.garmin.store.replaceThresholds(rows));
      out(`Imported ${file}: ${res.added} added, ${res.updated} updated, ${res.skipped} unchanged.`);
      if (garminAuto) out(`${garminAuto} garmin-auto row(s) left out: those come from the Garmin profile.`);
    });

  program
    .command('import-activities <files...>')
    .description('import Garmin Connect "Activities" CSV exports for dates the synced activities do not cover')
    .option('--json', 'machine readable report')
    .action(async (files: string[], opts: { json?: boolean }, cmd: Command) => {
      const input = files.map((f) => ({ name: path.basename(f), text: fs.readFileSync(path.resolve(f), 'utf8') }));
      const report = await withAnalytics(cmd, (a) => importActivities(a.garmin.store, input, now()));
      if (opts.json) return out(JSON.stringify(report, null, 2));
      out(
        `Imported ${report.rows} activities from ${report.files} file(s): ${report.added} added, ${report.updated} already imported (updated), ${report.duplicates} duplicates, ${report.skipped} skipped.`,
      );
      if (report.covered) out(`${report.covered} of them fall on dates covered by synced activities; analytics uses the synced ones there.`);
      for (const w of report.warnings) err(`warning: ${w}`);
    });

  program
    .command('doctor')
    .description('check TLS strategies, hosts, file permissions, tokens and the database driver')
    .action(async (_opts: unknown, cmd: Command) => {
      const config = configFrom(cmd);
      let failed = false;
      const check = (ok: boolean | 'warn', label: string, detail = '') => {
        if (ok === false) failed = true;
        out(`${ok === true ? '✓' : ok === 'warn' ? '!' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
      };
      out(`Data dir ${config.dataDir} | region ${config.region} | SSO strategy ${config.ssoStrategy} | time zone ${config.timezone}\n`);
      const d = await diagnose(config);
      // POSIX mode bits mean nothing on Windows (ACLs), so the report says so instead of printing them.
      const mode = (m: string | undefined) => (process.platform === 'win32' ? 'not applicable on Windows' : `mode ${m}`);
      check(d.dataDir.ok, 'data directory permissions', d.dataDir.exists ? mode(d.dataDir.mode) : 'missing (created on login)');
      check(d.tokensFile.ok, 'tokens file permissions', d.tokensFile.exists ? mode(d.tokensFile.mode) : 'no tokens yet');
      check(d.browser ? true : 'warn', 'browser for sign-in', d.browser ?? 'none found; `garmin login` will ask in the terminal (set GARMIN_BROWSER_PATH)');
      // A missing optional module is a warning, never a failure.
      const noCurl =
        d.ssoStrategy === 'curl'
          ? 'cuimp not installed; `--strategy curl` cannot sign in (install cuimp or use auto/browser/fetch)'
          : 'cuimp not installed; terminal login uses plain fetch (may hit Cloudflare)';
      check(d.curlAvailable ? true : 'warn', 'curl-impersonate (terminal login fallback)', d.curlAvailable ? (d.curlBinary ?? 'binary downloaded on first login') : noCurl);
      try {
        Store.open(':memory:').close();
        check(true, 'SQLite driver (better-sqlite3)');
      } catch (e) {
        check(false, 'SQLite driver (better-sqlite3)', String(e));
      }
      for (const [name, probe] of [
        ['connectapi', ''],
        ['sso', '/mobile/api/login'],
        ['diauth', '/di-oauth2-service/oauth/token'],
      ] as const) {
        const host = config.hosts[name];
        try {
          const res = await fetch(`${host}${probe}`, { method: 'GET', signal: AbortSignal.timeout(8000) });
          const cf = res.status === 429 || res.headers.get('cf-mitigated') !== null || (res.status === 403 && (res.headers.get('content-type') ?? '').includes('html'));
          check(cf ? 'warn' : true, `reach ${name} ${host}`, `HTTP ${res.status}${cf ? ' (Cloudflare blocks or rate-limits plain fetch from this network; login needs the curl strategy)' : ''}`);
        } catch (e) {
          check(false, `reach ${name} ${host}`, e instanceof Error ? e.message : String(e));
        }
      }
      const rt = createRuntime(config);
      // Loose permissions make the token store throw; report it instead of aborting the report.
      let status: Awaited<ReturnType<typeof rt.auth.status>> | Error;
      try {
        status = await rt.auth.status();
      } catch (e) {
        status = e instanceof Error ? e : new Error(String(e));
      }
      if (status instanceof Error) check(false, 'tokens', status.message);
      else if (!status.loggedIn) check('warn', 'tokens', 'not logged in - run `garmin login`');
      else {
        try {
          const p = await rt.client.getProfile();
          check(true, 'tokens accepted by connectapi', `as ${p.displayName ?? '?'}`);
        } catch (e) {
          check(false, 'tokens accepted by connectapi', e instanceof Error ? e.message : String(e));
        }
      }
      out(`\nIf login keeps failing with Cloudflare errors, log in with Python instead:\n  ${pythonFallbackCommand(path.join(config.dataDir, 'garmin_tokens.json'))}`);
      if (failed) process.exitCode = 1;
    });

  program
    .command('serve')
    .description('run the MCP server (same as garmin-mcp-server)')
    .addOption(new Option('--transport <transport>').choices(['stdio', 'streamable-http', 'http']))
    .option('--port <port>')
    .option('--host <host>')
    .action(async (opts: { transport?: string; port?: string; host?: string }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOpts>();
      const config = loadConfig({
        overrides: {
          ...(g.dataDir ? { dataDir: g.dataDir } : {}),
          ...(g.region ? { region: g.region } : {}),
          ...(g.logLevel ? { logLevel: g.logLevel as RawConfig['logLevel'] } : {}),
          ...(opts.transport ? { transport: opts.transport } : {}),
          ...(opts.port ? { port: opts.port } : {}),
          ...(opts.host ? { httpHost: opts.host } : {}),
        },
      });
      await startServer(config);
    });

  program
    .command('record <endpoint>')
    .description(`save an anonymized live response as a test fixture (${Object.keys(RECORDABLE).length} endpoints; "list" shows them)`)
    .option('--date <date>', 'date for daily endpoints (default yesterday)')
    .option('--id <id>', 'activity or workout id')
    .option('--uuid <uuid>', 'gear uuid')
    .option('--out <dir>', 'fixtures directory', 'fixtures')
    .action(async (endpoint: string, opts: { date?: string; id?: string; uuid?: string; out: string }, cmd: Command) => {
      if (endpoint === 'list') return out(Object.keys(RECORDABLE).join('\n'));
      const fn = RECORDABLE[endpoint];
      if (!fn) throw new InputError(`Unknown endpoint "${endpoint}". Run \`garmin record list\`.`);
      const config = configFrom(cmd);
      const rt: Runtime = createRuntime(config);
      const date = opts.date ?? addDays(new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date()), -1);
      const data = await fn(rt.client, { date, id: opts.id ? Number(opts.id) : undefined, uuid: opts.uuid });
      out(`Wrote ${writeFixture(path.resolve(opts.out), endpoint, data)}`);
    });

  return program;
}

/** Print errors with their hint and exit non-zero; stack traces only at debug level. */
export function reportError(e: unknown): void {
  if (e instanceof GarminError) {
    err(`Error: ${e.message}`);
    if (e.hint) err(e.hint);
    if (isAuthError(e) && e.kind === 'cloudflare_blocked') err(`\nPython fallback:\n  ${pythonFallbackCommand()}`);
  } else if (e instanceof Error) {
    err(`Error: ${e.message}`);
    if (process.env.GARMIN_LOG_LEVEL === 'debug') err(e.stack ?? '');
  } else {
    err(`Error: ${String(e)}`);
  }
  process.exitCode = 1;
}
