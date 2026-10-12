import { GarminError } from 'garmin-mcp-config';
import { PYTHON_FALLBACK_COMMAND } from './python-fallback.js';
import type { SsoStrategyName } from './types.js';

const LOGIN_HINT = 'Run `garmin login` (or `npx garmin-mcp-cli login`) to sign in again.';

export class InvalidCredentialsError extends GarminError {
  readonly kind = 'invalid_credentials' as const;

  constructor(message = 'Garmin rejected the email or password') {
    super('AUTH_INVALID_CREDENTIALS', message, {
      hint: 'Check the email and password, then run `garmin login` again. Too many attempts can lock the account.',
    });
  }
}

export class MfaRequiredError extends GarminError {
  readonly kind = 'mfa_required' as const;
  readonly method: string;

  constructor(method: string) {
    super('AUTH_MFA_REQUIRED', `Garmin requires a multi-factor code (${method})`, {
      hint: 'Run `garmin login` in a terminal so the code can be entered interactively.',
    });
    this.method = method;
  }
}

export class CloudflareBlockedError extends GarminError {
  readonly kind = 'cloudflare_blocked' as const;
  readonly strategy: SsoStrategyName;
  readonly status: number;

  constructor(strategy: SsoStrategyName, status: number, message?: string, hint?: string) {
    super(
      'AUTH_CLOUDFLARE_BLOCKED',
      message ?? `Garmin SSO blocked the request (strategy ${strategy}, HTTP ${status})`,
      {
        hint:
          hint ??
          'Garmin/Cloudflare is rate limiting or fingerprint-blocking this client. Wait 15-60 minutes and retry ' +
            '`garmin login`, try another network (no VPN), or log in with the python-garminconnect login script and import the tokens: ' +
            `${PYTHON_FALLBACK_COMMAND} (then \`garmin import-tokens <file>\`).`,
      },
    );
    this.strategy = strategy;
    this.status = status;
  }
}

export class AuthExpiredError extends GarminError {
  readonly kind = 'auth_expired' as const;

  constructor(message = 'The Garmin refresh token is no longer valid', options?: { cause?: unknown }) {
    super('AUTH_EXPIRED', message, { hint: LOGIN_HINT, cause: options?.cause });
  }
}

export class NetworkError extends GarminError {
  readonly kind = 'network' as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super('AUTH_NETWORK', message, {
      hint: 'Check the internet connection and that sso.garmin.com / diauth.garmin.com are reachable (`garmin doctor`).',
      cause: options?.cause,
    });
  }
}

export class NotLoggedInError extends GarminError {
  readonly kind = 'not_logged_in' as const;

  constructor(tokensFile: string) {
    super('AUTH_NOT_LOGGED_IN', `No Garmin tokens found at ${tokensFile}`, {
      hint: 'Run `garmin login` (or `npx garmin-mcp-cli login`) once, or `garmin import-tokens <file>` with tokens from python-garminconnect.',
    });
  }
}

export type AuthError =
  | InvalidCredentialsError
  | MfaRequiredError
  | CloudflareBlockedError
  | AuthExpiredError
  | NetworkError
  | NotLoggedInError;

export function isAuthError(err: unknown): err is AuthError {
  return (
    err instanceof InvalidCredentialsError ||
    err instanceof MfaRequiredError ||
    err instanceof CloudflareBlockedError ||
    err instanceof AuthExpiredError ||
    err instanceof NetworkError ||
    err instanceof NotLoggedInError
  );
}
