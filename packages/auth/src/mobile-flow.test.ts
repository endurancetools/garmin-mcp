import { silentLogger } from 'garmin-mcp-config';
import { describe, expect, it } from 'vitest';
import { CloudflareBlockedError, InvalidCredentialsError, NetworkError } from './errors.js';
import { decodeJwt, jwtClientId, jwtExpiry } from './jwt.js';
import { basicAuth, DI_GRANT_TYPE, exchangeServiceTicket, mobileLogin, submitCredentials, type FlowContext } from './mobile-flow.js';
import { FakeTransport, fakeJwt, html, isDiauth, isLogin, json, tempConfig } from './test-utils/index.js';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const creds = { email: 'runner@example.com', password: 'hunter2' };

function ctx(raw = {}): FlowContext {
  return { config: tempConfig(raw), logger: silentLogger, strategy: 'fetch', now: () => NOW };
}

describe('jwt', () => {
  it('extracts client_id and exp', () => {
    const t = fakeJwt({ client_id: 'GARMIN_CONNECT_MOBILE_IOS_DI', exp: 1_800_000_000 });
    expect(jwtClientId(t)).toBe('GARMIN_CONNECT_MOBILE_IOS_DI');
    expect(jwtExpiry(t)?.getTime()).toBe(1_800_000_000_000);
  });
  it('rejects alg none and garbage', () => {
    expect(decodeJwt(fakeJwt({ exp: 1 }, { alg: 'none' }))).toBeUndefined();
    expect(decodeJwt('not-a-jwt')).toBeUndefined();
    expect(jwtExpiry(fakeJwt({ exp: 'soon' }))).toBeUndefined();
  });
});

describe('mobile flow', () => {
  it('logs in and exchanges the ticket', async () => {
    const c = ctx();
    const access = fakeJwt({ client_id: 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2', exp: NOW / 1000 + 14_400 });
    const t = new FakeTransport('fetch', (call) => {
      if (isLogin(call)) return json(200, { responseStatus: { type: 'SUCCESSFUL' }, serviceTicketId: 'ST-123' });
      if (isDiauth(call)) return json(200, { access_token: access, refresh_token: 'r1', expires_in: 14_400 });
      return json(404, {});
    });
    const tokens = await mobileLogin(t.createSession(), creds, undefined, c);
    expect(tokens).toMatchObject({ accessToken: access, refreshToken: 'r1', clientId: 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2' });
    expect(tokens.expiresAt?.getTime()).toBe(NOW + 14_400_000);

    const [login, exchange] = t.calls;
    expect(login?.url).toBe('https://sso.garmin.com/mobile/api/login');
    expect(login?.req.params).toEqual({ clientId: 'GCM_IOS_DARK', locale: 'en-US', service: 'https://mobile.integration.garmin.com/gcm/ios' });
    expect(login?.req.json).toEqual({ username: creds.email, password: creds.password, rememberMe: true, captchaToken: '' });
    expect(login?.req.headers?.Origin).toBe('https://sso.garmin.com');
    expect(exchange?.url).toBe('https://diauth.garmin.com/di-oauth2-service/oauth/token');
    expect(exchange?.req.headers?.Authorization).toBe(basicAuth('GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2'));
    expect(exchange?.req.headers?.['X-Garmin-Client-Platform']).toBe('Android');
    expect(exchange?.req.form).toEqual({
      client_id: 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2',
      service_ticket: 'ST-123',
      grant_type: DI_GRANT_TYPE,
      service_url: 'https://mobile.integration.garmin.com/gcm/ios',
    });
  });

  it('uses region hosts for CN accounts', async () => {
    const c = ctx({ region: 'cn' });
    const t = new FakeTransport('fetch', () => json(200, { responseStatus: { type: 'MFA_REQUIRED' }, customerMfaInfo: { mfaLastMethodUsed: 'sms' } }));
    await expect(submitCredentials(t.createSession(), creds, c)).resolves.toEqual({ kind: 'mfa', method: 'sms' });
    expect(t.calls[0]?.url).toBe('https://sso.garmin.cn/mobile/api/login');
    expect(t.calls[0]?.req.params?.service).toBe('https://mobile.integration.garmin.cn/gcm/ios');
  });

  it('tries the next DI client id when one is rejected', async () => {
    const c = ctx();
    const access = fakeJwt({ exp: NOW / 1000 + 3600 });
    const t = new FakeTransport('fetch', (call) =>
      call.req.form?.client_id === 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2'
        ? json(400, { error: 'invalid_client' })
        : json(200, { access_token: access, refresh_token: 'r' }),
    );
    const tokens = await exchangeServiceTicket(t.createSession(), 'ST-1', c);
    expect(t.calls.map((x) => x.req.form?.client_id)).toEqual([
      'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2',
      'GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4',
    ]);
    // No client_id claim in the JWT: fall back to the id that worked.
    expect(tokens.clientId).toBe('GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4');
  });

  it('fails with a hint when every client id is rejected', async () => {
    const t = new FakeTransport('fetch', () => json(400, {}));
    await expect(exchangeServiceTicket(t.createSession(), 'ST-1', ctx())).rejects.toBeInstanceOf(NetworkError);
    expect(t.calls).toHaveLength(4);
  });

  it.each([
    ['HTTP 429', () => json(429, {})],
    ['HTTP 403', () => json(403, {})],
    ['HTML challenge', () => html(200)],
    ['429 in JSON body', () => json(200, { error: { 'status-code': '429' } })],
    ['CAPTCHA', () => json(200, { responseStatus: { type: 'CAPTCHA_REQUIRED' } })],
  ])('classifies %s as Cloudflare', async (_name, res) => {
    const t = new FakeTransport('fetch', res);
    await expect(submitCredentials(t.createSession(), creds, ctx())).rejects.toBeInstanceOf(CloudflareBlockedError);
  });

  it('maps INVALID_USERNAME_PASSWORD', async () => {
    const t = new FakeTransport('fetch', () => json(200, { responseStatus: { type: 'INVALID_USERNAME_PASSWORD' } }));
    await expect(submitCredentials(t.createSession(), creds, ctx())).rejects.toBeInstanceOf(InvalidCredentialsError);
  });
});
