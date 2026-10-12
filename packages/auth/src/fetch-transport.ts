import { CookieJar } from './cookie-jar.js';
import {
  Pacer,
  encodeBody,
  hasHeader,
  makeResponse,
  withParams,
  type PacingOptions,
  type SsoRequest,
  type SsoResponse,
  type SsoSession,
  type SsoTransport,
} from './transport.js';

export interface FetchTransportOptions extends PacingOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Plain undici fetch. Works when Cloudflare does not fingerprint-block; one attempt. */
export class FetchTransport implements SsoTransport {
  readonly name = 'fetch' as const;
  readonly profiles = ['default'] as const;

  constructor(private readonly opts: FetchTransportOptions = {}) {}

  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  createSession(profile = 'default'): SsoSession {
    return new FetchSession(profile, this.opts);
  }
}

class FetchSession implements SsoSession {
  private readonly jar: CookieJar;
  private readonly pacer: Pacer;
  private readonly fetchImpl: typeof fetch;

  constructor(
    readonly profile: string,
    private readonly opts: FetchTransportOptions,
  ) {
    this.jar = new CookieJar(opts.now);
    this.pacer = new Pacer(opts);
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  get(url: string, req: SsoRequest = {}): Promise<SsoResponse> {
    return this.send('GET', url, req);
  }

  post(url: string, req: SsoRequest = {}): Promise<SsoResponse> {
    return this.send('POST', url, req);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  private async send(method: string, rawUrl: string, req: SsoRequest): Promise<SsoResponse> {
    await this.pacer.wait();
    const url = withParams(rawUrl, req.params);
    const headers: Record<string, string> = { ...req.headers };
    const { body, contentType } = encodeBody(req);
    if (contentType && !hasHeader(headers, 'content-type')) headers['Content-Type'] = contentType;
    const cookie = this.jar.header(url);
    if (cookie) headers.Cookie = cookie;
    const res = await this.fetchImpl(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: 'follow',
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
    });
    this.jar.store(res.url || url, res.headers.getSetCookie());
    const text = await res.text();
    const out: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      out[k] = v;
    });
    return makeResponse(res.status, out, text);
  }
}
