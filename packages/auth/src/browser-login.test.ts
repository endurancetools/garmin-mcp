import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostsForRegion } from 'garmin-mcp-config';
import type { Logger } from 'garmin-mcp-config';
import { describe, expect, it, vi } from 'vitest';
import {
  BrowserLoginAbortedError,
  browserSignIn,
  captureTicket,
  findBrowser,
  launchBrowser,
  portalSignInUrl,
  ticketFromUrl,
  type CdpConnection,
} from './browser-login.js';

const hosts = hostsForRegion('global');

/** Scripted CDP peer: records commands, lets the test emit events. */
function fakeCdp() {
  const sent: { method: string; params: Record<string, unknown>; sessionId?: string }[] = [];
  const listeners: ((e: { method: string; params: Record<string, unknown>; sessionId?: string }) => void)[] = [];
  const closers: (() => void)[] = [];
  const cdp: CdpConnection = {
    send: async (method, params = {}, sessionId) => {
      sent.push({ method, params, ...(sessionId ? { sessionId } : {}) });
      if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'T1', type: 'page' }] };
      if (method === 'Target.attachToTarget') return { sessionId: 'S1' };
      return {};
    },
    onEvent: (l) => listeners.push(l),
    onClose: (l) => closers.push(l),
    close: () => closers.forEach((c) => c()),
  };
  const emit = (method: string, params: Record<string, unknown>, sessionId = 'S1') => listeners.forEach((l) => l({ method, params, sessionId }));
  return { cdp, sent, emit, close: () => closers.forEach((c) => c()) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * Fake browser executable. Every launch appends its arguments to `args.log`.
 * `pipe`: answers CDP on fd 3/4 like Chrome with `--remote-debugging-pipe` and
 * turns `Page.navigate` into a paused request for the same URL.
 * `no-pipe`: never reads the pipe; with `--remote-debugging-port=0` it writes
 * `DevToolsActivePort` like Chrome does.
 */
function fakeBrowser(mode: 'pipe' | 'no-pipe') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'garmin-fake-browser-'));
  const log = path.join(dir, 'args.log');
  const script = path.join(dir, 'browser.mjs');
  fs.writeFileSync(
    script,
    `import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const profile = args.find((a) => a.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
if (${JSON.stringify(mode)} === 'pipe' && args.includes('--remote-debugging-pipe')) {
  const input = new net.Socket({ fd: 3, readable: true, writable: false });
  const output = new net.Socket({ fd: 4, readable: false, writable: true });
  const send = (m) => output.write(JSON.stringify(m) + '\\0');
  let buf = '';
  input.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nul;
    while ((nul = buf.indexOf('\\0')) !== -1) {
      const m = JSON.parse(buf.slice(0, nul));
      buf = buf.slice(nul + 1);
      const reply = (result = {}) => send({ id: m.id, result, ...(m.sessionId ? { sessionId: m.sessionId } : {}) });
      if (m.method === 'Browser.getVersion') reply({ product: 'FakeChrome/1' });
      else if (m.method === 'Target.getTargets') reply({ targetInfos: [{ targetId: 'T1', type: 'page' }] });
      else if (m.method === 'Target.attachToTarget') reply({ sessionId: 'S1' });
      else if (m.method === 'Page.navigate') {
        reply({});
        send({ method: 'Fetch.requestPaused', sessionId: 'S1', params: { requestId: 'r1', request: { url: m.params.url } } });
      } else if (m.method === 'Browser.close') {
        reply({});
        setTimeout(() => process.exit(0), 10);
      } else reply({});
    }
  });
  input.on('end', () => process.exit(0));
} else {
  if (args.includes('--remote-debugging-port=0') && profile) {
    fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), '45678\\n/devtools/browser/fake\\n');
  }
  setInterval(() => undefined, 1000);
}
`,
  );
  const exe = path.join(dir, 'browser');
  fs.writeFileSync(exe, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, { mode: 0o755 });
  const launches = () =>
    fs
      .readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as string[]);
  return { exe, launches };
}

function recordingLogger() {
  const warn = vi.fn<(obj: unknown, msg?: string) => void>();
  const noop = () => undefined;
  const logger = { warn, debug: noop, info: noop, error: noop } as unknown as Logger;
  return { logger, warn };
}

describe('browser sign-in', () => {
  it('builds the portal sign-in URL for the region', () => {
    expect(portalSignInUrl({ hosts })).toBe(
      'https://sso.garmin.com/portal/sso/en-US/sign-in?clientId=GarminConnect&service=https%3A%2F%2Fconnect.garmin.com%2Fapp',
    );
    expect(portalSignInUrl({ hosts: hostsForRegion('cn') })).toContain('sso.garmin.cn');
  });

  it('extracts service tickets', () => {
    expect(ticketFromUrl('https://connect.garmin.com/app?ticket=ST-123-abc-sso')).toBe('ST-123-abc-sso');
    expect(ticketFromUrl('https://connect.garmin.com/app/?x=1&ticket=ST-9#f')).toBe('ST-9');
    expect(ticketFromUrl('https://connect.garmin.com/app')).toBeUndefined();
  });

  it('intercepts the redirect, keeps the ticket away from Garmin and answers locally', async () => {
    const { cdp, sent, emit } = fakeCdp();
    const ticket = captureTicket(cdp, 'https://sso.example/sign-in', hosts.portalServiceUrl, 10_000);
    await tick();
    expect(sent.find((c) => c.method === 'Fetch.enable')).toMatchObject({
      params: { patterns: [{ urlPattern: 'https://connect.garmin.com/app*', requestStage: 'Request' }] },
      sessionId: 'S1',
    });
    expect(sent.find((c) => c.method === 'Page.navigate')?.params).toEqual({ url: 'https://sso.example/sign-in' });
    emit('Fetch.requestPaused', { requestId: 'r1', request: { url: 'https://connect.garmin.com/app/static.js' } });
    emit('Fetch.requestPaused', { requestId: 'r2', request: { url: 'https://connect.garmin.com/app?ticket=ST-777' } });
    await expect(ticket).resolves.toBe('ST-777');
    expect(sent.find((c) => c.method === 'Fetch.continueRequest')?.params).toEqual({ requestId: 'r1' });
    const fulfilled = sent.find((c) => c.method === 'Fetch.fulfillRequest');
    expect(fulfilled?.params).toMatchObject({ requestId: 'r2', responseCode: 200 });
    expect(Buffer.from(String(fulfilled?.params.body), 'base64').toString()).toContain('Signed in');
    expect(sent.some((c) => c.method === 'Fetch.continueRequest' && c.params.requestId === 'r2')).toBe(false);
  });

  it('fails clearly when the window is closed or time runs out', async () => {
    const a = fakeCdp();
    const closed = captureTicket(a.cdp, 'https://x', hosts.portalServiceUrl, 10_000);
    await tick();
    a.emit('Target.targetDestroyed', { targetId: 'T1' }, undefined);
    await expect(closed).rejects.toThrow(BrowserLoginAbortedError);
    const b = fakeCdp();
    await expect(captureTicket(b.cdp, 'https://x', hosts.portalServiceUrl, 20)).rejects.toThrow(/no sign-in/);
  });

  it('uses a configured browser path only when it exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'garmin-browser-'));
    const exe = path.join(dir, 'chrome');
    fs.writeFileSync(exe, '');
    expect(findBrowser(exe)).toBe(exe);
    expect(findBrowser(path.join(dir, 'missing'))).toBeUndefined();
  });

  it('reports a missing browser with a hint', async () => {
    await expect(browserSignIn({ hosts, browserPath: '/nonexistent/chrome' })).rejects.toMatchObject({ code: 'AUTH_BROWSER_UNAVAILABLE' });
  });

  it.skipIf(process.platform === 'win32')('talks CDP over --remote-debugging-pipe, without a DevTools port', async () => {
    const fake = fakeBrowser('pipe');
    const { logger, warn } = recordingLogger();
    const browser = await launchBrowser(fake.exe, { headless: true, logger, startTimeoutMs: 5_000 });
    expect(browser.transport).toBe('pipe');
    await browser.close();
    expect(warn).not.toHaveBeenCalled();
    const [args] = fake.launches();
    expect(args).toContain('--remote-debugging-pipe');
    expect(args).toContain('--disable-blink-features=AutomationControlled');
    expect(args?.some((a) => a.startsWith('--remote-debugging-port'))).toBe(false);
    expect(fake.launches()).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')('captures the ticket end to end over the pipe', async () => {
    const fake = fakeBrowser('pipe');
    const ticket = await browserSignIn(
      { hosts, browserPath: fake.exe },
      { headless: true, signInUrl: `${hosts.portalServiceUrl}?ticket=ST-over-pipe`, timeoutMs: 5_000 },
    );
    expect(ticket).toBe('ST-over-pipe');
  });

  it.skipIf(process.platform === 'win32')('falls back to a DevTools port with a warning only when the pipe gets no answer', async () => {
    const fake = fakeBrowser('no-pipe');
    const { logger, warn } = recordingLogger();
    const browser = await launchBrowser(fake.exe, { headless: true, logger, startTimeoutMs: 1_000 });
    expect(browser.transport).toBe('port');
    await browser.close();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatch(/remote-debugging-pipe.*127\.0\.0\.1/);
    const [first, second] = fake.launches();
    expect(first).toContain('--remote-debugging-pipe');
    expect(second).toContain('--remote-debugging-port=0');
    expect(second).not.toContain('--remote-debugging-pipe');
  });

  const chrome = findBrowser();
  it.skipIf(!chrome || process.env.CI !== undefined)('captures a ticket from a real headless browser over the pipe without contacting Garmin', async () => {
    // A local page redirects to the service URL; the request is fulfilled locally before any network access.
    const page = `data:text/html,<script>location.href='${hosts.portalServiceUrl}?ticket=ST-local-test'</script>`;
    const { logger, warn } = recordingLogger();
    const ticket = await browserSignIn({ hosts, browserPath: undefined }, { headless: true, signInUrl: page, timeoutMs: 20_000, logger });
    expect(ticket).toBe('ST-local-test');
    expect(warn).not.toHaveBeenCalled(); // the installed browser speaks CDP over the pipe, no port fallback
  }, 30_000);
});
