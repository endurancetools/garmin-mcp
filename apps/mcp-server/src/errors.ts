import { GarminError } from 'garmin-mcp-config';
import { formatFieldPath } from 'garmin-mcp-domain';
import { ZodError } from 'zod';

export interface ToolError {
  code: string;
  message: string;
  hint?: string;
  issues?: { path: string; message: string }[];
}

/**
 * Map any failure to `{ code, message, hint }` so the model can explain it. Only
 * `InputError` and other `GarminError`s say the input was wrong; anything else, including a
 * TypeError or RangeError from the runtime or an unexpected Garmin response, is INTERNAL.
 */
export function toToolError(err: unknown): ToolError {
  if (err instanceof GarminError) {
    return { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) };
  }
  if (err instanceof ZodError) {
    return {
      code: 'INVALID_INPUT',
      message: 'Input failed validation',
      issues: err.issues.map((i) => ({ path: formatFieldPath(i.path), message: i.message })),
      hint: 'Fix the listed fields and call the tool again.',
    };
  }
  return { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err), hint: 'Unexpected error; check the server logs (stderr).' };
}
