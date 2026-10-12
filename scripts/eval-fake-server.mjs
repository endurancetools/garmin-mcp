#!/usr/bin/env node
// MCP server for the tool selection eval: the real tools, resources and instructions over stdio,
// with a GarminService fake that answers every read with an empty envelope. Nothing reaches
// Garmin or the user's cache. scripts/eval-tools.mjs points `claude -p` at it via --mcp-config.
//
//   pnpm nx build garmin-mcp-server
//   node scripts/eval-fake-server.mjs
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Runtime with destructive tools off and a service whose every method returns `{ data: {}, meta }`. */
export function fakeRuntime() {
  const empty = async () => ({ data: {}, meta: { source: 'cache' } });
  const service = new Proxy(
    { withAutoSync: (/** @type {() => Promise<unknown>} */ read) => read() },
    { get: (target, key) => (key in target ? target[/** @type {'withAutoSync'} */ (key)] : key === 'then' ? undefined : empty) },
  );
  // stdout carries the protocol, so the logger stays silent.
  const noop = () => undefined;
  return {
    config: { enabledTools: undefined, disabledTools: undefined, enableDestructive: false },
    logger: { debug: noop, info: noop, warn: noop, error: noop },
    service: async () => service,
    close: noop,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { serveStdio } = await import('garmin-mcp-server');
  await serveStdio(/** @type {never} */ (fakeRuntime()));
}
