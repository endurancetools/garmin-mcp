import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { InsecurePermissionsError } from './errors.js';
import { assertPrivate, writePrivateFile } from './paths.js';

describe.skipIf(process.platform === 'win32')('private files', () => {
  it('writes 0600 files in 0700 dirs and detects loose permissions', () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'garmin-perm-')), 'data');
    const file = path.join(dir, 'tokens.json');
    writePrivateFile(file, '{}');
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(() => assertPrivate(file, 'file')).not.toThrow();
    fs.chmodSync(file, 0o644);
    expect(() => assertPrivate(file, 'file')).toThrow(InsecurePermissionsError);
  });
});
