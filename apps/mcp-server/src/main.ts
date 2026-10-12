#!/usr/bin/env node
import { loadConfig, type RawConfig } from 'garmin-mcp-config';
import { startServer } from './start.js';

/** `garmin-mcp-server [--transport stdio|streamable-http] [--port N] [--host H]` */
function parseArgs(argv: string[]): RawConfig {
  const out: RawConfig = {};
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = (argv[i] ?? '').split('=', 2);
    const value = () => inline ?? argv[++i];
    if (flag === '--transport') out.transport = value();
    else if (flag === '--port') out.port = value();
    else if (flag === '--host') out.httpHost = value();
    else if (flag === '--data-dir') out.dataDir = value();
  }
  return out;
}

try {
  const config = loadConfig({ overrides: parseArgs(process.argv.slice(2)) });
  await startServer(config);
} catch (err) {
  const e = err as { message?: string; hint?: string };
  process.stderr.write(`garmin-mcp-server: ${e.message ?? String(err)}${e.hint ? `\n${e.hint}` : ''}\n`);
  process.exit(1);
}
