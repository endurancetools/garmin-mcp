import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ConfigError } from './errors.js';
import { hostsForRegion, type Hosts, type Region } from './hosts.js';
import { LOG_LEVELS, type LogLevel } from './logger.js';
import { expandPath } from './paths.js';

export const SSO_STRATEGIES = ['auto', 'browser', 'curl', 'fetch', 'import'] as const;
export type SsoStrategy = (typeof SSO_STRATEGIES)[number];

export const TRANSPORTS = ['stdio', 'streamable-http'] as const;
export type Transport = (typeof TRANSPORTS)[number];

/** Native Garmin Connect Mobile headers. Garmin raises the minimum app version now and then. */
export interface AppIdentity {
  userAgent: string;
  xGarminUserAgent: string;
  pairedAppVersion: string;
  clientPlatform: string;
  appVersion: string;
  lang: string;
  gcExperience: string;
}

export const DEFAULT_APP_IDENTITY: AppIdentity = {
  userAgent: 'GCM-Android-5.23',
  xGarminUserAgent:
    'com.garmin.android.apps.connectmobile/5.23; ; Google/sdk_gphone64_arm64/google; Android/33; Dalvik/2.1.0',
  pairedAppVersion: '10861',
  clientPlatform: 'Android',
  appVersion: '10861',
  lang: 'en',
  gcExperience: 'GC5',
};

/** DI OAuth2 client ids, tried in order during ticket exchange. */
export const DEFAULT_DI_CLIENT_IDS = [
  'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2',
  'GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4',
  'GARMIN_CONNECT_MOBILE_ANDROID_DI',
  'GARMIN_CONNECT_MOBILE_IOS_DI',
];

export interface GarminConfig {
  dataDir: string;
  tokensFile: string;
  configFile: string;
  region: Region;
  hosts: Hosts;
  ssoStrategy: SsoStrategy;
  /** Browser for the sign-in window; detected when unset. */
  browserPath: string | undefined;
  email: string | undefined;
  password: string | undefined;
  enabledTools: string[] | undefined;
  disabledTools: string[] | undefined;
  enableDestructive: boolean;
  fitDownloadDir: string | undefined;
  transport: Transport;
  port: number;
  httpHost: string;
  httpToken: string | undefined;
  /**
   * Hostnames (no port; IPv6 in brackets) accepted in the HTTP `Host` and `Origin` headers on
   * top of localhost, 127.0.0.1 and [::1] (DNS rebinding protection).
   */
  httpAllowedHosts: string[];
  logLevel: LogLevel;
  /** Parallel requests to connectapi. */
  concurrency: number;
  /** Minimum spacing between request starts to connectapi, in ms (jittered ±25 %). */
  minRequestIntervalMs: number;
  /**
   * Let read tools download data that was never synced, through the regular sync job
   * (chunks, pauses, daily cap). On by default; false makes Garmin contacted only when
   * the user asks for a sync.
   */
  autoFetch: boolean;
  /**
   * Strip personal data (name, profile and photo URLs, device and sensor serials) and GPS
   * positions from raw activity output. On by default; false returns Garmin's JSON as sent.
   */
  redact: boolean;
  /** Days per chunk of a sync job. */
  syncChunkDays: number;
  /** Pause after a chunk that made requests, drawn at random from the range. */
  syncPause: PauseRange;
  /** Cap on sync requests per local day. */
  syncMaxRequestsPerDay: number;
  /** IANA zone used for "today" and day boundaries; defaults to the system zone. */
  timezone: string;
  diClientIds: string[];
  app: AppIdentity;
}

/** Loose input shape shared by config.json, env and CLI overrides. */
const rawSchema = z
  .object({
    dataDir: z.string(),
    tokensFile: z.string(),
    region: z.enum(['global', 'cn']),
    ssoStrategy: z.enum(SSO_STRATEGIES),
    browserPath: z.string(),
    email: z.string(),
    password: z.string(),
    enabledTools: z.union([z.array(z.string()), z.string()]),
    disabledTools: z.union([z.array(z.string()), z.string()]),
    enableDestructive: z.union([z.boolean(), z.string()]),
    fitDownloadDir: z.string(),
    transport: z.string(),
    port: z.union([z.number(), z.string()]),
    httpHost: z.string(),
    httpToken: z.string(),
    httpAllowedHosts: z.union([z.array(z.string()), z.string()]),
    logLevel: z.enum(LOG_LEVELS),
    concurrency: z.union([z.number(), z.string()]),
    minRequestIntervalMs: z.union([z.number(), z.string()]),
    autoFetch: z.union([z.boolean(), z.string()]),
    redact: z.union([z.boolean(), z.string()]),
    syncChunkDays: z.union([z.number(), z.string()]),
    syncPauseSeconds: z.union([z.number(), z.string()]),
    syncMaxRequestsPerDay: z.union([z.number(), z.string()]),
    timezone: z.string(),
    diClientIds: z.union([z.array(z.string()), z.string()]),
    app: z
      .object({
        userAgent: z.string(),
        xGarminUserAgent: z.string(),
        pairedAppVersion: z.string(),
        clientPlatform: z.string(),
        appVersion: z.string(),
        lang: z.string(),
        gcExperience: z.string(),
      })
      .partial(),
  })
  .partial();

export type RawConfig = z.input<typeof rawSchema>;

const ENV_MAP: Record<string, keyof RawConfig> = {
  GARMIN_DATA_DIR: 'dataDir',
  GARMIN_TOKENS_FILE: 'tokensFile',
  GARMIN_REGION: 'region',
  GARMIN_SSO_STRATEGY: 'ssoStrategy',
  GARMIN_BROWSER_PATH: 'browserPath',
  GARMIN_EMAIL: 'email',
  GARMIN_PASSWORD: 'password',
  GARMIN_ENABLED_TOOLS: 'enabledTools',
  GARMIN_DISABLED_TOOLS: 'disabledTools',
  GARMIN_ENABLE_DESTRUCTIVE: 'enableDestructive',
  GARMIN_FIT_DOWNLOAD_DIR: 'fitDownloadDir',
  GARMIN_MCP_TRANSPORT: 'transport',
  GARMIN_MCP_PORT: 'port',
  GARMIN_MCP_HOST: 'httpHost',
  GARMIN_MCP_HTTP_TOKEN: 'httpToken',
  GARMIN_HTTP_ALLOWED_HOSTS: 'httpAllowedHosts',
  GARMIN_LOG_LEVEL: 'logLevel',
  GARMIN_CONCURRENCY: 'concurrency',
  GARMIN_MIN_REQUEST_INTERVAL_MS: 'minRequestIntervalMs',
  GARMIN_AUTO_FETCH: 'autoFetch',
  GARMIN_REDACT: 'redact',
  GARMIN_SYNC_CHUNK_DAYS: 'syncChunkDays',
  GARMIN_SYNC_PAUSE_S: 'syncPauseSeconds',
  GARMIN_SYNC_MAX_REQUESTS_PER_DAY: 'syncMaxRequestsPerDay',
  GARMIN_TIMEZONE: 'timezone',
  GARMIN_DI_CLIENT_IDS: 'diClientIds',
};

export function configFromEnv(env: NodeJS.ProcessEnv): RawConfig {
  const out: Record<string, unknown> = {};
  for (const [name, key] of Object.entries(ENV_MAP)) {
    const value = env[name];
    if (value !== undefined && value !== '') out[key] = value;
  }
  const app: Record<string, string> = {};
  if (env.GARMIN_APP_VERSION) {
    app.appVersion = env.GARMIN_APP_VERSION;
    app.pairedAppVersion = env.GARMIN_APP_VERSION;
  }
  if (env.GARMIN_APP_USER_AGENT) app.userAgent = env.GARMIN_APP_USER_AGENT;
  if (Object.keys(app).length > 0) out.app = app;
  return parseRaw(out, 'environment');
}

function parseRaw(input: unknown, source: string): RawConfig {
  const parsed = rawSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid configuration in ${source}: ${issues}`);
  }
  return parsed.data;
}

function readConfigFile(file: string): RawConfig {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ConfigError(`${file} is not valid JSON`, `Fix or delete ${file}`);
  }
  return parseRaw(json, file);
}

const list = (v: string | string[] | undefined): string[] | undefined => {
  if (v === undefined) return undefined;
  const items = (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean);
  return items.length ? items : undefined;
};

const bool = (v: boolean | string | undefined): boolean =>
  typeof v === 'boolean' ? v : v !== undefined && ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());

const int = (v: number | string | undefined, fallback: number, name: string, min = 1): number => {
  if (v === undefined) return fallback;
  const n = typeof v === 'number' ? v : Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n < min) throw new ConfigError(`${name} must be an integer >= ${min}, got ${String(v)}`);
  return n;
};

/** Pause between sync chunks, in ms; each pause is drawn uniformly from [minMs, maxMs]. */
export interface PauseRange {
  minMs: number;
  maxMs: number;
}

export const DEFAULT_SYNC_PAUSE_SECONDS = '1-11';

/** Seconds as a range drawn at random (`"1-11"`) or a fixed value (`"5"`); `0` turns the pause off. */
export function parsePauseSeconds(v: number | string, name = 'pause'): PauseRange {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:-\s*(\d+(?:\.\d+)?)\s*)?$/.exec(String(v));
  const min = Number(m?.[1]);
  const max = m?.[2] === undefined ? min : Number(m[2]);
  if (!m || max < min) throw new ConfigError(`${name} must be seconds like "1-11" or "5", got ${String(v)}`);
  return { minMs: min * 1000, maxMs: max * 1000 };
}

function normalizeTransport(v: string | undefined): Transport {
  if (v === undefined || v === 'stdio') return 'stdio';
  if (v === 'http' || v === 'streamable-http' || v === 'streamable_http') return 'streamable-http';
  throw new ConfigError(`Unknown transport "${v}"`, 'Use "stdio" or "streamable-http"');
}

function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export interface LoadConfigOptions {
  /** Highest precedence, typically parsed CLI flags. */
  overrides?: RawConfig;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve configuration with precedence CLI overrides > env > config.json > defaults.
 * The data dir itself is resolved first, since config.json lives in it.
 */
export function loadConfig(options: LoadConfigOptions = {}): GarminConfig {
  const env = options.env ?? process.env;
  const overrides = parseRaw(options.overrides ?? {}, 'command line');
  const fromEnv = configFromEnv(env);
  const dataDir = expandPath(overrides.dataDir ?? fromEnv.dataDir ?? '~/.garmin-mcp', env);
  const configFile = path.join(dataDir, 'config.json');
  const fromFile = readConfigFile(configFile);
  const merged: RawConfig = {
    ...fromFile,
    ...fromEnv,
    ...overrides,
    app: { ...fromFile.app, ...fromEnv.app, ...overrides.app },
  };

  const region = merged.region ?? 'global';
  const timezone = merged.timezone ?? systemTimezone();
  try {
    Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
  } catch {
    throw new ConfigError(`Unknown time zone "${timezone}"`, 'Use an IANA name such as "Europe/Warsaw"');
  }

  return {
    dataDir,
    configFile,
    tokensFile: expandPath(merged.tokensFile ?? path.join(dataDir, 'tokens.json'), env),
    region,
    hosts: hostsForRegion(region),
    ssoStrategy: merged.ssoStrategy ?? 'auto',
    browserPath: merged.browserPath === undefined ? undefined : expandPath(merged.browserPath, env),
    email: merged.email,
    password: merged.password,
    enabledTools: list(merged.enabledTools),
    disabledTools: list(merged.disabledTools),
    enableDestructive: bool(merged.enableDestructive),
    fitDownloadDir: merged.fitDownloadDir === undefined ? undefined : expandPath(merged.fitDownloadDir, env),
    transport: normalizeTransport(merged.transport),
    port: int(merged.port, 8000, 'port'),
    httpHost: merged.httpHost ?? '127.0.0.1',
    httpToken: merged.httpToken,
    httpAllowedHosts: (list(merged.httpAllowedHosts) ?? []).map((h) => h.toLowerCase()),
    logLevel: merged.logLevel ?? 'info',
    concurrency: int(merged.concurrency, 4, 'concurrency'),
    minRequestIntervalMs: int(merged.minRequestIntervalMs, 250, 'minRequestIntervalMs', 0),
    autoFetch: merged.autoFetch === undefined ? true : bool(merged.autoFetch),
    redact: merged.redact === undefined ? true : bool(merged.redact),
    syncChunkDays: int(merged.syncChunkDays, 7, 'syncChunkDays'),
    syncPause: parsePauseSeconds(merged.syncPauseSeconds ?? DEFAULT_SYNC_PAUSE_SECONDS, 'syncPauseSeconds'),
    syncMaxRequestsPerDay: int(merged.syncMaxRequestsPerDay, 600, 'syncMaxRequestsPerDay'),
    timezone,
    diClientIds: list(merged.diClientIds) ?? [...DEFAULT_DI_CLIENT_IDS],
    app: { ...DEFAULT_APP_IDENTITY, ...stripUndefined(merged.app ?? {}) },
  };
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Headers the Garmin Connect Mobile app sends to diauth and connectapi. */
export function nativeAppHeaders(app: AppIdentity): Record<string, string> {
  return {
    'User-Agent': app.userAgent,
    'X-Garmin-User-Agent': app.xGarminUserAgent,
    'X-Garmin-Paired-App-Version': app.pairedAppVersion,
    'X-Garmin-Client-Platform': app.clientPlatform,
    'X-App-Ver': app.appVersion,
    'X-Lang': app.lang,
    'X-GCExperience': app.gcExperience,
    'Accept-Language': 'en-US,en;q=0.9',
  };
}
