import { GarminError } from 'garmin-mcp-config';

/** Discriminated union of connectapi failures. Switch on `kind`. */
export type ClientError =
  | UnauthorizedError
  | ForbiddenError
  | NotFoundError
  | RateLimitedError
  | ValidationError
  | ClientNetworkError;

export class UnauthorizedError extends GarminError {
  readonly kind = 'unauthorized' as const;
  constructor(path: string) {
    super('UNAUTHORIZED', `Garmin rejected the access token twice for ${path}`, {
      hint: 'Tokens are no longer accepted. Log in again with `garmin login`.',
    });
  }
}

export class ForbiddenError extends GarminError {
  readonly kind = 'forbidden' as const;
  readonly cloudflare: boolean;
  constructor(path: string, cloudflare: boolean) {
    super(
      cloudflare ? 'CLOUDFLARE_BLOCKED' : 'FORBIDDEN',
      cloudflare
        ? `Cloudflare blocked the request to ${path}`
        : `Garmin refused access to ${path} (403)`,
      {
        hint: cloudflare
          ? 'Your network (VPN or datacenter IP) is being challenged by Cloudflare. Retry from a residential connection or later.'
          : 'The account may lack access to this data (privacy settings or unsupported device).',
      },
    );
    this.cloudflare = cloudflare;
  }
}

export class NotFoundError extends GarminError {
  readonly kind = 'not_found' as const;
  constructor(path: string) {
    super('NOT_FOUND', `Garmin returned 404 for ${path}`, { hint: 'Check the id or date.' });
  }
}

export class RateLimitedError extends GarminError {
  readonly kind = 'rate_limited' as const;
  /** Seconds to wait before retrying, when Garmin said so. */
  readonly retryAfter: number | undefined;
  constructor(path: string, retryAfter: number | undefined) {
    super('RATE_LIMITED', `Garmin rate limited ${path}`, {
      hint: `Wait ${retryAfter ? `${retryAfter} s` : 'a few minutes'} before retrying; answer from cached data meanwhile.`,
    });
    this.retryAfter = retryAfter;
  }
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export class ValidationError extends GarminError {
  readonly kind = 'validation' as const;
  readonly path: string;
  readonly issues: ValidationIssue[];
  constructor(path: string, issues: ValidationIssue[]) {
    super('VALIDATION', `Unexpected response shape from ${path}: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`, {
      hint: 'Garmin changed this endpoint. Update the schema in garmin-mcp-client.',
    });
    this.path = path;
    this.issues = issues;
  }
}

export class ClientNetworkError extends GarminError {
  readonly kind = 'network' as const;
  readonly status: number | undefined;
  constructor(path: string, detail: string, status?: number, cause?: unknown) {
    super('NETWORK', `Request to ${path} failed: ${detail}`, {
      hint: 'Garmin Connect is unreachable or failing. Retry later; cached data is still available.',
      cause,
    });
    this.status = status;
  }
}

export function isClientError(err: unknown): err is ClientError {
  return (
    err instanceof UnauthorizedError ||
    err instanceof ForbiddenError ||
    err instanceof NotFoundError ||
    err instanceof RateLimitedError ||
    err instanceof ValidationError ||
    err instanceof ClientNetworkError
  );
}
