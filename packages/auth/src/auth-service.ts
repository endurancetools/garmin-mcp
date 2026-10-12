import fs from 'node:fs';
import path from 'node:path';
import type { GarminConfig, Logger } from 'garmin-mcp-config';
import { assertPrivate, nativeAppHeaders, silentLogger } from 'garmin-mcp-config';
import { CurlTransport } from './curl-transport.js';
import {
  AuthExpiredError,
  CloudflareBlockedError,
  InvalidCredentialsError,
  MfaRequiredError,
  NetworkError,
  NotLoggedInError,
} from './errors.js';
import { FetchTransport } from './fetch-transport.js';
import { jwtClientId, jwtExpiry } from './jwt.js';
import { browserSignIn } from './browser-login.js';
import { exchangeServiceTicket, mobileLogin, refreshDiToken, type FlowContext, type TokenSet } from './mobile-flow.js';
import { deleteTokens, importTokenFile, readTokens, writeTokens } from './token-store.js';
import type { SsoTransport } from './transport.js';
import type { AuthService, AuthStatus, BrowserLoginOptions, Credentials, LoginResult, MfaCallback, StoredTokens } from './types.js';

/** Refresh when the access token expires within this window. */
export const REFRESH_MARGIN_MS = 900_000;
/** A 401 right after a refresh is not the token's fault; don't refresh again. */
const INVALIDATE_GRACE_MS = 30_000;

export interface AuthServiceOptions {
  logger?: Logger;
  /** SSO transports in cascade order; defaults from `config.ssoStrategy`. */
  transports?: SsoTransport[];
  /** fetch used for token verification (and the default fetch transport). */
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Minimum gap between SSO requests of one session; default 3000 ms. */
  minIntervalMs?: number;
  /** Browser sign-in returning a service ticket; injectable for tests. */
  browserSignIn?: typeof browserSignIn;
}

type Verdict = 'ok' | 'rejected' | 'inconclusive';

export function createAuthService(config: GarminConfig, opts: AuthServiceOptions = {}): AuthService {
  return new GarminAuthService(config, opts);
}

class GarminAuthService implements AuthService {
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private tokens: StoredTokens | undefined;
  private loadedMtime: number | undefined;
  private refreshing: Promise<string> | undefined;
  private forceRefresh = false;
  private lastRefreshAt = 0;
  private transportCache: SsoTransport[] | undefined;

  constructor(
    private readonly config: GarminConfig,
    private readonly opts: AuthServiceOptions,
  ) {
    this.logger = opts.logger ?? silentLogger;
    this.now = opts.now ?? Date.now;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  // ---- TokenProvider -------------------------------------------------------

  async getAccessToken(): Promise<string> {
    if (this.refreshing) return this.refreshing;
    const tokens = this.load();
    if (!tokens) throw new NotLoggedInError(this.config.tokensFile);
    const expiry = jwtExpiry(tokens.di_token);
    const expiring = expiry !== undefined && expiry.getTime() - this.now() < REFRESH_MARGIN_MS;
    if (!this.forceRefresh && !expiring) return tokens.di_token;
    this.refreshing ??= this.refresh(tokens).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  invalidate(): Promise<void> {
    if (!this.refreshing && this.now() - this.lastRefreshAt > INVALIDATE_GRACE_MS) this.forceRefresh = true;
    return Promise.resolve();
  }

  // ---- AuthService ---------------------------------------------------------

  async login(creds: Credentials, mfa?: MfaCallback): Promise<LoginResult> {
    if (this.config.ssoStrategy === 'import') {
      throw new CloudflareBlockedError(
        'import',
        0,
        'Network login is disabled (GARMIN_SSO_STRATEGY=import)',
        'Import tokens instead: `garmin import-tokens <file>`.',
      );
    }
    const ctxBase = { config: this.config, logger: this.logger, now: this.now };
    let blocked: CloudflareBlockedError | undefined;
    let lastError: Error | undefined;
    let tried = 0;
    for (const transport of this.transports()) {
      if (!(await transport.isAvailable())) {
        this.logger.info({ strategy: transport.name }, 'SSO transport unavailable, skipping');
        continue;
      }
      for (const profile of transport.profiles) {
        tried++;
        const ctx: FlowContext = { ...ctxBase, strategy: transport.name };
        const session = transport.createSession(profile);
        this.logger.debug({ strategy: transport.name, profile }, 'trying SSO login');
        try {
          const tokens = await mobileLogin(session, creds, mfa, ctx);
          const verdict = await this.verify(tokens.accessToken);
          if (verdict === 'rejected') {
            this.logger.warn({ strategy: transport.name, profile }, 'token rejected by connectapi, trying next strategy');
            lastError = new NetworkError(`${transport.name}: token obtained but rejected by connectapi`);
            continue;
          }
          this.persist(tokens);
          return {
            strategy: transport.name,
            clientId: tokens.clientId,
            expiresAt: tokens.expiresAt ?? new Date(this.now() + 3_600_000),
          };
        } catch (err) {
          if (err instanceof InvalidCredentialsError || err instanceof MfaRequiredError) throw err;
          if (err instanceof CloudflareBlockedError) {
            this.logger.warn({ strategy: transport.name, profile, status: err.status }, 'SSO blocked');
            blocked = err;
          } else {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.warn({ strategy: transport.name, profile, err: msg }, 'SSO login attempt failed');
            lastError = err instanceof Error ? err : new NetworkError(msg);
          }
        } finally {
          await session.close().catch(() => undefined);
        }
      }
    }
    if (blocked) {
      throw new CloudflareBlockedError(
        blocked.strategy,
        blocked.status,
        `All login strategies were blocked by Garmin/Cloudflare (last: ${blocked.strategy}, HTTP ${blocked.status})`,
      );
    }
    if (lastError instanceof NetworkError) throw lastError;
    if (tried === 0) throw new NetworkError('No SSO transport is available (curl-impersonate missing and fetch disabled)');
    throw new NetworkError(`Login failed: ${lastError?.message ?? 'unknown error'}`, { cause: lastError });
  }

  async loginWithBrowser(opts: BrowserLoginOptions = {}): Promise<LoginResult> {
    const signIn = this.opts.browserSignIn ?? browserSignIn;
    const ticket = await signIn(this.config, {
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      ...(opts.onStatus ? { onStatus: opts.onStatus } : {}),
      logger: this.logger,
    });
    opts.onStatus?.('Signed in; exchanging the ticket for tokens...');
    const serviceUrl = this.config.hosts.portalServiceUrl;
    let tokens: TokenSet | undefined;
    let lastError: Error | undefined;
    for (const transport of await this.diauthTransports()) {
      const session = transport.createSession(transport.profiles[0]);
      try {
        tokens = await exchangeServiceTicket(session, ticket, { config: this.config, logger: this.logger, strategy: 'browser', now: this.now }, serviceUrl);
        break;
      } catch (err) {
        lastError = err instanceof Error ? err : new NetworkError(String(err));
        // Only a Cloudflare block is worth another transport; other failures mean the ticket was refused.
        if (!(err instanceof CloudflareBlockedError)) break;
      } finally {
        await session.close().catch(() => undefined);
      }
    }
    if (!tokens) throw lastError ?? new NetworkError('Ticket exchange failed');
    if ((await this.verify(tokens.accessToken)) === 'rejected') {
      throw new NetworkError('Garmin issued a token that connectapi rejects for this account', {
        cause: new Error('try `garmin login --strategy curl`'),
      });
    }
    this.persist(tokens, serviceUrl);
    return { strategy: 'browser', clientId: tokens.clientId, expiresAt: tokens.expiresAt ?? new Date(this.now() + 3_600_000) };
  }

  importTokens(source: string): Promise<void> {
    const imported = importTokenFile(source);
    writeTokens(this.config.tokensFile, {
      ...imported,
      di_client_id: imported.di_client_id ?? jwtClientId(imported.di_token) ?? null,
      obtained_at: imported.obtained_at ?? new Date(this.now()).toISOString(),
      schema_version: imported.schema_version ?? 1,
    });
    this.reset();
    return Promise.resolve();
  }

  status(): Promise<AuthStatus> {
    const tokens = this.load();
    const base: AuthStatus = { loggedIn: tokens !== undefined, tokensFile: this.config.tokensFile };
    if (!tokens) return Promise.resolve(base);
    const expiresAt = jwtExpiry(tokens.di_token);
    const clientId = tokens.di_client_id ?? jwtClientId(tokens.di_token);
    return Promise.resolve({
      ...base,
      ...(expiresAt ? { expiresAt } : {}),
      ...(clientId ? { clientId } : {}),
      ...(tokens.obtained_at ? { obtainedAt: new Date(tokens.obtained_at) } : {}),
    });
  }

  logout(): Promise<void> {
    deleteTokens(this.config.tokensFile);
    this.reset();
    return Promise.resolve();
  }

  // ---- internals -----------------------------------------------------------

  private transports(): SsoTransport[] {
    if (this.transportCache) return this.transportCache;
    const pacing = {
      ...(this.opts.minIntervalMs === undefined ? {} : { minIntervalMs: this.opts.minIntervalMs }),
      ...(this.opts.sleep ? { sleep: this.opts.sleep } : {}),
      now: this.now,
    };
    const all = this.opts.transports ?? [
      new CurlTransport({ ...pacing, logger: this.logger }),
      new FetchTransport({ ...pacing, fetch: this.fetchImpl }),
    ];
    const wanted = this.config.ssoStrategy;
    this.transportCache = wanted === 'auto' ? all : all.filter((t) => t.name === wanted);
    return this.transportCache;
  }

  private reset(): void {
    this.tokens = undefined;
    this.loadedMtime = undefined;
    this.forceRefresh = false;
  }

  /** Lazily read the tokens file; re-read when another process (e.g. `garmin login`) rewrote it. */
  private load(): StoredTokens | undefined {
    const file = this.config.tokensFile;
    let mtime: number | undefined;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      mtime = undefined;
    }
    if (mtime === undefined) {
      this.tokens = undefined;
      this.loadedMtime = undefined;
      return undefined;
    }
    if (this.tokens && this.loadedMtime === mtime) return this.tokens;
    if (path.dirname(file) === this.config.dataDir) assertPrivate(this.config.dataDir, 'dir');
    const replacing = this.tokens !== undefined;
    this.tokens = readTokens(file);
    this.loadedMtime = mtime;
    // Fresh tokens from another process supersede a pending invalidate().
    if (replacing) this.forceRefresh = false;
    return this.tokens;
  }

  private persist(tokens: TokenSet, serviceUrl: string = this.config.hosts.mobileServiceUrl): void {
    const stored: StoredTokens = {
      di_token: tokens.accessToken,
      di_refresh_token: tokens.refreshToken,
      di_client_id: tokens.clientId,
      obtained_at: new Date(this.now()).toISOString(),
      service_url: serviceUrl,
      schema_version: 1,
    };
    writeTokens(this.config.tokensFile, stored);
    this.tokens = stored;
    this.loadedMtime = fs.statSync(this.config.tokensFile).mtimeMs;
    this.forceRefresh = false;
  }

  private async refresh(current: StoredTokens): Promise<string> {
    const refreshToken = current.di_refresh_token;
    const clientId = current.di_client_id ?? jwtClientId(current.di_token);
    if (!refreshToken || !clientId) {
      throw new AuthExpiredError('The access token expired and no refresh token is stored');
    }
    let lastStatus = 0;
    for (const transport of await this.diauthTransports()) {
      const session = transport.createSession(transport.profiles[0]);
      try {
        const outcome = await refreshDiToken(session, refreshToken, clientId, {
          config: this.config,
          logger: this.logger,
          strategy: transport.name,
          now: this.now,
        });
        if (outcome.ok) {
          this.persist(outcome.tokens);
          this.lastRefreshAt = this.now();
          this.logger.debug({ strategy: transport.name }, 'access token refreshed');
          return outcome.tokens.accessToken;
        }
        lastStatus = outcome.status;
        if (!outcome.blocked) break;
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        lastStatus = 0;
        this.logger.warn({ strategy: transport.name, err: err instanceof Error ? err.message : String(err) }, 'refresh failed');
      } finally {
        await session.close().catch(() => undefined);
      }
    }
    if (lastStatus === 429 || lastStatus === 403) {
      throw new CloudflareBlockedError('fetch', lastStatus, `Token refresh blocked by Garmin/Cloudflare (HTTP ${lastStatus})`);
    }
    throw new NetworkError(`Token refresh failed${lastStatus ? ` (HTTP ${lastStatus})` : ''}`);
  }

  /** diauth is less protected than sso: plain fetch first, then curl-impersonate when available. */
  private async diauthTransports(): Promise<SsoTransport[]> {
    const all = this.opts.transports ?? [new CurlTransport({ logger: this.logger }), new FetchTransport({ fetch: this.fetchImpl, minIntervalMs: 0 })];
    const fetchT = all.find((t) => t.name === 'fetch') ?? new FetchTransport({ fetch: this.fetchImpl, minIntervalMs: 0 });
    const others: SsoTransport[] = [];
    // curl only when the user allowed it (auto/curl); it downloads a third-party binary on first use.
    const curlAllowed = this.config.ssoStrategy === 'auto' || this.config.ssoStrategy === 'curl';
    for (const t of all) if (t.name !== 'fetch' && curlAllowed && (await t.isAvailable())) others.push(t);
    return [fetchT, ...others];
  }

  /** One cheap connectapi call so a token the API tier rejects is never saved. */
  private async verify(accessToken: string): Promise<Verdict> {
    try {
      const res = await this.fetchImpl(`${this.config.hosts.connectapi}/userprofile-service/socialProfile`, {
        headers: { ...nativeAppHeaders(this.config.app), Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 401 || res.status === 403) return 'rejected';
      return res.ok ? 'ok' : 'inconclusive';
    } catch {
      return 'inconclusive';
    }
  }
}
