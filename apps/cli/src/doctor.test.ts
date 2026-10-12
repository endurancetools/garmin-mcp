import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type * as Auth from 'garmin-mcp-auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProgram } from './commands.js';

// Toggle for the optional `cuimp` module; the real diagnosis runs, only this field is forced.
const cuimp = vi.hoisted(() => ({ installed: true }));
vi.mock('garmin-mcp-auth', async (importOriginal) => {
  const mod = await importOriginal<typeof Auth>();
  return {
    ...mod,
    diagnose: async (...args: Parameters<typeof mod.diagnose>) => {
      const d = await mod.diagnose(...args);
      if (cuimp.installed) return d;
      const { curlBinary: _, ...rest } = d;
      return { ...rest, curlAvailable: false };
    },
  };
});

describe('garmin doctor (offline)', () => {
  let dir: string;
  let lines: string[];
  const fetched: string[] = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'garmin-doctor-'));
    fs.chmodSync(dir, 0o700);
    for (const k of Object.keys(process.env)) if (k.startsWith('GARMIN_')) vi.stubEnv(k, undefined);
    lines = [];
    fetched.length = 0;
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => (lines.push(String(s)), true));
    // No request leaves the process: Garmin hosts answer from this stub.
    vi.stubGlobal('fetch', async (url: string) => (fetched.push(url), new Response('{}', { status: 200 })));
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
    cuimp.installed = true;
    process.exitCode = undefined;
  });

  const doctor = async (...extra: string[]) => {
    await buildProgram().parseAsync(['node', 'garmin', '--data-dir', dir, ...extra, 'doctor']);
    return lines.join('');
  };

  it('shows strategy, hosts and permissions', async () => {
    const report = await doctor('--region', 'cn');
    expect(report).toContain('SSO strategy auto');
    expect(report).toMatch(process.platform === 'win32' ? /✓ data directory permissions {2}not applicable on Windows/ : /✓ data directory permissions {2}mode 700/);
    expect(report).toContain('reach sso https://sso.garmin.cn');
    expect(report).toContain('reach diauth https://diauth.garmin.cn');
    expect(fetched.every((u) => u.startsWith('https://') && u.includes('.garmin.cn'))).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it('warns, without failing, when cuimp is missing', async () => {
    cuimp.installed = false;
    const report = await doctor();
    expect(report).toMatch(/^! curl-impersonate .*cuimp not installed; terminal login uses plain fetch/m);
    expect(report).not.toMatch(/^✗/m);
    expect(process.exitCode).toBeUndefined();
  });

  it('names the broken strategy when curl is chosen without cuimp', async () => {
    cuimp.installed = false;
    vi.stubEnv('GARMIN_SSO_STRATEGY', 'curl');
    expect(await doctor()).toMatch(/^! curl-impersonate .*`--strategy curl` cannot sign in/m);
    expect(process.exitCode).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('finishes the report and fails on loose permissions', async () => {
    fs.chmodSync(dir, 0o755);
    fs.writeFileSync(path.join(dir, 'tokens.json'), '{}', { mode: 0o644 });
    const report = await doctor();
    expect(report).toMatch(/^✗ data directory permissions {2}mode 755/m);
    expect(report).toMatch(/^✗ tokens file permissions {2}mode 644/m);
    expect(report).toMatch(/^✗ tokens {2}.*expected 700/m);
    expect(report).toContain('log in with Python instead');
    expect(process.exitCode).toBe(1);
  });
});
