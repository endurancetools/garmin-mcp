/** Public contract of the auth layer. Everything else in this package is an implementation detail. */

export interface TokenProvider {
  /** Returns a valid DI access token, refreshing it first when it expires within 900 s. */
  getAccessToken(): Promise<string>;
  /** Called by the client after a 401 from connectapi; the next getAccessToken() forces a refresh. */
  invalidate(): Promise<void>;
}

export interface Credentials {
  email: string;
  password: string;
}

/** Receives the MFA method Garmin reports (e.g. "email", "sms", "totp") and returns the code. */
export type MfaCallback = (method: string) => Promise<string>;

export type SsoStrategyName = 'browser' | 'curl' | 'fetch' | 'import';

export interface LoginResult {
  strategy: SsoStrategyName;
  clientId: string;
  expiresAt: Date;
}

export interface AuthStatus {
  loggedIn: boolean;
  tokensFile: string;
  expiresAt?: Date;
  clientId?: string;
  obtainedAt?: Date;
}

export interface AuthService extends TokenProvider {
  login(creds: Credentials, mfa?: MfaCallback): Promise<LoginResult>;
  /**
   * Sign in through Garmin's own page in the user's browser. The
   * password never reaches this process. Rejects with BrowserUnavailableError
   * when no Chromium-based browser is installed.
   */
  loginWithBrowser(opts?: BrowserLoginOptions): Promise<LoginResult>;
  /** Import a token file written by python-garminconnect 0.3.x (or by us) into our tokens file. */
  importTokens(path: string): Promise<void>;
  status(): Promise<AuthStatus>;
  /** Delete the stored tokens. */
  logout(): Promise<void>;
}

export interface BrowserLoginOptions {
  /** Give up after this long; default 5 minutes. */
  timeoutMs?: number;
  /** Progress messages for the terminal ("opening Chrome", "waiting for sign-in"). */
  onStatus?: (message: string) => void;
}

/** On-disk token format, compatible with python-garminconnect's garmin_tokens.json. */
export interface StoredTokens {
  di_token: string;
  di_refresh_token: string | null;
  di_client_id: string | null;
  obtained_at?: string;
  service_url?: string;
  schema_version?: number;
}
