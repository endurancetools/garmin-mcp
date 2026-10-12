import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InsecurePermissionsError } from 'garmin-mcp-config';
import { describe, expect, it } from 'vitest';
import { createAuthService } from './auth-service.js';
import { importTokenFile, readTokens, TokenFileError, writeTokens } from './token-store.js';
import { modeOf, tempConfig, tokenExpiringIn } from './test-utils/index.js';

const posix = process.platform !== 'win32';
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'garmin-tokens-'));

/** Exactly what python-garminconnect 0.3.x `Client.dumps()` writes. */
const garminconnectJson = (token: string) =>
  JSON.stringify({ di_token: token, di_refresh_token: 'py-refresh', di_client_id: 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2' });

describe('token store', () => {
  it('round-trips tokens as a 0600 file in a 0700 dir', () => {
    const file = path.join(tmpDir(), 'data', 'tokens.json');
    writeTokens(file, { di_token: 'a.b.c', di_refresh_token: 'r', di_client_id: 'c', obtained_at: '2026-10-08T00:00:00.000Z' });
    expect(readTokens(file)).toEqual({
      di_token: 'a.b.c',
      di_refresh_token: 'r',
      di_client_id: 'c',
      obtained_at: '2026-10-08T00:00:00.000Z',
      schema_version: 1,
    });
    expect(modeOf(file, 0o600)).toBe(0o600);
    expect(modeOf(path.dirname(file), 0o700)).toBe(0o700);
  });

  it('returns undefined for a missing file', () => {
    expect(readTokens(path.join(tmpDir(), 'nope.json'))).toBeUndefined();
  });

  it.skipIf(!posix)('refuses to read a token file with loose permissions', () => {
    const file = path.join(tmpDir(), 'tokens.json');
    writeTokens(file, { di_token: 't', di_refresh_token: null, di_client_id: null });
    fs.chmodSync(file, 0o644);
    expect(() => readTokens(file)).toThrow(InsecurePermissionsError);
  });

  it.skipIf(!posix)('rejects symlinks', () => {
    const dir = tmpDir();
    const real = path.join(dir, 'real.json');
    writeTokens(real, { di_token: 't', di_refresh_token: null, di_client_id: null });
    const link = path.join(dir, 'link.json');
    fs.symlinkSync(real, link);
    expect(() => readTokens(link)).toThrow(TokenFileError);
    expect(() => importTokenFile(link)).toThrow(TokenFileError);
  });

  it('imports garminconnect files from a path or a directory', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'garmin_tokens.json'), garminconnectJson('py.token.x'));
    const fromDir = importTokenFile(dir);
    expect(fromDir).toEqual({ di_token: 'py.token.x', di_refresh_token: 'py-refresh', di_client_id: 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2' });
    expect(importTokenFile(path.join(dir, 'garmin_tokens.json'))).toEqual(fromDir);
  });

  it('rejects files without DI tokens', () => {
    const file = path.join(tmpDir(), 'old.json');
    fs.writeFileSync(file, JSON.stringify({ oauth_token: 'legacy', oauth_token_secret: 'x' }));
    expect(() => importTokenFile(file)).toThrow(/DI tokens/);
    fs.writeFileSync(file, 'not json');
    expect(() => importTokenFile(file)).toThrow(TokenFileError);
  });

  it('AuthService.importTokens writes our tokens file and uses it', async () => {
    const config = tempConfig();
    const token = tokenExpiringIn(14_400, Date.now());
    const src = path.join(tmpDir(), 'garmin_tokens.json');
    fs.writeFileSync(src, garminconnectJson(token));
    const auth = createAuthService(config, { transports: [] });
    await auth.importTokens(src);
    expect(readTokens(config.tokensFile)).toMatchObject({ di_token: token, di_refresh_token: 'py-refresh', schema_version: 1 });
    await expect(auth.getAccessToken()).resolves.toBe(token);
    // Our file stays readable by python-garminconnect (extra keys are ignored there).
    const back = JSON.parse(fs.readFileSync(config.tokensFile, 'utf8'));
    expect(Object.keys(back)).toEqual(expect.arrayContaining(['di_token', 'di_refresh_token', 'di_client_id']));
  });
});
