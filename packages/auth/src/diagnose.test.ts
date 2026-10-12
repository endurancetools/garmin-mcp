import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { diagnose } from './diagnose.js';
import { tempConfig } from './test-utils/index.js';
import { writeTokens } from './token-store.js';

describe('diagnose', () => {
  it('reports token file and data dir state', async () => {
    const config = tempConfig();
    let d = await diagnose(config);
    expect(d.tokensFile).toEqual({ path: config.tokensFile, exists: false, ok: true });
    expect(d.hosts.sso).toBe('https://sso.garmin.com');
    writeTokens(config.tokensFile, { di_token: 't', di_refresh_token: null, di_client_id: null });
    d = await diagnose(config);
    expect(d.tokensFile).toMatchObject({ exists: true, ok: true });
    expect(d.dataDir).toMatchObject({ exists: true, ok: true });
    expect(typeof d.curlAvailable).toBe('boolean');
  });

  it.skipIf(process.platform === 'win32')('flags loose permissions', async () => {
    const config = tempConfig();
    writeTokens(config.tokensFile, { di_token: 't', di_refresh_token: null, di_client_id: null });
    fs.chmodSync(config.tokensFile, 0o644);
    expect((await diagnose(config)).tokensFile).toMatchObject({ ok: false, mode: '644' });
  });
});
