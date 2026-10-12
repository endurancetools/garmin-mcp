import { assertPrivate, ensurePrivateDir, type GarminConfig } from 'garmin-mcp-config';
import { createRuntime, type Runtime } from 'garmin-mcp-domain';
import { serveHttp, serveStdio } from './transports.js';

/**
 * Start the server with `config`. Checks file permissions first, then
 * serves. No sync starts on its own.
 */
export async function startServer(config: GarminConfig, runtime: Runtime = createRuntime(config)): Promise<void> {
  ensurePrivateDir(config.dataDir);
  assertPrivate(config.dataDir, 'dir');
  assertPrivate(config.tokensFile, 'file');

  const shutdown = () => {
    runtime.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  if (config.transport === 'streamable-http') await serveHttp(runtime);
  else await serveStdio(runtime);

  // Nothing is synced automatically: Garmin is contacted only on explicit requests.
  const status = await runtime.auth.status().catch(() => ({ loggedIn: false }));
  if (!status.loggedIn) {
    runtime.logger.warn('Not logged in to Garmin Connect; run `npx garmin-mcp-cli login` (tools will report AUTH_NOT_LOGGED_IN until then)');
  }
}
