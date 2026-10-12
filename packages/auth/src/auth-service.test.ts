import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createAuthService } from './auth-service.js';
import { AuthExpiredError, CloudflareBlockedError, InvalidCredentialsError, MfaRequiredError, NotLoggedInError } from './errors.js';
import { readTokens, writeTokens } from './token-store.js';
import {
  FakeTransport,
  html,
  isDiauth,
  isLogin,
  isMfa,
  json,
  modeOf,
  tempConfig,
  tokenExpiringIn,
  verifyFetch,
  type Handler,
} from './test-utils/index.js';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const now = () => NOW;
const creds = { email: 'runner@example.com', password: 'hunter2' };
const ACCESS = tokenExpiringIn(14_400, NOW);

const happy: Handler = (call) => {
  if (isLogin(call)) return json(200, { responseStatus: { type: 'SUCCESSFUL' }, serviceTicketId: 'ST-1' });
  if (isDiauth(call)) return json(200, { access_token: ACCESS, refresh_token: 'refresh-1' });
  return json(404, {});
};

const blocked = (res: () => ReturnType<Handler>): Handler => (call) => (isLogin(call) ? res() : happy(call));

describe('login', () => {
  it('logs in, verifies the token and persists it in garminconnect format', async () => {
    const config = tempConfig();
    const fetch = verifyFetch(200);
    const auth = createAuthService(config, { transports: [new FakeTransport('fetch', happy)], fetch, now });
    const result = await auth.login(creds);
    expect(result).toEqual({
      strategy: 'fetch',
      clientId: 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2',
      expiresAt: new Date(NOW + 14_400_000),
    });
    expect(fetch.calls).toEqual(['https://connectapi.garmin.com/userprofile-service/socialProfile']);
    const stored = JSON.parse(fs.readFileSync(config.tokensFile, 'utf8'));
    expect(stored).toMatchObject({
      di_token: ACCESS,
      di_refresh_token: 'refresh-1',
      di_client_id: 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2',
      service_url: 'https://mobile.integration.garmin.com/gcm/ios',
      schema_version: 1,
    });
    expect(JSON.stringify(stored)).not.toContain('hunter2');
    expect(modeOf(config.tokensFile, 0o600)).toBe(0o600);
    await expect(auth.getAccessToken()).resolves.toBe(ACCESS);
  });

  it('handles MFA on the same session and passes the method to the callback', async () => {
    const t = new FakeTransport('fetch', (call) => {
      if (isLogin(call)) return json(200, { responseStatus: { type: 'MFA_REQUIRED' }, customerMfaInfo: { mfaLastMethodUsed: 'email' } });
      if (isMfa(call)) return json(200, { responseStatus: { type: 'SUCCESSFUL' }, serviceTicketId: 'ST-MFA' });
      return happy(call);
    });
    const mfa = vi.fn<(method: string) => Promise<string>>(async () => ' 123456 ');
    const auth = createAuthService(tempConfig(), { transports: [t], fetch: verifyFetch(), now });
    await auth.login(creds, mfa);
    expect(mfa).toHaveBeenCalledWith('email');
    const [login, verify, exchange] = t.calls;
    expect(verify?.url).toBe('https://sso.garmin.com/mobile/api/mfa/verifyCode');
    expect(verify?.req.json).toMatchObject({ mfaMethod: 'email', mfaVerificationCode: '123456', rememberMyBrowser: true });
    expect(verify?.session).toBe(login?.session);
    expect(exchange?.req.form?.service_ticket).toBe('ST-MFA');
  });

  it('falls back to the portal MFA endpoint', async () => {
    const t = new FakeTransport('fetch', (call) => {
      if (isLogin(call)) return json(200, { responseStatus: { type: 'MFA_REQUIRED' }, customerMfaInfo: { mfaLastMethodUsed: 'totp' } });
      if (call.url.includes('/mobile/api/mfa')) return json(429, {});
      if (call.url.includes('/portal/api/mfa')) return json(200, { responseStatus: { type: 'SUCCESSFUL' }, serviceTicketId: 'ST-P' });
      return happy(call);
    });
    const auth = createAuthService(tempConfig(), { transports: [t], fetch: verifyFetch(), now });
    await auth.login(creds, async () => '1');
    expect(t.calls.find((c) => c.url.includes('/portal/'))?.req.params?.clientId).toBe('GarminConnect');
  });

  it('throws MfaRequiredError without a callback', async () => {
    const t = new FakeTransport('fetch', () => json(200, { responseStatus: { type: 'MFA_REQUIRED' }, customerMfaInfo: { mfaLastMethodUsed: 'sms' } }));
    const auth = createAuthService(tempConfig(), { transports: [t], fetch: verifyFetch(), now });
    await expect(auth.login(creds)).rejects.toMatchObject({ kind: 'mfa_required', method: 'sms' });
    await expect(auth.login(creds)).rejects.toBeInstanceOf(MfaRequiredError);
  });

  it('stops the cascade on invalid credentials', async () => {
    const curl = new FakeTransport('curl', () => json(200, { responseStatus: { type: 'INVALID_USERNAME_PASSWORD' } }), ['safari_ios', 'safari']);
    const fetchT = new FakeTransport('fetch', happy);
    const auth = createAuthService(tempConfig(), { transports: [curl, fetchT], fetch: verifyFetch(), now });
    await expect(auth.login(creds)).rejects.toBeInstanceOf(InvalidCredentialsError);
    expect(curl.calls).toHaveLength(1);
    expect(fetchT.calls).toHaveLength(0);
  });

  it('rotates curl profiles, falls back to fetch, and reports Cloudflare with a hint', async () => {
    const responses = [() => json(429, {}), () => json(403, {}), () => html(200)];
    let i = 0;
    const curl = new FakeTransport('curl', blocked(() => responses[i++ % 3]!()), ['safari_ios', 'safari', 'chrome']);
    const fetchT = new FakeTransport('fetch', blocked(() => json(429, {})));
    const auth = createAuthService(tempConfig(), { transports: [curl, fetchT], fetch: verifyFetch(), now });
    const err = await auth.login(creds).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudflareBlockedError);
    expect(err).toMatchObject({ kind: 'cloudflare_blocked', strategy: 'fetch', status: 429 });
    expect((err as CloudflareBlockedError).hint).toContain('garmin import-tokens');
    expect(curl.calls.map((c) => c.profile)).toEqual(['safari_ios', 'safari', 'chrome']);
    expect(fetchT.calls).toHaveLength(1);
  });

  it('skips an unavailable curl transport', async () => {
    const curl = new FakeTransport('curl', happy, ['safari_ios'], false);
    const fetchT = new FakeTransport('fetch', happy);
    const auth = createAuthService(tempConfig(), { transports: [curl, fetchT], fetch: verifyFetch(), now });
    await expect(auth.login(creds)).resolves.toMatchObject({ strategy: 'fetch' });
    expect(curl.calls).toHaveLength(0);
  });

  it('tries the next strategy when connectapi rejects the new token', async () => {
    const curl = new FakeTransport('curl', happy, ['safari_ios']);
    const fetchT = new FakeTransport('fetch', happy);
    let n = 0;
    const fetch = (() => Promise.resolve(new Response('{}', { status: n++ === 0 ? 401 : 200 }))) as typeof globalThis.fetch;
    const auth = createAuthService(tempConfig(), { transports: [curl, fetchT], fetch, now });
    await expect(auth.login(creds)).resolves.toMatchObject({ strategy: 'fetch' });
  });

  it('honours GARMIN_SSO_STRATEGY', async () => {
    const curl = new FakeTransport('curl', happy, ['safari_ios']);
    const fetchT = new FakeTransport('fetch', happy);
    const auth = createAuthService(tempConfig({ ssoStrategy: 'fetch' }), { transports: [curl, fetchT], fetch: verifyFetch(), now });
    await expect(auth.login(creds)).resolves.toMatchObject({ strategy: 'fetch' });
    expect(curl.calls).toHaveLength(0);

    const importOnly = createAuthService(tempConfig({ ssoStrategy: 'import' }), { transports: [fetchT], now });
    await expect(importOnly.login(creds)).rejects.toMatchObject({ kind: 'cloudflare_blocked', strategy: 'import' });
  });
});

function setup(access: string, handler: Handler, refresh: string | null = 'refresh-0') {
  const config = tempConfig();
  writeTokens(config.tokensFile, { di_token: access, di_refresh_token: refresh, di_client_id: 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2' });
  const transport = new FakeTransport('fetch', handler);
  const auth = createAuthService(config, { transports: [transport], fetch: verifyFetch(), now });
  return { config, transport, auth };
}

describe('tokens and refresh', () => {
  it('throws NotLoggedInError without tokens', async () => {
    const auth = createAuthService(tempConfig(), { transports: [], now });
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(NotLoggedInError);
    await expect(auth.status()).resolves.toMatchObject({ loggedIn: false });
  });

  it('returns the stored token while it is valid for more than 900 s', async () => {
    const access = tokenExpiringIn(901, NOW);
    const { auth, transport } = setup(access, happy);
    await expect(auth.getAccessToken()).resolves.toBe(access);
    expect(transport.calls).toHaveLength(0);
    await expect(auth.status()).resolves.toMatchObject({ loggedIn: true, clientId: 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2' });
  });

  it('refreshes within 900 s of expiry and rotates the refresh token', async () => {
    const fresh = tokenExpiringIn(14_400, NOW, 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4');
    const { auth, transport, config } = setup(tokenExpiringIn(899, NOW), () => json(200, { access_token: fresh, refresh_token: 'refresh-2' }));
    await expect(auth.getAccessToken()).resolves.toBe(fresh);
    expect(transport.calls[0]?.req.form).toEqual({
      grant_type: 'refresh_token',
      client_id: 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2',
      refresh_token: 'refresh-0',
    });
    expect(readTokens(config.tokensFile)).toMatchObject({
      di_token: fresh,
      di_refresh_token: 'refresh-2',
      di_client_id: 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4',
    });
  });

  it('keeps the old refresh token when none is returned', async () => {
    const fresh = tokenExpiringIn(14_400, NOW);
    const { auth, config } = setup(tokenExpiringIn(10, NOW), () => json(200, { access_token: fresh }));
    await auth.getAccessToken();
    expect(readTokens(config.tokensFile)?.di_refresh_token).toBe('refresh-0');
  });

  it('serialises refreshes: 10 parallel callers, 1 refresh', async () => {
    const fresh = tokenExpiringIn(14_400, NOW);
    const { auth, transport } = setup(tokenExpiringIn(-5, NOW), async () => {
      await new Promise((r) => setTimeout(r, 10));
      return json(200, { access_token: fresh, refresh_token: 'refresh-2' });
    });
    const tokens = await Promise.all(Array.from({ length: 10 }, () => auth.getAccessToken()));
    expect(new Set(tokens)).toEqual(new Set([fresh]));
    expect(transport.calls).toHaveLength(1);
  });

  it('turns invalid_grant into AuthExpiredError', async () => {
    const { auth } = setup(tokenExpiringIn(-5, NOW), () => json(400, { error: 'invalid_grant' }));
    const err = await auth.getAccessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthExpiredError);
    expect((err as AuthExpiredError).hint).toContain('garmin login');
  });

  it('fails as expired when there is no refresh token', async () => {
    const { auth } = setup(tokenExpiringIn(-5, NOW), happy, null);
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it('forces a refresh after invalidate()', async () => {
    const fresh = tokenExpiringIn(14_400, NOW, 'x', { n: 2 });
    const { auth, transport } = setup(tokenExpiringIn(10_000, NOW), () => json(200, { access_token: fresh }));
    await auth.invalidate();
    await expect(auth.getAccessToken()).resolves.toBe(fresh);
    await expect(auth.getAccessToken()).resolves.toBe(fresh);
    expect(transport.calls).toHaveLength(1);
  });

  it('retries a blocked refresh through curl', async () => {
    const fresh = tokenExpiringIn(14_400, NOW);
    const config = tempConfig();
    writeTokens(config.tokensFile, { di_token: tokenExpiringIn(-1, NOW), di_refresh_token: 'r', di_client_id: 'c' });
    const fetchT = new FakeTransport('fetch', () => html(403));
    const curl = new FakeTransport('curl', () => json(200, { access_token: fresh }), ['safari_ios']);
    const auth = createAuthService(config, { transports: [curl, fetchT], now });
    await expect(auth.getAccessToken()).resolves.toBe(fresh);
    expect(fetchT.calls).toHaveLength(1);
    expect(curl.calls).toHaveLength(1);
  });

  it('picks up tokens rewritten by another process', async () => {
    const { auth, config } = setup(tokenExpiringIn(10_000, NOW), happy);
    await auth.getAccessToken();
    const other = tokenExpiringIn(20_000, NOW, 'other');
    writeTokens(config.tokensFile, { di_token: other, di_refresh_token: 'x', di_client_id: 'other' });
    const later = Date.now() / 1000 + 5;
    fs.utimesSync(config.tokensFile, later, later);
    await expect(auth.getAccessToken()).resolves.toBe(other);
  });

  it('logout removes the tokens file', async () => {
    const { auth, config } = setup(tokenExpiringIn(10_000, NOW), happy);
    await auth.logout();
    expect(fs.existsSync(config.tokensFile)).toBe(false);
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(NotLoggedInError);
  });
});

describe('loginWithBrowser', () => {
  it('exchanges the browser ticket for the portal service and stores tokens', async () => {
    const config = tempConfig();
    const transport = new FakeTransport('fetch', happy);
    const auth = createAuthService(config, {
      transports: [transport],
      fetch: verifyFetch(200),
      now,
      browserSignIn: async () => 'ST-browser',
    });
    const status: string[] = [];
    const result = await auth.loginWithBrowser({ onStatus: (m) => status.push(m) });
    expect(result.strategy).toBe('browser');
    const exchange = transport.calls.find((c) => isDiauth(c));
    expect(exchange?.req?.form).toMatchObject({ service_ticket: 'ST-browser', service_url: 'https://connect.garmin.com/app' });
    expect(readTokens(config.tokensFile)).toMatchObject({ di_refresh_token: 'refresh-1', service_url: 'https://connect.garmin.com/app' });
    expect(status.at(-1)).toMatch(/exchanging/);
  });

  it('does not store a token connectapi rejects', async () => {
    const config = tempConfig();
    const auth = createAuthService(config, {
      transports: [new FakeTransport('fetch', happy)],
      fetch: verifyFetch(401),
      now,
      browserSignIn: async () => 'ST-browser',
    });
    await expect(auth.loginWithBrowser()).rejects.toThrow(/rejects/);
    expect(fs.existsSync(config.tokensFile)).toBe(false);
  });
});
