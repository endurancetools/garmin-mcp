export interface JwtPayload {
  exp?: number;
  client_id?: string;
  [claim: string]: unknown;
}

function decodePart(part: string): unknown {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

/**
 * Decode a JWT payload without verifying the signature (Garmin holds the key).
 * Tokens claiming `alg: none` or with a malformed structure return undefined.
 */
export function decodeJwt(token: string): JwtPayload | undefined {
  const parts = token.split('.');
  if (parts.length < 2 || !parts[0] || !parts[1]) return undefined;
  try {
    const header = decodePart(parts[0]);
    if (typeof header !== 'object' || header === null) return undefined;
    const alg = (header as Record<string, unknown>).alg;
    if (typeof alg === 'string' && alg.toLowerCase() === 'none') return undefined;
    const payload = decodePart(parts[1]);
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
    return payload as JwtPayload;
  } catch {
    return undefined;
  }
}

/** `exp` as a Date, or undefined when absent or not a finite number. */
export function jwtExpiry(token: string): Date | undefined {
  const exp = decodeJwt(token)?.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return undefined;
  return new Date(exp * 1000);
}

export function jwtClientId(token: string): string | undefined {
  const id = decodeJwt(token)?.client_id;
  return typeof id === 'string' && id ? id : undefined;
}
