import type { IsoDate } from 'garmin-mcp-config';
import { round } from 'garmin-mcp-domain';
import { DEFAULT_LOAD_FLAGS } from './load.js';
import { seilerZoneByHr, type Session } from './session.js';
import type { SportGroup } from './sport.js';
import { lt1For, type ProfileZoneFloors, type ThresholdPoint, type ZoneFloors } from './thresholds.js';

/** Sport groups whose time the intensity distribution counts: the endurance sports measured by HR. */
export const INTENSITY_SPORTS: readonly SportGroup[] = ['run', 'bike', 'nordic', 'row'];

/** Three-zone (Seiler) split of endurance time (run, bike, nordic, row) over a period (spec 5.5). */
export interface IntensityDistribution {
  from: IsoDate;
  to: IsoDate;
  /** Minutes below LT1, between LT1 and LTHR, above LTHR. */
  z1_min: number;
  z2_min: number;
  z3_min: number;
  /** Shares of the total, 1 place; absent without any time. */
  z1_pct?: number;
  z2_pct?: number;
  z3_pct?: number;
  /** Sessions split by Garmin HR zones and by average HR against LT1/LTHR. */
  sessions_with_zones: number;
  sessions_by_avg_hr: number;
  z1_min_pct: number;
  /** Z1 share under `z1_min_pct` (false without any time). */
  z1_below_target: boolean;
  /** Set when sessions with Garmin zones were mapped 1–2/3/4–5 for lack of profile zone bounds; the service moves it to `meta.note`. */
  note?: string;
}

/** Share of the bpm range [lo, hi] below LT1, between LT1 and LTHR, and from LTHR up. */
export function seilerShares(lo: number, hi: number, lt1: number, lthr: number): [number, number, number] {
  const a = Math.min(lt1, lthr);
  const width = hi - lo;
  const part = (from: number, to: number) => Math.max(0, Math.min(hi, to) - Math.max(lo, from)) / width;
  return [part(-Infinity, a), part(a, lthr), part(lthr, Infinity)];
}

/** Bounds [floor, ceiling] of Garmin's zones 1–5; zone 5 ends at HRmax. */
function zoneBounds(f: ZoneFloors): [number, number][] {
  const edges = [f.zone1Floor, f.zone2Floor, f.zone3Floor, f.zone4Floor, f.zone5Floor, f.maxHeartRateUsed];
  return edges.slice(0, 5).map((lo, i) => [lo, edges[i + 1] ?? lo]);
}

export const FIXED_ZONE_MAPPING_NOTE =
  'The Garmin profile has no HR zone bounds for some activities with time in zones; their Garmin zones 1-2, 3 and 4-5 are counted as Z1, Z2 and Z3.';

type IntensitySession = Pick<
  Session,
  'date' | 'sport' | 'duration_s' | 'avg_hr' | 'lthr_used' | 'z1_s' | 'z2_s' | 'z3_s' | 'z4_s' | 'z5_s'
>;

/**
 * Run, bike, nordic and row sessions of [from, to] (nordic and row use the running LTHR and LT1).
 * With Garmin zones and the profile's zone bounds of the sport (cycling: CYCLING, else DEFAULT),
 * each Garmin zone goes to Z1/Z2/Z3 by its bpm range against LT1 and the LTHR of the session's
 * sport and date: a zone crossing a threshold is split in proportion to its width in bpm. With zones but no bounds,
 * Z1 = zones 1–2, Z2 = 3, Z3 = 4–5 (and `note`). Without zones, the whole duration goes to the
 * zone of the average HR. Sessions with neither zones nor HR are skipped.
 */
export function intensityDistribution(
  sessions: readonly IntensitySession[],
  thresholds: readonly ThresholdPoint[],
  from: IsoDate,
  to: IsoDate,
  z1MinPct: number = DEFAULT_LOAD_FLAGS.z1_min_pct,
  floors: ProfileZoneFloors = {},
): IntensityDistribution {
  let a = 0;
  let b = 0;
  let c = 0;
  let withZones = 0;
  let byHr = 0;
  let fixed = false;
  for (const s of sessions) {
    if (s.date < from || s.date > to || !INTENSITY_SPORTS.includes(s.sport)) continue;
    const secs = [s.z1_s ?? 0, s.z2_s ?? 0, s.z3_s ?? 0, s.z4_s ?? 0, s.z5_s ?? 0];
    if (secs.some((t) => t > 0)) {
      const f = s.sport === 'bike' ? (floors.CYCLING ?? floors.DEFAULT) : floors.DEFAULT;
      if (f) {
        const lt1 = lt1For(thresholds, s.sport, s.date).value;
        zoneBounds(f).forEach(([lo, hi], i) => {
          const t = secs[i] ?? 0;
          const [p1, p2, p3] = seilerShares(lo, hi, lt1, s.lthr_used);
          a += t * p1;
          b += t * p2;
          c += t * p3;
        });
      } else {
        const [z1 = 0, z2 = 0, z3 = 0, z4 = 0, z5 = 0] = secs;
        a += z1 + z2;
        b += z3;
        c += z4 + z5;
        fixed = true;
      }
      withZones += 1;
      continue;
    }
    if (s.avg_hr === undefined || !(s.avg_hr > 0)) continue;
    const zone = seilerZoneByHr(s.avg_hr, lt1For(thresholds, s.sport, s.date).value, s.lthr_used);
    const dur = s.duration_s ?? 0;
    if (zone === 1) a += dur;
    else if (zone === 2) b += dur;
    else c += dur;
    byHr += 1;
  }
  const total = a + b + c;
  const share = (v: number) => (total > 0 ? round((v / total) * 100, 1) : undefined);
  const z1Pct = share(a);
  return {
    from,
    to,
    z1_min: round(a / 60, 0) ?? 0,
    z2_min: round(b / 60, 0) ?? 0,
    z3_min: round(c / 60, 0) ?? 0,
    z1_pct: z1Pct,
    z2_pct: share(b),
    z3_pct: share(c),
    sessions_with_zones: withZones,
    sessions_by_avg_hr: byHr,
    z1_min_pct: z1MinPct,
    z1_below_target: z1Pct !== undefined && z1Pct < z1MinPct,
    ...(fixed && { note: FIXED_ZONE_MAPPING_NOTE }),
  };
}
