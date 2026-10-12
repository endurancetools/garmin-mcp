import type { SsoStrategyName } from './types.js';

export interface SsoRequest {
  headers?: Record<string, string>;
  params?: Record<string, string>;
  /** Serialized as a JSON body. */
  json?: unknown;
  /** Serialized as application/x-www-form-urlencoded. */
  form?: Record<string, string>;
}

export interface SsoResponse {
  status: number;
  /** Header names are lower-cased. */
  headers: Record<string, string>;
  text(): string;
  /** Parsed JSON body; throws when the body is not JSON. */
  json(): unknown;
}

/** One logical browser session: cookies persist across calls (login -> MFA share them). */
export interface SsoSession {
  readonly profile: string;
  get(url: string, req?: SsoRequest): Promise<SsoResponse>;
  post(url: string, req?: SsoRequest): Promise<SsoResponse>;
  close(): Promise<void>;
}

/** Pluggable HTTP stack for sso.garmin.com and diauth.garmin.com. */
export interface SsoTransport {
  readonly name: SsoStrategyName;
  /** TLS profiles to rotate through; each gets its own session and Cloudflare bucket. */
  readonly profiles: readonly string[];
  isAvailable(): Promise<boolean>;
  createSession(profile?: string): SsoSession;
}

export interface PacingOptions {
  /** Minimum gap between consecutive requests of one session. Cloudflare flags fast sequences. */
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const DEFAULT_MIN_INTERVAL_MS = 3000;
export const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Spaces out the requests of one session. */
export class Pacer {
  private last: number | undefined;
  private readonly minIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(opts: PacingOptions = {}) {
    this.minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? Date.now;
  }

  async wait(): Promise<void> {
    if (this.last !== undefined) {
      const remaining = this.last + this.minIntervalMs - this.now();
      if (remaining > 0) await this.sleep(remaining);
    }
    this.last = this.now();
  }
}

export function makeResponse(status: number, headers: Record<string, string>, body: string): SsoResponse {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: lower,
    text: () => body,
    json: () => JSON.parse(body) as unknown,
  };
}

/** HTML instead of JSON is how a Cloudflare challenge page shows up. */
export function isHtmlResponse(res: SsoResponse): boolean {
  const type = res.headers['content-type'] ?? '';
  return type.includes('text/html') || res.text().trimStart().startsWith('<');
}

/** 429, 403 or an HTML body: treat as a Cloudflare block and move to the next strategy. */
export function isCloudflareResponse(res: SsoResponse): boolean {
  return res.status === 429 || res.status === 403 || isHtmlResponse(res);
}

export function withParams(url: string, params?: Record<string, string>): string {
  if (!params || Object.keys(params).length === 0) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

export function encodeBody(req: SsoRequest): { body: string | undefined; contentType: string | undefined } {
  if (req.form) return { body: new URLSearchParams(req.form).toString(), contentType: 'application/x-www-form-urlencoded' };
  if (req.json !== undefined) return { body: JSON.stringify(req.json), contentType: 'application/json' };
  return { body: undefined, contentType: undefined };
}

export function hasHeader(headers: Record<string, string>, name: string): boolean {
  const n = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === n);
}
