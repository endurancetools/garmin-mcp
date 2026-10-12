import fs from 'node:fs';
import path from 'node:path';
import { assertPrivate, GarminError, writePrivateFile } from 'garmin-mcp-config';
import { z } from 'zod';
import type { StoredTokens } from './types.js';

export const TOKENS_SCHEMA_VERSION = 1;
/** File name python-garminconnect uses inside a token directory. */
export const GARMINCONNECT_TOKEN_FILE = 'garmin_tokens.json';

const storedTokensSchema = z
  .object({
    di_token: z.string().min(1),
    di_refresh_token: z.string().min(1).nullable().optional(),
    di_client_id: z.string().min(1).nullable().optional(),
    obtained_at: z.string().optional(),
    service_url: z.string().optional(),
    schema_version: z.number().int().optional(),
  })
  .loose();

export class TokenFileError extends GarminError {
  constructor(message: string, hint?: string) {
    super('AUTH_TOKEN_FILE_INVALID', message, hint === undefined ? undefined : { hint });
  }
}

function rejectSymlink(file: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) {
    throw new TokenFileError(`${file} is a symlink; refusing to use it`, 'Point the tokens path at a regular file.');
  }
}

export function parseTokens(text: string, source: string): StoredTokens {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new TokenFileError(`${source} is not valid JSON`);
  }
  const parsed = storedTokensSchema.safeParse(json);
  if (!parsed.success) {
    throw new TokenFileError(
      `${source} does not contain Garmin DI tokens (expected di_token, di_refresh_token, di_client_id)`,
      'Create it with `garmin login`, or with python-garminconnect >= 0.3 (older OAuth1 token files no longer work).',
    );
  }
  const t = parsed.data;
  return {
    di_token: t.di_token,
    di_refresh_token: t.di_refresh_token ?? null,
    di_client_id: t.di_client_id ?? null,
    ...(t.obtained_at === undefined ? {} : { obtained_at: t.obtained_at }),
    ...(t.service_url === undefined ? {} : { service_url: t.service_url }),
    ...(t.schema_version === undefined ? {} : { schema_version: t.schema_version }),
  };
}

/** Read our tokens file. Missing file → undefined; loose permissions → InsecurePermissionsError. */
export function readTokens(file: string): StoredTokens | undefined {
  rejectSymlink(file);
  if (!fs.existsSync(file)) return undefined;
  assertPrivate(file, 'file');
  return parseTokens(fs.readFileSync(file, 'utf8'), file);
}

/** Write tokens atomically as 0600 inside a 0700 directory. */
export function writeTokens(file: string, tokens: StoredTokens): void {
  rejectSymlink(file);
  const out: StoredTokens = { ...tokens, schema_version: tokens.schema_version ?? TOKENS_SCHEMA_VERSION };
  writePrivateFile(file, `${JSON.stringify(out, null, 2)}\n`);
}

export function deleteTokens(file: string): void {
  rejectSymlink(file);
  fs.rmSync(file, { force: true });
}

/**
 * Load a token file produced by python-garminconnect 0.3.x (`garmin_tokens.json`, or the
 * directory containing it) or by this package.
 */
export function importTokenFile(source: string): StoredTokens {
  let file = path.resolve(source);
  rejectSymlink(file);
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, GARMINCONNECT_TOKEN_FILE);
  rejectSymlink(file);
  if (!fs.existsSync(file)) throw new TokenFileError(`Token file not found: ${file}`);
  return parseTokens(fs.readFileSync(file, 'utf8'), file);
}
