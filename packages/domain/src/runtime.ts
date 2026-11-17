import { createAuthService, type AuthService, type BrowserLoginOptions } from 'garmin-mcp-auth';
import { GarminClient } from 'garmin-mcp-client';
import { createLogger, type GarminConfig, type Logger } from 'garmin-mcp-config';
import { accountHash, clearSignInPause, databasePath, readAccount, Store, Syncer, SyncJobRunner, writeAccount, type AccountInfo } from 'garmin-mcp-store';
import path from 'node:path';
import { GarminService } from './service.js';

/**
 * Wires the layers together for one account: auth → client → store → domain.
 * The store opens lazily, because its file name depends on the account and the
 * first start may need a profile request to learn it.
 */
export interface Runtime {
  config: GarminConfig;
  logger: Logger;
  auth: AuthService;
  client: GarminClient;
  /** Opens the store on first use. Throws auth errors when not logged in. */
  service(): Promise<GarminService>;
  /**
   * The account behind the tokens, cached in `account.json`. `fresh` asks Garmin again and
   * rewrites the cache; login and token import use it, because new tokens may be another account's.
   */
  account(opts?: { fresh?: boolean }): Promise<AccountInfo>;
  /**
   * Sign in through Garmin's own page in the user's browser, for a long-running process such as
   * the MCP server: afterwards the runtime follows the new tokens. The account is asked afresh
   * (the tokens may be another account's, which gets its own database), and a sync pause that
   * began because nobody was signed in ends. One sign-in at a time: a call during a running one
   * joins it.
   */
  signIn(opts?: BrowserLoginOptions): Promise<AccountInfo>;
  close(): void;
}

export interface RuntimeOptions {
  logger?: Logger;
  auth?: AuthService;
  budgetMs?: number;
}

export function createRuntime(config: GarminConfig, options: RuntimeOptions = {}): Runtime {
  const logger = options.logger ?? createLogger(config.logLevel);
  const auth = options.auth ?? createAuthService(config, { logger: logger.child({ layer: 'auth' }) });
  const client = new GarminClient(config, auth, { logger: logger.child({ layer: 'client' }) });
  let store: Store | undefined;
  let service: Promise<GarminService> | undefined;
  let signingIn: Promise<AccountInfo> | undefined;

  const account = async (opts: { fresh?: boolean } = {}): Promise<AccountInfo> => {
    const cached = opts.fresh ? undefined : readAccount(config.dataDir);
    if (cached) return cached;
    const profile = await client.getProfile();
    const info: AccountInfo = { hash: accountHash(profile), displayName: profile.displayName ?? null, fullName: profile.fullName ?? null };
    writeAccount(config.dataDir, info);
    return info;
  };

  const runtime: Runtime = {
    config,
    logger,
    auth,
    client,
    account,
    service() {
      service ??= (async () => {
        const info = await account();
        store = Store.open(databasePath(config.dataDir, info.hash));
        store.abandonRunningSyncs(Date.now());
        const syncer = new Syncer(client, store, {
          timeZone: config.timezone,
          concurrency: config.concurrency,
          // Reads never fetch past the job runner's limits; auto sync goes through jobs (withAutoSync).
          fetchOnDemand: false,
          // Lazy intraday fetches run outside the jobs but share their daily request cap.
          maxRequestsPerDay: config.syncMaxRequestsPerDay,
          logger: logger.child({ layer: 'sync' }),
        });
        const jobs = new SyncJobRunner(syncer, store, {
          chunkDays: config.syncChunkDays,
          pause: config.syncPause,
          maxRequestsPerDay: config.syncMaxRequestsPerDay,
          timeZone: config.timezone,
          logger: logger.child({ layer: 'sync' }),
        });
        return new GarminService({
          client,
          store,
          syncer,
          jobs,
          timeZone: config.timezone,
          budgetMs: options.budgetMs,
          autoSync: config.autoFetch,
          redact: config.redact,
          downloadDir: config.fitDownloadDir ?? path.join(config.dataDir, 'downloads'),
          logger: logger.child({ layer: 'domain' }),
        });
      })().catch((err: unknown) => {
        service = undefined;
        throw err;
      });
      return service;
    },
    signIn(opts = {}) {
      signingIn ??= (async () => {
        await auth.loginWithBrowser(opts);
        client.forgetProfile();
        const before = readAccount(config.dataDir)?.hash;
        const info = await account({ fresh: true });
        if (service && before !== info.hash) {
          // Another account signed in: its data lives in its own database.
          await service.catch(() => undefined);
          store?.close();
          store = undefined;
          service = undefined;
        }
        clearSignInPause((await runtime.service()).store);
        return info;
      })().finally(() => {
        signingIn = undefined;
      });
      return signingIn;
    },
    close() {
      store?.close();
    },
  };
  return runtime;
}
