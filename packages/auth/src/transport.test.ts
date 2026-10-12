import { describe, expect, it, vi } from 'vitest';
import { CookieJar } from './cookie-jar.js';
import { CurlTransport, curlAvailable } from './curl-transport.js';
import { FetchTransport } from './fetch-transport.js';
import { isCloudflareResponse, makeResponse, Pacer } from './transport.js';

describe('cookie jar', () => {
  it('scopes cookies by domain and honours expiry', () => {
    let t = 1_000;
    const jar = new CookieJar(() => t);
    jar.store('https://sso.garmin.com/mobile/api/login', [
      'SESSION=abc; Path=/; HttpOnly; Secure',
      '__cf_bm=xyz; Domain=.garmin.com; Max-Age=10',
      'evil=1; Domain=example.com',
    ]);
    expect(jar.header('https://sso.garmin.com/mobile/api/mfa/verifyCode')).toBe('SESSION=abc; __cf_bm=xyz');
    expect(jar.header('https://diauth.garmin.com/x')).toBe('__cf_bm=xyz');
    t += 20_000;
    expect(jar.header('https://diauth.garmin.com/x')).toBeUndefined();
  });
});

describe('pacer', () => {
  it('keeps at least the minimum interval between requests', async () => {
    let t = 0;
    const sleep = vi.fn<(ms: number) => Promise<void>>(async (ms: number) => {
      t += ms;
    });
    const pacer = new Pacer({ now: () => t, sleep });
    await pacer.wait();
    t += 1_000;
    await pacer.wait();
    expect(sleep).toHaveBeenCalledWith(2_000);
  });
});

describe('FetchTransport', () => {
  it('carries cookies across requests of one session and encodes bodies', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      seen.push({ url: String(url), init: init ?? {} });
      return new Response('{"ok":true}', {
        status: 200,
        headers: [
          ['content-type', 'application/json'],
          ['set-cookie', 'SESSION=s1; Path=/'],
        ],
      });
    });
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);
    const session = new FetchTransport({ fetch, sleep, minIntervalMs: 3000 }).createSession();
    const res = await session.post('https://sso.garmin.com/mobile/api/login', { params: { a: 'b c' }, json: { x: 1 } });
    expect(res.json()).toEqual({ ok: true });
    await session.post('https://sso.garmin.com/mobile/api/mfa/verifyCode', { form: { k: 'v' } });
    expect(seen[0]?.url).toBe('https://sso.garmin.com/mobile/api/login?a=b+c');
    expect(seen[0]?.init.body).toBe('{"x":1}');
    const headers = (i: number) => (seen[i]?.init.headers ?? {}) as Record<string, string>;
    expect(headers(0)['Content-Type']).toBe('application/json');
    expect(headers(1).Cookie).toBe('SESSION=s1');
    expect(seen[1]?.init.body).toBe('k=v');
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('separate sessions do not share cookies', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{}', { headers: [['set-cookie', 'S=1']] }));
    const t = new FetchTransport({ fetch, minIntervalMs: 0 });
    await t.createSession().get('https://sso.garmin.com/a');
    await t.createSession().get('https://sso.garmin.com/a');
    const second = (fetch.mock.calls[1]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(second.Cookie).toBeUndefined();
  });
});

describe('Cloudflare classification', () => {
  it.each([
    [429, 'application/json', '{}', true],
    [403, 'application/json', '{}', true],
    [200, 'text/html; charset=utf-8', '<html>', true],
    [200, 'application/json', '  <!DOCTYPE html>', true],
    [200, 'application/json', '{"responseStatus":{}}', false],
    [401, 'application/json', '{}', false],
  ])('%i %s', (status, type, body, expected) => {
    expect(isCloudflareResponse(makeResponse(status, { 'Content-Type': type }, body))).toBe(expected);
  });
});

const loadModule = () => Promise.reject(new Error('Cannot find module cuimp'));

describe('CurlTransport', () => {
  it('is unavailable when cuimp cannot be loaded', async () => {
    await expect(new CurlTransport({ loadModule }).isAvailable()).resolves.toBe(false);
    await expect(curlAvailable(loadModule)).resolves.toBe(false);
  });

  it('rotates safari_ios, safari, chrome by default', () => {
    expect(new CurlTransport().profiles).toEqual(['safari_ios', 'safari', 'chrome']);
  });
});
