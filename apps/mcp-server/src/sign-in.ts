import { BrowserLoginAbortedError, BrowserUnavailableError, findBrowser } from 'garmin-mcp-auth';
import { GarminError } from 'garmin-mcp-config';
import type { Runtime } from 'garmin-mcp-domain';
import { SIGN_IN_CODES } from 'garmin-mcp-store';

/**
 * How long a tool call waits for the user to finish signing in. Kept short: many clients give
 * a tool call 60 s, and the call that follows a sign-in still has its own download to wait for.
 */
export const SIGN_IN_WAIT_MS = 30_000;

/** The sign-in window is open and the user has not finished yet. */
export class SignInPendingError extends GarminError {
  constructor() {
    super('AUTH_SIGN_IN_PENDING', "Garmin's sign-in page is open in a browser window on the user's computer and waits for them", {
      hint:
        'Tell the user to finish signing in in that window (their password goes to Garmin only, never to this tool or to you) and to say when they are done; ' +
        'then call the tool again. Do not call it again before that.',
    });
  }
}

/**
 * Whether this server may open Garmin's sign-in page by itself: GARMIN_AUTO_LOGIN is on, the
 * server talks to a client on the same machine (stdio), the sign-in strategy allows the
 * browser, and one is installed. Checked per call, so a browser installed later counts.
 */
export function canSignIn(runtime: Pick<Runtime, 'config'>): boolean {
  const cfg = runtime.config;
  return cfg.autoLogin && cfg.transport === 'stdio' && (cfg.ssoStrategy === 'auto' || cfg.ssoStrategy === 'browser') && findBrowser(cfg.browserPath) !== undefined;
}

/** A failure only a new sign-in ends: no tokens, a refresh token Garmin no longer takes, tokens it rejects. */
function needsSignIn(err: unknown): boolean {
  return err instanceof GarminError && SIGN_IN_CODES.has(err.code);
}

/**
 * Open the sign-in window (or join the one already open) and wait for the user up to `waitMs`.
 * Resolves once they are signed in. Otherwise the caller gets an error that says what the
 * user has to do: finish in the window (it stays open after the wait), or ask again when it
 * was closed. Without a browser that starts, `cause` is thrown as it came.
 */
async function signIn(runtime: Runtime, cause: unknown, waitMs: number): Promise<void> {
  const pending = runtime.signIn({ onStatus: (message) => runtime.logger.info(message) });
  // The window outlives this call when the wait runs out; its outcome then belongs to a later call.
  pending.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const waited = new Promise<'waiting'>((resolve) => {
    timer = setTimeout(() => resolve('waiting'), waitMs);
  });
  try {
    if ((await Promise.race([pending, waited])) === 'waiting') throw new SignInPendingError();
  } catch (err) {
    if (err instanceof BrowserUnavailableError) {
      runtime.logger.warn({ msg: err.message }, 'cannot open the sign-in window');
      throw cause;
    }
    if (err instanceof BrowserLoginAbortedError && !err.refused) {
      throw new GarminError(err.code, err.message, {
        hint: 'The user closed the sign-in window or did not finish in time. Call the tool again only when they want to sign in; that opens the window again.',
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run a tool call; when it fails because nobody is signed in to Garmin, let the user sign in
 * in their browser and run it once more. With sign-in from the server unavailable (see
 * `canSignIn`) the call runs as it is and its error names `garmin login`.
 */
export async function withSignIn<T>(runtime: Runtime, call: () => Promise<T>, waitMs: number = SIGN_IN_WAIT_MS): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (!needsSignIn(err) || !canSignIn(runtime)) throw err;
    await signIn(runtime, err, waitMs);
    return call();
  }
}
