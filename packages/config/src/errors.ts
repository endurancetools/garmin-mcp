/**
 * Base error for every layer. `code` is stable and machine readable, `hint` tells
 * the user (or the LLM relaying to the user) what to do next.
 */
export class GarminError extends Error {
  readonly code: string;
  readonly hint: string | undefined;

  constructor(code: string, message: string, options?: { hint?: string; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.hint = options?.hint;
  }
}

/** Bad input from a tool call or command: the message and hint are meant for the caller. */
export class InputError extends GarminError {
  constructor(message: string, hint?: string) {
    super('INVALID_INPUT', message, hint === undefined ? undefined : { hint });
  }
}

export class ConfigError extends GarminError {
  constructor(message: string, hint?: string) {
    super('CONFIG_INVALID', message, hint === undefined ? undefined : { hint });
  }
}

export class InsecurePermissionsError extends GarminError {
  readonly path: string;

  constructor(path: string, mode: number, expected: number) {
    super(
      'INSECURE_PERMISSIONS',
      `${path} has permissions ${formatMode(mode)}, expected ${formatMode(expected)} or stricter`,
      { hint: `Run: chmod ${formatMode(expected)} "${path}"` },
    );
    this.path = path;
  }
}

export function formatMode(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, '0');
}
