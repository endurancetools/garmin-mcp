import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type * as CuimpTypes from 'cuimp';
import type { Logger } from 'garmin-mcp-config';
import { silentLogger } from 'garmin-mcp-config';
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

type CuimpModule = typeof CuimpTypes;
type CuimpHttpClient = ReturnType<CuimpModule['createCuimpHttp']>;

interface CurlProfile {
  browser: 'safari' | 'chrome';
  platform?: 'ios';
  /** `--impersonate` target passed when the generic `curl-impersonate` binary is used. */
  target: string;
}

/** TLS profiles rotated in order; different fingerprints land in different Cloudflare buckets. */
export const CURL_PROFILES: Record<string, CurlProfile> = {
  safari_ios: { browser: 'safari', platform: 'ios', target: 'safari184_ios' },
  safari: { browser: 'safari', target: 'safari184' },
  chrome: { browser: 'chrome', target: 'chrome131' },
};

export interface CurlTransportOptions extends PacingOptions {
  profiles?: string[];
  logger?: Logger;
  timeoutMs?: number;
  /** Let cuimp download the curl-impersonate binary on first use. */
  autoDownload?: boolean;
  /** Test seam: replaces `import('cuimp')`. */
  loadModule?: () => Promise<CuimpModule>;
}

const loadCuimp = (): Promise<CuimpModule> => import('cuimp');

/** True when the optional `cuimp` dependency can be imported. Does not download anything. */
export async function curlAvailable(loadModule: () => Promise<CuimpModule> = loadCuimp): Promise<boolean> {
  try {
    await loadModule();
    return true;
  } catch {
    return false;
  }
}

/** Path of an already present curl-impersonate binary, without downloading one. */
export async function findCurlBinary(loadModule: () => Promise<CuimpModule> = loadCuimp): Promise<string | undefined> {
  try {
    const mod = await loadModule();
    const core = new mod.Cuimp({ descriptor: { browser: 'safari' }, autoDownload: false, logger: quietLogger() });
    return await core.ensurePath();
  } catch {
    return undefined;
  }
}

const fmt = (args: unknown[]): string => args.map(String).join(' ');

/** cuimp logs downloads at info level; route everything to our debug/trace instead of stdout. */
function quietLogger(logger: Logger = silentLogger) {
  return {
    info: (...a: unknown[]) => logger.debug(fmt(a)),
    warn: (...a: unknown[]) => logger.debug(fmt(a)),
    error: (...a: unknown[]) => logger.debug(fmt(a)),
    debug: (...a: unknown[]) => logger.trace(fmt(a)),
  };
}

/**
 * curl-impersonate through the optional `cuimp` package: browser-grade TLS fingerprints
 * without a native Node module.
 */
export class CurlTransport implements SsoTransport {
  readonly name = 'curl' as const;
  readonly profiles: readonly string[];
  private available: Promise<boolean> | undefined;

  constructor(private readonly opts: CurlTransportOptions = {}) {
    this.profiles = opts.profiles ?? Object.keys(CURL_PROFILES);
  }

  isAvailable(): Promise<boolean> {
    this.available ??= (async () => {
      try {
        const mod = await (this.opts.loadModule ?? loadCuimp)();
        const core = new mod.Cuimp({
          descriptor: { browser: 'safari' },
          autoDownload: this.opts.autoDownload ?? true,
          logger: quietLogger(this.opts.logger),
        });
        await core.ensurePath();
        return true;
      } catch (err) {
        this.opts.logger?.debug({ err: String(err) }, 'curl-impersonate unavailable');
        return false;
      }
    })();
    return this.available;
  }

  createSession(profile = this.profiles[0] ?? 'safari_ios'): SsoSession {
    return new CurlSession(profile, this.opts);
  }
}

class CurlSession implements SsoSession {
  private readonly pacer: Pacer;
  private client: Promise<{ http: CuimpHttpClient; impersonate: string[] }> | undefined;
  private tmpDir: string | undefined;

  constructor(
    readonly profile: string,
    private readonly opts: CurlTransportOptions,
  ) {
    this.pacer = new Pacer(opts);
  }

  get(url: string, req: SsoRequest = {}): Promise<SsoResponse> {
    return this.send('GET', url, req);
  }

  post(url: string, req: SsoRequest = {}): Promise<SsoResponse> {
    return this.send('POST', url, req);
  }

  async close(): Promise<void> {
    if (this.client) {
      const c = await this.client.catch(() => undefined);
      c?.http.destroy();
    }
    if (this.tmpDir) fs.rmSync(this.tmpDir, { recursive: true, force: true });
  }

  private getClient(): Promise<{ http: CuimpHttpClient; impersonate: string[] }> {
    this.client ??= (async () => {
      const spec = CURL_PROFILES[this.profile] ?? CURL_PROFILES.safari_ios!;
      const mod = await (this.opts.loadModule ?? loadCuimp)();
      const descriptor = { browser: spec.browser, ...(spec.platform ? { platform: spec.platform } : {}) };
      const logger = quietLogger(this.opts.logger);
      const core = new mod.Cuimp({ descriptor, autoDownload: this.opts.autoDownload ?? true, logger });
      const bin = await core.ensurePath();
      // The generic binary needs an explicit target; curl_<browser> wrappers set their own.
      const impersonate = path.basename(bin).startsWith('curl-impersonate') ? ['--impersonate', spec.target] : [];
      const http = mod.createCuimpHttp({ descriptor, path: bin, cookieJar: true, extraCurlArgs: impersonate, logger });
      return { http, impersonate };
    })();
    return this.client;
  }

  private bodyFile(body: string): string {
    // Never put the body on the command line: argv (and the password in it) is visible in `ps`.
    this.tmpDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'garmin-sso-'));
    const file = path.join(this.tmpDir, `body-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.writeFileSync(file, body, { mode: 0o600 });
    return file;
  }

  private async send(method: 'GET' | 'POST', rawUrl: string, req: SsoRequest): Promise<SsoResponse> {
    const { http, impersonate } = await this.getClient();
    await this.pacer.wait();
    const headers: Record<string, string> = { ...req.headers };
    const { body, contentType } = encodeBody(req);
    if (contentType && !hasHeader(headers, 'content-type')) headers['Content-Type'] = contentType;
    const file = body === undefined ? undefined : this.bodyFile(body);
    try {
      // Request-level extraCurlArgs replace the client defaults, so repeat the impersonation target.
      const res = await http.request<unknown>({
        url: withParams(rawUrl, req.params),
        method,
        headers,
        timeout: this.opts.timeoutMs ?? 30_000,
        ...(file ? { extraCurlArgs: [...impersonate, '--data-binary', `@${file}`] } : {}),
      });
      return makeResponse(res.status, res.headers, res.rawBody.toString('utf8'));
    } finally {
      if (file) fs.rmSync(file, { force: true });
    }
  }
}
