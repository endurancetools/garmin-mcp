import { createAuthService, type AuthService } from 'garmin-mcp-auth';
import { GarminClient } from 'garmin-mcp-client';
import { createLogger, type GarminConfig, type Logger } from 'garmin-mcp-config';
import { accountHash, databasePath, readAccount, Store, Syncer, SyncJobRunner, writeAccount, type AccountInfo } from 'garmin-mcp-store';
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

  const account = async (opts: { fresh?: boolean } = {}): Promise<AccountInfo> => {
    const cached = opts.fresh ? undefined : readAccount(config.dataDir);
    if (cached) return cached;
    const profile = await client.getProfile();
    const info: AccountInfo = { hash: accountHash(profile), displayName: profile.displayName ?? null, fullName: profile.fullName ?? null };
    writeAccount(config.dataDir, info);
    return info;
  };

  return {
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
          downloadDir: config.fitDownloadDir ?? path.join(config.dataDir, 'downloads'),
          logger: logger.child({ layer: 'domain' }),
        });
      })().catch((err: unknown) => {
        service = undefined;
        throw err;
      });
      return service;
    },
    close() {
      store?.close();
    },
  };
}
