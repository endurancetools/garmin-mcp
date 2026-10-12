import { writePrivateFile } from 'garmin-mcp-config';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface AccountInfo {
  /** Short stable hash of the Garmin account, used in the database file name. */
  hash: string;
  displayName: string | null;
  fullName: string | null;
}

export function accountHash(identity: { garminGUID?: string | null; profileId?: number | null; displayName?: string | null }): string {
  const key = identity.garminGUID ?? (identity.profileId ? String(identity.profileId) : null) ?? identity.displayName ?? 'default';
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

export function databasePath(dataDir: string, hash: string): string {
  return path.join(dataDir, `garmin-${hash}.db`);
}

const accountFile = (dataDir: string) => path.join(dataDir, 'account.json');

export function readAccount(dataDir: string): AccountInfo | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(accountFile(dataDir), 'utf8')) as Partial<AccountInfo>;
    return typeof parsed.hash === 'string' ? { hash: parsed.hash, displayName: parsed.displayName ?? null, fullName: parsed.fullName ?? null } : undefined;
  } catch {
    return undefined;
  }
}

/** Drop the cached account, e.g. on logout, so the next tokens cannot reuse another account's database. */
export function forgetAccount(dataDir: string): void {
  fs.rmSync(accountFile(dataDir), { force: true });
}

export function writeAccount(dataDir: string, info: AccountInfo): void {
  writePrivateFile(accountFile(dataDir), `${JSON.stringify(info, null, 2)}\n`);
}
