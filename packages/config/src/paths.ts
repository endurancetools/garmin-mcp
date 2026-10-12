import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InsecurePermissionsError } from './errors.js';

/**
 * Expand `~`, `$HOME` and `${HOME}` (and any other `${VAR}`/`$VAR`). MCP clients
 * sometimes pass these literally, so we always resolve them ourselves.
 */
export function expandPath(input: string, env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
  let out = input.trim();
  if (out === '~') out = home;
  else if (out.startsWith('~/') || out.startsWith('~\\')) out = path.join(home, out.slice(2));
  out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, a?: string, b?: string) => {
    const name = a ?? b ?? '';
    if (name === 'HOME') return home;
    return env[name] ?? match;
  });
  return path.resolve(out);
}

const isWindows = process.platform === 'win32';

/** Create `dir` with mode 0700 if missing and tighten it if it already exists. */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!isWindows) fs.chmodSync(dir, 0o700);
}

/**
 * Refuse files or directories readable by group/others. Missing paths
 * pass. On Windows POSIX modes are meaningless, so the check is skipped.
 */
export function assertPrivate(target: string, kind: 'file' | 'dir'): void {
  if (isWindows) return;
  let st: fs.Stats;
  try {
    st = fs.statSync(target);
  } catch {
    return;
  }
  const expected = kind === 'dir' ? 0o700 : 0o600;
  if ((st.mode & 0o077) !== 0) throw new InsecurePermissionsError(target, st.mode, expected);
}

/** Atomically write a private (0600) file: temp file in the same dir, then rename. */
export function writePrivateFile(target: string, data: string | Uint8Array): void {
  ensurePrivateDir(path.dirname(target));
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
