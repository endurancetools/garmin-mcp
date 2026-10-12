import fs from 'node:fs';
import { formatMode, type GarminConfig } from 'garmin-mcp-config';
import { findBrowser } from './browser-login.js';
import { curlAvailable, findCurlBinary } from './curl-transport.js';

export interface PathDiagnosis {
  path: string;
  exists: boolean;
  mode?: string;
  /** True when missing or private enough (0600 file / 0700 dir). */
  ok: boolean;
  symlink?: boolean;
}

export interface AuthDiagnosis {
  /** Browser used for the sign-in window, if one is installed. */
  browser?: string;
  /** The optional `cuimp` module loads. */
  curlAvailable: boolean;
  /** An already downloaded curl-impersonate binary, if any. */
  curlBinary?: string;
  ssoStrategy: GarminConfig['ssoStrategy'];
  hosts: GarminConfig['hosts'];
  tokensFile: PathDiagnosis;
  dataDir: PathDiagnosis;
}

function inspect(target: string, kind: 'file' | 'dir'): PathDiagnosis {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(target);
  } catch {
    return { path: target, exists: false, ok: true };
  }
  const symlink = st.isSymbolicLink();
  const loose = process.platform !== 'win32' && (st.mode & 0o077) !== 0;
  return {
    path: target,
    exists: true,
    mode: formatMode(st.mode),
    ok: !loose && !symlink && (kind === 'dir' ? st.isDirectory() : st.isFile()),
    ...(symlink ? { symlink } : {}),
  };
}

/** Local checks for `garmin doctor`; no network access. */
export async function diagnose(config: GarminConfig): Promise<AuthDiagnosis> {
  const available = await curlAvailable();
  const binary = available ? await findCurlBinary() : undefined;
  const browser = findBrowser(config.browserPath);
  return {
    ...(browser ? { browser } : {}),
    curlAvailable: available,
    ...(binary ? { curlBinary: binary } : {}),
    ssoStrategy: config.ssoStrategy,
    hosts: config.hosts,
    tokensFile: inspect(config.tokensFile, 'file'),
    dataDir: inspect(config.dataDir, 'dir'),
  };
}
