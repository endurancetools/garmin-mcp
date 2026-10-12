import type { IsoDate } from 'garmin-mcp-config';
import { round } from 'garmin-mcp-domain';
import { DEFAULT_LOAD_FLAGS } from './load.js';
import { seilerZoneByHr, type Session } from './session.js';
import { lt1For, type ThresholdPoint } from './thresholds.js';

/** Three-zone (Seiler) split of run and bike time over a period (spec 5.5). */
export interface IntensityDistribution {
  from: IsoDate;
  to: IsoDate;
  /** Minutes below LT1 (Garmin zones 1–2), between LT1 and LTHR (zone 3), above LTHR (zones 4–5). */
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
}

type IntensitySession = Pick<
  Session,
  'date' | 'sport' | 'duration_s' | 'avg_hr' | 'lthr_used' | 'z1_s' | 'z2_s' | 'z3_s' | 'z4_s' | 'z5_s'
>;

/**
 * Run and bike sessions of [from, to]: with Garmin zones, Z1 = zones 1–2, Z2 = 3, Z3 = 4–5;
 * without, the whole duration goes to the zone of the average HR against LT1 and the LTHR of
 * the session's sport and date. Sessions with neither zones nor HR are skipped.
 */
export function intensityDistribution(
  sessions: readonly IntensitySession[],
  thresholds: readonly ThresholdPoint[],
  from: IsoDate,
  to: IsoDate,
  z1MinPct: number = DEFAULT_LOAD_FLAGS.z1_min_pct,
): IntensityDistribution {
  let a = 0;
  let b = 0;
  let c = 0;
  let withZones = 0;
  let byHr = 0;
  for (const s of sessions) {
    if (s.date < from || s.date > to || (s.sport !== 'run' && s.sport !== 'bike')) continue;
    const [z1, z2, z3, z4, z5] = [s.z1_s ?? 0, s.z2_s ?? 0, s.z3_s ?? 0, s.z4_s ?? 0, s.z5_s ?? 0];
    if (z1 + z2 + z3 + z4 + z5 > 0) {
      a += z1 + z2;
      b += z3;
      c += z4 + z5;
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
  };
}
