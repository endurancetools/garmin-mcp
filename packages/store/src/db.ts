import Database from 'better-sqlite3';
import { ensurePrivateDir, assertPrivate } from 'garmin-mcp-config';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from './migrations.js';

export type Db = Database.Database;

/**
 * Open (and migrate) the SQLite file. WAL, one connection per process.
 * The database holds health data, so it gets the same 0600/0700 policy as tokens.
 */
export function openDatabase(file: string): Db {
  if (file !== ':memory:') {
    ensurePrivateDir(path.dirname(file));
    assertPrivate(file, 'file');
  }
  const db = new Database(file);
  if (file !== ':memory:') {
    for (const f of [file, `${file}-wal`, `${file}-shm`]) if (fs.existsSync(f)) fs.chmodSync(f, 0o600);
  }
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  // SQLite's lower() folds ASCII only; names are matched case-insensitively in any script ("Ślęża").
  db.function('unicode_lower', { deterministic: true }, (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : v));
  migrate(db);
  return db;
}

export function schemaVersion(db: Db): number {
  return db.pragma('user_version', { simple: true }) as number;
}

export function migrate(db: Db): void {
  const current = schemaVersion(db);
  if (current > MIGRATIONS.length) {
    throw new Error(`Database schema v${current} is newer than this version supports (v${MIGRATIONS.length}). Upgrade garmin-mcp.`);
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v] ?? '');
      db.pragma(`user_version = ${v + 1}`);
      db.prepare(`INSERT INTO meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
        String(v + 1),
      );
    })();
  }
}
