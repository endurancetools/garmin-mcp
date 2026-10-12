import { addDays, type IsoDate } from 'garmin-mcp-config';

/** Sorted, non-overlapping, non-adjacent inclusive date ranges. */
export type RangeSet = [IsoDate, IsoDate][];

/** Add [from, to], merging overlapping and adjacent ranges. */
export function addRange(set: RangeSet, from: IsoDate, to: IsoDate): RangeSet {
  const all = [...set, [from, to] as [IsoDate, IsoDate]].toSorted((a, b) => a[0].localeCompare(b[0]));
  const out: RangeSet = [];
  for (const [a, b] of all) {
    const last = out.at(-1);
    if (last && a <= addDays(last[1], 1)) {
      if (b > last[1]) last[1] = b;
    } else out.push([a, b]);
  }
  return out;
}

/** Parts of [from, to] not covered by `set`. */
export function gaps(set: RangeSet, from: IsoDate, to: IsoDate): RangeSet {
  const out: RangeSet = [];
  let cursor = from;
  for (const [a, b] of set) {
    if (b < cursor) continue;
    if (a > to) break;
    if (a > cursor) out.push([cursor, addDays(a, -1) < to ? addDays(a, -1) : to]);
    cursor = addDays(b, 1);
    if (cursor > to) return out;
  }
  if (cursor <= to) out.push([cursor, to]);
  return out;
}

export function parseRangeSet(json: string | undefined): RangeSet {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? (v.filter((r) => Array.isArray(r) && r.length === 2) as RangeSet) : [];
  } catch {
    return [];
  }
}
