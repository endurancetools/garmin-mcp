import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { AuthService } from 'garmin-mcp-auth';
import { loadConfig, silentLogger } from 'garmin-mcp-config';
import { readFitFile, type GarminService, type Runtime } from 'garmin-mcp-domain';
import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { createMcpServer } from './index.js';

// The FIT parser (garmin-mcp-fit and its dependency) is loaded on the first FIT file only:
// the mock factory runs when something imports the module, so it records that moment.
const fit = vi.hoisted(() => ({ loaded: false }));
vi.mock('../../../packages/fit/src/index.ts', async (importOriginal) => {
  fit.loaded = true;
  return importOriginal();
});

describe('FIT parser loading', () => {
  it('is not loaded by the server start or tools/list, only by the first FIT file', async () => {
    const account = { hash: 'x', displayName: null, fullName: null };
    const runtime: Runtime = {
      config: { ...loadConfig({ env: { HOME: os.tmpdir() } }), autoLogin: false },
      logger: silentLogger,
      auth: {} as AuthService,
      client: {} as Runtime['client'],
      service: async () => ({}) as GarminService,
      account: async () => account,
      signIn: async () => account,
      close: () => undefined,
    };
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([createMcpServer(runtime).connect(a), client.connect(b)]);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    expect(fit.loaded).toBe(false);

    // The parser's own refusal, so the module really loaded (a failed import would say "Cannot find").
    await expect(readFitFile(new Uint8Array())).rejects.toThrow(/FIT/);
    expect(fit.loaded).toBe(true);
  });
});
