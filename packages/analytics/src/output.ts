/**
 * MCP `outputSchema` of the analytics tools, in the style of `garmin-mcp-domain`'s output
 * schemas: the `{ data, meta }` envelope that `AnalyticsService` returns, every object loose
 * and nearly every field optional (`compact` drops empty values, and a result that fails its
 * schema reaches the client as an error). Rule and flag objects are open records.
 */
import { responseMetaSchema } from 'garmin-mcp-domain';
import { z } from 'zod';

const str = z.string().optional();
const num = z.number().optional();
const bool = z.boolean().optional();
const list = <T extends z.ZodType>(item: T) => z.array(item).optional();
const obj = <S extends z.core.$ZodLooseShape>(shape: S) => z.looseObject(shape).optional();
/** `rules_used`, `flags_used`: named numbers, documented in the input description. */
const numbers = obj({});
const values = z.record(z.string(), z.union([z.number(), z.string()])).optional();

function envelope<S extends z.core.$ZodLooseShape>(data: S) {
  return z.looseObject({ data: z.looseObject(data), meta: responseMetaSchema });
}

const loadDay = { date: str, tss: num, ctl: num, atl: num, tsb: num, acwr: num, monotony: num, strain: num, warming_up: bool };

const session = z.looseObject({
  id: z.union([z.number(), z.string()]),
  date: str,
  week: str,
  start_local: str,
  type: str,
  sport: str,
  name: str,
  event_type: str,
  duration_s: num,
  moving_s: num,
  distance_m: num,
  elev_gain_m: num,
  elev_loss_m: num,
  avg_hr: num,
  max_hr: num,
  avg_power_w: num,
  np_w: num,
  avg_cadence: num,
  calories: num,
  g_load: num,
  aerobic_te: num,
  anaerobic_te: num,
  rpe: num,
  feel: num,
  if: num,
  hrtss: num,
  ef: num,
  ef_gap: num,
  gap_mps: num,
  z1_s: num,
  z2_s: num,
  z3_s: num,
  z4_s: num,
  z5_s: num,
  lthr_used: num,
  rhr_used: num,
  source: str,
});

const sportThresholds = obj({ lthr: num, lt1: num, lthr_note: str, lt1_note: str });
/** `by_sport` of `get_thresholds`, also `thresholds_used.by_sport` of `get_load`. */
const bySport = obj({ run: sportThresholds, bike: sportThresholds, swim: sportThresholds });

export const loadOutput = envelope({
  from: str,
  to: str,
  source: str,
  latest: obj(loadDay),
  flags: list(z.looseObject({ code: z.string(), text: z.string() })),
  flags_used: numbers,
  weeks: list(
    z.looseObject({
      week: str,
      sport: str,
      sessions: num,
      hours: num,
      km: num,
      elev_m: num,
      hrtss: num,
      g_load: num,
      z12_h: num,
      z3_h: num,
      z45_h: num,
    }),
  ),
  intensity: obj({
    from: str,
    to: str,
    z1_min: num,
    z2_min: num,
    z3_min: num,
    z1_pct: num,
    z2_pct: num,
    z3_pct: num,
    sessions_with_zones: num,
    sessions_by_avg_hr: num,
    z1_min_pct: num,
    z1_below_target: bool,
  }),
  thresholds_used: obj({ date: str, by_sport: bySport, rhr: num }),
  series: list(z.looseObject(loadDay)),
  activities: list(session),
  efficiency: list(z.looseObject({ period: str, sport: str, n: num, ef_avg: num, ef_max: num, ef_gap_avg: num })),
  note: str,
});

export const readinessOutput = envelope({
  date: str,
  decision: z.enum(['GO', 'MODIFY', 'REST']).optional(),
  counts: obj({ ok: num, yellow: num, red: num, unknown: num }),
  signals: list(
    z.looseObject({
      name: z.string(),
      rating: z.enum(['ok', 'yellow', 'red', 'unknown']),
      value: values,
      reference: values,
      detail: str,
    }),
  ),
  partial: bool,
  rules_used: numbers,
  recommendation: list(z.string()),
});

const effective = { value: num, since: str, source: str, note: str };
const thresholdRow = z.looseObject({ date: str, param: str, value: num, source: str, note: str });

export const thresholdsOutput = envelope({
  date: str,
  effective: z.record(z.string(), z.looseObject(effective)).optional(),
  history: list(thresholdRow),
  by_sport: bySport,
  hrmax: obj({ value: num, note: str }),
  rhr_28d: obj({ value: num, samples: num, note: str }),
});

export const setThresholdOutput = envelope({
  added: bool,
  row: thresholdRow.optional(),
  effective: obj({ date: str, param: str, ...effective }),
  note: str,
});
