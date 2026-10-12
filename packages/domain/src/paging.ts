import { InputError } from 'garmin-mcp-config';

/** Opaque cursors and size-capped pages for LLM responses (max 50 KB per page). */

export const MAX_PAGE_BYTES = 50 * 1024;

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const { o } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: unknown };
    if (typeof o === 'number' && Number.isInteger(o) && o >= 0) return o;
  } catch {
    // fall through
  }
  throw new InputError('Invalid cursor; pass the next_cursor value from the previous response unchanged.');
}

/** Take items from `offset` until the serialized page would exceed `maxBytes`. */
export function pageBySize<T>(items: readonly T[], offset: number, maxBytes = MAX_PAGE_BYTES): { page: T[]; next?: number } {
  const page: T[] = [];
  let bytes = 2;
  let i = offset;
  for (; i < items.length; i++) {
    const size = Buffer.byteLength(JSON.stringify(items[i])) + 1;
    if (page.length > 0 && bytes + size > maxBytes) break;
    page.push(items[i] as T);
    bytes += size;
  }
  return { page, next: i < items.length ? i : undefined };
}
