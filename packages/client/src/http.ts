import type { TokenProvider } from 'garmin-mcp-auth';
import { nativeAppHeaders, silentLogger, type AppIdentity, type Logger } from 'garmin-mcp-config';
import pLimit, { type LimitFunction } from 'p-limit';
import type { z } from 'zod';
import {
  ClientNetworkError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  UnauthorizedError,
  ValidationError,
} from './errors.js';

export type Query = Record<string, string | number | boolean | undefined>;

export interface HttpOptions {
  baseUrl: string;
  tokens: TokenProvider;
  app: AppIdentity;
  /** Parallel requests to connectapi, default 4. */
  concurrency?: number;
  /**
   * Minimum spacing between request starts, in ms, jittered ±25 % so the traffic
   * does not look machine-regular. 0 disables pacing (the default here; the
   * client passes the configured value).
   */
  minIntervalMs?: number;
  /** Retries after the first attempt on 429/5xx/network errors, default 4. */
  maxRetries?: number;
  /** Backoff base in ms, doubled per retry: 1 s, 2 s, 4 s, 8 s by default. */
  backoffMs?: number;
  /** Upper bound for an honoured Retry-After, in ms. */
  maxRetryAfterMs?: number;
  timeoutMs?: number;
  logger?: Logger;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions<S extends z.ZodType | undefined = undefined> {
  query?: Query;
  json?: unknown;
  schema?: S;
  /**
   * When the schema fails, by default we log and return the raw body.
   * `strict` throws instead; use it where the store needs the fields.
   */
  strict?: boolean;
}

export interface BinaryResponse {
  data: Uint8Array;
  contentType: string | undefined;
  filename: string | undefined;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Path hygiene mirrors python-garminconnect: no traversal, query or fragment in paths. */
export function assertSafePath(path: string): void {
  const decoded = decodeURIComponent(path);
  const traversal = decoded.split('/').some((seg) => seg.split(';')[0] === '..');
  if (traversal || /[?#\\]/.test(decoded)) throw new RangeError(`Invalid API path: ${path}`);
}

function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

function looksLikeHtml(contentType: string | null, body: string): boolean {
  return (contentType ?? '').includes('text/html') || /^\s*<(!doctype|html)/i.test(body);
}

/**
 * HTTP core for connectapi: Bearer auth, native app headers, a concurrency pool,
 * exponential backoff, a single 401 refresh, and Cloudflare classification.
 */
export class HttpCore {
  readonly #opts: Required<Omit<HttpOptions, 'logger' | 'fetch' | 'sleep'>>;
  #nextSlot = 0;
  #requests = 0;
  readonly #log: Logger;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #limit: LimitFunction;
  readonly #baseHeaders: Record<string, string>;

  constructor(options: HttpOptions) {
    this.#opts = {
      baseUrl: options.baseUrl.replace(/\/+$/, ''),
      tokens: options.tokens,
      app: options.app,
      concurrency: options.concurrency ?? 4,
      minIntervalMs: options.minIntervalMs ?? 0,
      maxRetries: options.maxRetries ?? 4,
      backoffMs: options.backoffMs ?? 1000,
      maxRetryAfterMs: options.maxRetryAfterMs ?? 60_000,
      timeoutMs: options.timeoutMs ?? 30_000,
    };
    this.#log = options.logger ?? silentLogger;
    this.#fetch = options.fetch ?? fetch;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#limit = pLimit(this.#opts.concurrency);
    this.#baseHeaders = nativeAppHeaders(options.app);
  }

  /** Requests sent so far (every attempt counts), for budgets and diagnostics. */
  get requestCount(): number {
    return this.#requests;
  }

  /** Wait for the next free slot: request starts are `minIntervalMs` apart with ±25 % jitter. */
  async #pace(): Promise<void> {
    const gap = this.#opts.minIntervalMs;
    if (gap <= 0) return;
    const now = Date.now();
    const start = Math.max(now, this.#nextSlot);
    this.#nextSlot = start + gap * (0.75 + Math.random() * 0.5);
    if (start > now) await this.#sleep(start - now);
  }

  async request<S extends z.ZodType | undefined = undefined>(
    method: string,
    path: string,
    options: RequestOptions<S> = {},
  ): Promise<S extends z.ZodType ? z.output<S> : unknown> {
    const res = await this.#send(method, path, options.query, options.json, 'application/json');
    if (res.status === 204) return null as never;
    const text = await res.text();
    if (looksLikeHtml(res.headers.get('content-type'), text)) throw new ForbiddenError(path, true);
    let body: unknown = null;
    if (text.trim() !== '') {
      try {
        body = JSON.parse(text);
      } catch (err) {
        throw new ClientNetworkError(path, 'response was not JSON', res.status, err);
      }
    }
    if (!options.schema) return body as never;
    const parsed = options.schema.safeParse(body);
    if (parsed.success) return parsed.data as never;
    const issues = parsed.error.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message }));
    if (options.strict) throw new ValidationError(path, issues);
    this.#log.warn({ path, issues: issues.slice(0, 5) }, 'response failed schema validation; passing through');
    return body as never;
  }

  async download(path: string, query?: Query): Promise<BinaryResponse> {
    const res = await this.#send('GET', path, query, undefined, '*/*');
    const contentType = res.headers.get('content-type') ?? undefined;
    const data = new Uint8Array(await res.arrayBuffer());
    if (contentType?.includes('text/html')) throw new ForbiddenError(path, true);
    const disposition = res.headers.get('content-disposition') ?? '';
    const filename = /filename="?([^";]+)"?/i.exec(disposition)?.[1];
    return { data, contentType, filename };
  }

  #send(method: string, path: string, query: Query | undefined, json: unknown, accept: string): Promise<Response> {
    assertSafePath(path);
    const url = new URL(`${this.#opts.baseUrl}/${path.replace(/^\/+/, '')}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    return this.#limit(() => this.#attempt(method, url, path, json, accept));
  }

  async #attempt(method: string, url: URL, path: string, json: unknown, accept: string): Promise<Response> {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.#opts.tokens.getAccessToken();
      await this.#pace();
      this.#requests++;
      const started = performance.now();
      let res: Response;
      try {
        res = await this.#fetch(url, {
          method,
          headers: {
            ...this.#baseHeaders,
            Authorization: `Bearer ${token}`,
            Accept: accept,
            ...(json === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: json === undefined ? null : JSON.stringify(json),
          signal: AbortSignal.timeout(this.#opts.timeoutMs),
        });
      } catch (err) {
        this.#log.debug({ method, path, err: String(err) }, 'request failed');
        if (attempt < this.#opts.maxRetries) {
          await this.#sleep(this.#backoff(attempt));
          continue;
        }
        throw new ClientNetworkError(path, err instanceof Error ? err.message : String(err), undefined, err);
      }
      this.#log.debug({ method, path, status: res.status, ms: Math.round(performance.now() - started) }, 'connectapi');

      if (res.ok) return res;
      if (res.status === 401) {
        await res.body?.cancel();
        if (refreshed) throw new UnauthorizedError(path);
        refreshed = true;
        await this.#opts.tokens.invalidate();
        attempt--;
        continue;
      }
      if (res.status === 403) {
        const text = await res.text();
        const cloudflare = looksLikeHtml(res.headers.get('content-type'), text) || res.headers.has('cf-mitigated');
        throw new ForbiddenError(path, cloudflare);
      }
      if (res.status === 404) {
        await res.body?.cancel();
        throw new NotFoundError(path);
      }
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
        await res.body?.cancel();
        if (attempt < this.#opts.maxRetries && (retryAfter === undefined || retryAfter <= this.#opts.maxRetryAfterMs)) {
          await this.#sleep(retryAfter ?? this.#backoff(attempt));
          continue;
        }
        if (res.status === 429) {
          throw new RateLimitedError(path, retryAfter === undefined ? undefined : Math.ceil(retryAfter / 1000));
        }
        throw new ClientNetworkError(path, `HTTP ${res.status}`, res.status);
      }
      const detail = await safeErrorDetail(res);
      throw new ClientNetworkError(path, `HTTP ${res.status}${detail ? ` - ${detail}` : ''}`, res.status);
    }
  }

  #backoff(attempt: number): number {
    return this.#opts.backoffMs * 2 ** attempt;
  }
}

async function safeErrorDetail(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object') {
      const b = body as Record<string, unknown>;
      const msg = b.message ?? b.content ?? b.error;
      if (typeof msg === 'string') return msg.slice(0, 200);
    }
  } catch {
    // body was not JSON
  }
  return '';
}
