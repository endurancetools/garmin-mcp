import type { GarminConfig, Logger } from 'garmin-mcp-config';
import { nativeAppHeaders } from 'garmin-mcp-config';
import {
  AuthExpiredError,
  CloudflareBlockedError,
  InvalidCredentialsError,
  MfaRequiredError,
  NetworkError,
} from './errors.js';
import { jwtClientId, jwtExpiry } from './jwt.js';
import { isCloudflareResponse, isHtmlResponse, type SsoResponse, type SsoSession } from './transport.js';
import type { Credentials, MfaCallback, SsoStrategyName } from './types.js';

/** iOS Garmin Connect app identity used for the SSO JSON API. */
export const IOS_SSO_CLIENT_ID = 'GCM_IOS_DARK';
export const IOS_LOGIN_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
export const PORTAL_SSO_CLIENT_ID = 'GarminConnect';
export const DI_GRANT_TYPE = 'https://connectapi.garmin.com/di-oauth2-service/oauth/grant/service_ticket';

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  clientId: string;
  expiresAt: Date | undefined;
}

export interface FlowContext {
  config: GarminConfig;
  logger: Logger;
  strategy: SsoStrategyName;
  now?: () => number;
}

export function basicAuth(clientId: string): string {
  return `Basic ${Buffer.from(`${clientId}:`).toString('base64')}`;
}

export const diTokenUrl = (config: GarminConfig): string => `${config.hosts.diauth}/di-oauth2-service/oauth/token`;

function loginParams(config: GarminConfig): Record<string, string> {
  return { clientId: IOS_SSO_CLIENT_ID, locale: 'en-US', service: config.hosts.mobileServiceUrl };
}

function loginHeaders(config: GarminConfig): Record<string, string> {
  return {
    'User-Agent': IOS_LOGIN_USER_AGENT,
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    Origin: config.hosts.sso,
  };
}

interface SsoJson {
  responseStatus?: { type?: string };
  serviceTicketId?: string;
  customerMfaInfo?: { mfaLastMethodUsed?: string };
  error?: { 'status-code'?: string | number };
}

function asSsoJson(res: SsoResponse, ctx: FlowContext, step: string): SsoJson {
  if (isCloudflareResponse(res)) {
    throw new CloudflareBlockedError(ctx.strategy, res.status, `${step}: HTTP ${res.status} from Garmin SSO (Cloudflare)`);
  }
  let body: unknown;
  try {
    body = res.json();
  } catch {
    throw new NetworkError(`${step}: non-JSON response (HTTP ${res.status})`);
  }
  if (typeof body !== 'object' || body === null) throw new NetworkError(`${step}: unexpected response (HTTP ${res.status})`);
  const json = body as SsoJson;
  if (String(json.error?.['status-code'] ?? '') === '429') {
    throw new CloudflareBlockedError(ctx.strategy, 429, `${step}: rate limited (429 in JSON body)`);
  }
  return json;
}

export type LoginStep = { kind: 'ticket'; ticket: string } | { kind: 'mfa'; method: string };

/** Step 1-2: POST credentials to the mobile SSO JSON API. */
export async function submitCredentials(session: SsoSession, creds: Credentials, ctx: FlowContext): Promise<LoginStep> {
  const { config } = ctx;
  const res = await session.post(`${config.hosts.sso}/mobile/api/login`, {
    params: loginParams(config),
    headers: loginHeaders(config),
    json: { username: creds.email, password: creds.password, rememberMe: true, captchaToken: '' },
  });
  const json = asSsoJson(res, ctx, 'Mobile login');
  const type = json.responseStatus?.type;
  switch (type) {
    case 'SUCCESSFUL':
      if (!json.serviceTicketId) throw new NetworkError('Mobile login succeeded without a service ticket');
      return { kind: 'ticket', ticket: json.serviceTicketId };
    case 'MFA_REQUIRED':
      return { kind: 'mfa', method: json.customerMfaInfo?.mfaLastMethodUsed ?? 'email' };
    case 'INVALID_USERNAME_PASSWORD':
      throw new InvalidCredentialsError();
    case 'CAPTCHA_REQUIRED':
      throw new CloudflareBlockedError(ctx.strategy, res.status, 'Mobile login: CAPTCHA required (bot challenge)');
    default:
      ctx.logger.debug({ status: res.status, responseStatus: type }, 'unexpected mobile login response');
      throw new NetworkError(`Mobile login failed: HTTP ${res.status}, responseStatus=${type ?? 'unknown'}`);
  }
}

/** Step 3: verify the MFA code on the mobile endpoint, then the portal one (different rate-limit buckets). */
export async function verifyMfaCode(session: SsoSession, method: string, code: string, ctx: FlowContext): Promise<string> {
  const { config } = ctx;
  const body = { mfaMethod: method, mfaVerificationCode: code, rememberMyBrowser: true, reconsentList: [], mfaSetup: false };
  const endpoints: Array<{ url: string; params: Record<string, string> }> = [
    { url: `${config.hosts.sso}/mobile/api/mfa/verifyCode`, params: loginParams(config) },
    {
      url: `${config.hosts.sso}/portal/api/mfa/verifyCode`,
      params: { clientId: PORTAL_SSO_CLIENT_ID, locale: 'en-US', service: `https://connect.${config.hosts.domain}/app` },
    },
  ];
  const failures: string[] = [];
  let rateLimited = 0;
  for (const ep of endpoints) {
    let res: SsoResponse;
    try {
      res = await session.post(ep.url, { params: ep.params, headers: loginHeaders(config), json: body });
    } catch (err) {
      failures.push(`connection error: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (res.status === 429) {
      rateLimited++;
      failures.push('HTTP 429');
      continue;
    }
    if (isHtmlResponse(res)) {
      failures.push(`HTTP ${res.status} non-JSON`);
      continue;
    }
    let json: SsoJson;
    try {
      json = res.json() as SsoJson;
    } catch {
      failures.push(`HTTP ${res.status} non-JSON`);
      continue;
    }
    if (String(json.error?.['status-code'] ?? '') === '429') {
      rateLimited++;
      failures.push('429 in JSON body');
      continue;
    }
    if (json.responseStatus?.type === 'SUCCESSFUL' && json.serviceTicketId) return json.serviceTicketId;
    failures.push(json.responseStatus?.type ?? `HTTP ${res.status}`);
  }
  if (rateLimited === endpoints.length) {
    throw new CloudflareBlockedError(ctx.strategy, 429, 'MFA verification rate limited on all endpoints');
  }
  throw new InvalidCredentialsError(`MFA verification failed (${failures.join('; ')}); the code may be wrong or expired`);
}

interface TokenJson {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
}

function toTokenSet(json: TokenJson, fallbackClientId: string, now: number, previousRefresh: string | null): TokenSet {
  if (!json.access_token) throw new NetworkError('DI token response without access_token');
  const expiresAt =
    jwtExpiry(json.access_token) ??
    (typeof json.expires_in === 'number' ? new Date(now + json.expires_in * 1000) : undefined);
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? previousRefresh,
    clientId: jwtClientId(json.access_token) ?? fallbackClientId,
    expiresAt,
  };
}

function diHeaders(config: GarminConfig, clientId: string): Record<string, string> {
  return {
    ...nativeAppHeaders(config.app),
    Authorization: basicAuth(clientId),
    Accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Cache-Control': 'no-cache',
  };
}

/** Steps 4-5: exchange the CAS service ticket for DI OAuth2 tokens, trying each client id. */
export async function exchangeServiceTicket(
  session: SsoSession,
  ticket: string,
  ctx: FlowContext,
  /** Service the ticket was issued for; the mobile one unless the browser (portal) flow produced it. */
  serviceUrl: string = ctx.config.hosts.mobileServiceUrl,
): Promise<TokenSet> {
  const { config } = ctx;
  const now = ctx.now ?? Date.now;
  for (const clientId of config.diClientIds) {
    const res = await session.post(diTokenUrl(config), {
      headers: diHeaders(config, clientId),
      form: {
        client_id: clientId,
        service_ticket: ticket,
        grant_type: DI_GRANT_TYPE,
        service_url: serviceUrl,
      },
    });
    if (res.status === 429) throw new CloudflareBlockedError(ctx.strategy, 429, 'DI token exchange rate limited');
    if (res.status < 200 || res.status >= 300) {
      ctx.logger.debug({ clientId, status: res.status }, 'DI token exchange failed for client id');
      continue;
    }
    try {
      return toTokenSet(res.json() as TokenJson, clientId, now(), null);
    } catch {
      ctx.logger.debug({ clientId }, 'DI token response could not be parsed');
    }
  }
  throw new NetworkError(
    `DI token exchange failed for all client ids (${config.diClientIds.join(', ')}). Garmin may have retired them; set GARMIN_DI_CLIENT_IDS.`,
  );
}

/** Full mobile flow on one session: credentials, optional MFA, ticket exchange. */
export async function mobileLogin(
  session: SsoSession,
  creds: Credentials,
  mfa: MfaCallback | undefined,
  ctx: FlowContext,
): Promise<TokenSet> {
  const step = await submitCredentials(session, creds, ctx);
  let ticket: string;
  if (step.kind === 'mfa') {
    if (!mfa) throw new MfaRequiredError(step.method);
    const code = (await mfa(step.method)).trim();
    ticket = await verifyMfaCode(session, step.method, code, ctx);
  } else {
    ticket = step.ticket;
  }
  return exchangeServiceTicket(session, ticket, ctx);
}

export type RefreshOutcome = { ok: true; tokens: TokenSet } | { ok: false; blocked: boolean; status: number };

/**
 * Refresh grant. Returns `{ ok: false, blocked: true }` for Cloudflare-looking
 * responses so the caller can retry through another transport; a dead refresh token throws.
 */
export async function refreshDiToken(
  session: SsoSession,
  refreshToken: string,
  clientId: string,
  ctx: FlowContext,
): Promise<RefreshOutcome> {
  const { config } = ctx;
  const res = await session.post(diTokenUrl(config), {
    headers: { ...diHeaders(config, clientId), Accept: 'application/json' },
    form: { grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken },
  });
  if (res.status === 429 || res.status === 403 || isHtmlResponse(res)) return { ok: false, blocked: true, status: res.status };
  let json: TokenJson | undefined;
  try {
    json = res.json() as TokenJson;
  } catch {
    json = undefined;
  }
  if (res.status === 400 || res.status === 401 || json?.error === 'invalid_grant') {
    throw new AuthExpiredError(`Garmin rejected the refresh token (HTTP ${res.status}${json?.error ? `, ${json.error}` : ''})`);
  }
  if (res.status < 200 || res.status >= 300 || !json) return { ok: false, blocked: false, status: res.status };
  return { ok: true, tokens: toTokenSet(json, clientId, (ctx.now ?? Date.now)(), refreshToken) };
}
