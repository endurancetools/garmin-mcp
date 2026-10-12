import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { accountHash, forgetAccount, readAccount, writeAccount } from './account.js';

describe('account cache', () => {
  it('gives each account its own hash and forgets the cached one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'garmin-account-'));
    const a = { hash: accountHash({ garminGUID: 'guid-a' }), displayName: 'a', fullName: null };
    expect(accountHash({ garminGUID: 'guid-b' })).not.toBe(a.hash);
    writeAccount(dir, a);
    expect(readAccount(dir)).toEqual(a);
    forgetAccount(dir);
    expect(readAccount(dir)).toBeUndefined();
    forgetAccount(dir);
  });
});
