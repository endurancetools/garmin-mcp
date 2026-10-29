import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, parsePauseSeconds } from './config.js';
import { ConfigError } from './errors.js';
import { expandPath } from './paths.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'garmin-config-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('expandPath', () => {
  const env = { HOME: '/home/u', FOO: 'bar' };
  it.each([
    ['~', '/home/u'],
    ['~/x', '/home/u/x'],
    ['${HOME}/x', '/home/u/x'],
    ['$HOME/x', '/home/u/x'],
    ['/a/${FOO}', '/a/bar'],
  // expandPath returns a native absolute path, so on Windows the expectation resolves to e.g. D:\home\u.
  ])('%s -> %s', (input, expected) => expect(expandPath(input, env)).toBe(path.resolve(expected)));
});

describe('loadConfig', () => {
  it('uses defaults', () => {
    const cfg = loadConfig({ env: { HOME: tmp } });
    expect(cfg.dataDir).toBe(path.join(tmp, '.garmin-mcp'));
    expect(cfg.tokensFile).toBe(path.join(tmp, '.garmin-mcp', 'tokens.json'));
    expect(cfg.hosts.connectapi).toBe('https://connectapi.garmin.com');
    expect(cfg.transport).toBe('stdio');
    expect(cfg.port).toBe(8000);
    expect(cfg.concurrency).toBe(4);
    expect(cfg).toMatchObject({ minRequestIntervalMs: 250, autoFetch: true, syncChunkDays: 7, syncPause: { minMs: 1000, maxMs: 11_000 }, syncMaxRequestsPerDay: 600 });
    expect(cfg.enableDestructive).toBe(false);
    expect(cfg.diClientIds[0]).toBe('GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2');
  });

  it('applies precedence overrides > env > config.json > defaults', () => {
    fs.writeFileSync(
      path.join(tmp, 'config.json'),
      JSON.stringify({ region: 'cn', port: 9000, logLevel: 'debug', enabledTools: ['a', 'b'] }),
    );
    const cfg = loadConfig({
      env: { GARMIN_DATA_DIR: tmp, GARMIN_MCP_PORT: '9100', GARMIN_LOG_LEVEL: 'warn' },
      overrides: { logLevel: 'error' },
    });
    expect(cfg.region).toBe('cn');
    expect(cfg.hosts.sso).toBe('https://sso.garmin.cn');
    expect(cfg.hosts.diauth).toBe('https://diauth.garmin.cn');
    expect(cfg.port).toBe(9100);
    expect(cfg.logLevel).toBe('error');
    expect(cfg.enabledTools).toEqual(['a', 'b']);
  });

  it('parses list and boolean env values', () => {
    const cfg = loadConfig({
      env: {
        HOME: tmp,
        GARMIN_DISABLED_TOOLS: 'x, y ,',
        GARMIN_ENABLE_DESTRUCTIVE: 'true',
        GARMIN_MCP_TRANSPORT: 'http',
        GARMIN_HTTP_ALLOWED_HOSTS: 'mcp.example.com, Garmin.LAN ,',
      },
    });
    expect(cfg.disabledTools).toEqual(['x', 'y']);
    expect(cfg.httpAllowedHosts).toEqual(['mcp.example.com', 'garmin.lan']);
    expect(cfg.enableDestructive).toBe(true);
    expect(cfg.transport).toBe('streamable-http');
  });

  it('reads sync pacing and auto fetch from env', () => {
    expect(loadConfig({ env: { HOME: tmp, GARMIN_AUTO_FETCH: 'true', GARMIN_SYNC_PAUSE_S: '0' } })).toMatchObject({
      autoFetch: true,
      syncPause: { minMs: 0, maxMs: 0 },
    });
    // The Claude Desktop manifest passes the boolean user_config as the string "false".
    expect(loadConfig({ env: { HOME: tmp, GARMIN_AUTO_FETCH: 'false' } }).autoFetch).toBe(false);
    expect(loadConfig({ env: { HOME: tmp } }).redact).toBe(true);
    expect(loadConfig({ env: { HOME: tmp, GARMIN_REDACT: 'false' } }).redact).toBe(false);
    expect(loadConfig({ env: { HOME: tmp, GARMIN_SYNC_PAUSE_S: '30-90' } }).syncPause).toEqual({ minMs: 30_000, maxMs: 90_000 });
    expect(parsePauseSeconds(' 2.5 ')).toEqual({ minMs: 2500, maxMs: 2500 });
    for (const bad of ['11-1', '-3', 'abc', '1-']) expect(() => parsePauseSeconds(bad)).toThrow(ConfigError);
  });

  it('rejects invalid values with a ConfigError', () => {
    expect(() => loadConfig({ env: { HOME: tmp, GARMIN_REGION: 'eu' } })).toThrow(ConfigError);
    expect(() => loadConfig({ env: { HOME: tmp, GARMIN_MCP_PORT: 'abc' } })).toThrow(ConfigError);
    expect(() => loadConfig({ env: { HOME: tmp, GARMIN_TIMEZONE: 'Mars/Base' } })).toThrow(ConfigError);
  });

  it('resolves a literal ${HOME} in the data dir', () => {
    const cfg = loadConfig({ env: { HOME: tmp, GARMIN_DATA_DIR: '${HOME}/data' } });
    expect(cfg.dataDir).toBe(path.join(tmp, 'data'));
  });
});
