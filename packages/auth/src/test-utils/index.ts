import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type GarminConfig, type RawConfig } from 'garmin-mcp-config';
import { makeResponse, type SsoRequest, type SsoResponse, type SsoSession, type SsoTransport } from '../transport.js';
import type { SsoStrategyName } from '../types.js';

const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');

export function fakeJwt(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256', typ: 'JWT' }): string {
  return `${enc(header)}.${enc(payload)}.c2lnbmF0dXJl`;
}

/** JWT expiring `inSeconds` after `nowMs`. */
export function tokenExpiringIn(inSeconds: number, nowMs: number, clientId = 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2', extra: Record<string, unknown> = {}): string {
  return fakeJwt({ client_id: clientId, exp: Math.floor(nowMs / 1000) + inSeconds, ...extra });
}

export function tempConfig(raw: RawConfig = {}): GarminConfig {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'garmin-auth-'));
  return loadConfig({ env: { HOME: home, GARMIN_DATA_DIR: path.join(home, 'data') }, overrides: raw });
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}): SsoResponse =>
  makeResponse(status, { 'content-type': 'application/json', ...headers }, JSON.stringify(body));

export const html = (status: number, body = '<html><title>Just a moment...</title></html>'): SsoResponse =>
  makeResponse(status, { 'content-type': 'text/html' }, body);

export interface RecordedCall {
  transport: SsoStrategyName;
  profile: string;
  session: number;
  method: 'GET' | 'POST';
  url: string;
  req: SsoRequest;
}

export type Handler = (call: RecordedCall) => SsoResponse | Promise<SsoResponse>;

let sessionCounter = 0;

/** Scriptable SsoTransport; every request is recorded in `calls`. */
export class FakeTransport implements SsoTransport {
  readonly calls: RecordedCall[] = [];

  constructor(
    readonly name: SsoStrategyName,
    private readonly handler: Handler,
    readonly profiles: readonly string[] = ['default'],
    private readonly available = true,
  ) {}

  isAvailable(): Promise<boolean> {
    return Promise.resolve(this.available);
  }

  createSession(profile = this.profiles[0] ?? 'default'): SsoSession {
    const id = ++sessionCounter;
    const send = async (method: 'GET' | 'POST', url: string, req: SsoRequest = {}) => {
      const call: RecordedCall = { transport: this.name, profile, session: id, method, url, req };
      this.calls.push(call);
      return this.handler(call);
    };
    return {
      profile,
      get: (url, req) => send('GET', url, req),
      post: (url, req) => send('POST', url, req),
      close: () => Promise.resolve(),
    };
  }
}

export const isLogin = (c: RecordedCall) => c.url.endsWith('/mobile/api/login');
export const isMfa = (c: RecordedCall) => c.url.includes('/api/mfa/verifyCode');
export const isDiauth = (c: RecordedCall) => c.url.includes('/di-oauth2-service/oauth/token');

/** File mode bits, or the expected value on Windows where POSIX modes do not apply. */
export function modeOf(file: string, expected: number): number {
  return process.platform === 'win32' ? expected : fs.statSync(file).mode & 0o777;
}

/** fetch stub for connectapi verification. */
export function verifyFetch(status = 200): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const fn = ((input: string | URL | Request) => {
    calls.push(String(input));
    return Promise.resolve(new Response(JSON.stringify({ displayName: 'me' }), { status }));
  }) as typeof fetch & { calls: string[] };
  fn.calls = calls;
  return fn;
}
