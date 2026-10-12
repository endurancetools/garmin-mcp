import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Client as V1Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport as V1StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

// The built package as clients start it (`node dist/main.js`): the test target depends on build.
// An empty data dir: nobody is logged in and tools/list never reaches Garmin.
const main = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const home = mkdtempSync(path.join(os.tmpdir(), 'garmin-mcp-protocol-'));
const server = {
  command: process.execPath,
  args: [main],
  // The parent's environment minus every GARMIN_* setting (Windows needs SystemRoot and friends to
  // start node at all), with a throwaway home so nothing of the developer's account is visible.
  env: {
    ...Object.fromEntries(Object.entries(process.env).filter(([k, v]) => !k.startsWith('GARMIN_') && v !== undefined)),
    HOME: home,
    USERPROFILE: home,
    GARMIN_DATA_DIR: path.join(home, 'data'),
    GARMIN_LOG_LEVEL: 'silent',
  },
  stderr: 'ignore' as const,
};
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('protocol eras over stdio', () => {
  it('serves a client on SDK 1.x through the 2025 initialize handshake', async () => {
    const client = new V1Client({ name: 'sdk-1', version: '1' });
    await client.connect(new V1StdioClientTransport(server));
    try {
      expect(client.getServerVersion()).toMatchObject({ name: 'garmin-mcp' });
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(17);
      expect(tools.find((t) => t.name === 'get_period_summary')?.outputSchema).toBeDefined();
    } finally {
      await client.close();
    }
  });

  it('serves 2026-07-28 with server/discover, server identity and list cache hints', async () => {
    const client = new Client({ name: 'sdk-2', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    await client.connect(new StdioClientTransport(server));
    try {
      expect(client.getProtocolEra()).toBe('modern');
      expect(client.getServerVersion()).toMatchObject({ name: 'garmin-mcp' });
      expect(client.getInstructions()).toContain('Garmin Connect');
      const cache = { ttlMs: 3_600_000, cacheScope: 'private' };
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(17);
      expect(tools).toMatchObject(cache);
      expect(await client.listResources()).toMatchObject(cache);
      expect(await client.listPrompts()).toMatchObject(cache);
    } finally {
      await client.close();
    }
  });
});
