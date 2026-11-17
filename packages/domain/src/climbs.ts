/**
 * Climbs found in an elevation profile (distance and elevation, no time), for `get_activity`
 * with `bucket: "climbs"` and for course profiles. The rules are in `docs/analytics.md`
 * ("Climbs"); every number of them is here.
 */
export const CLIMB_RULES = {
  /** A climb is at least this long, ... */
  minLengthM: 500,
  /** ... this steep on average (net gain over length), ... */
  minAvgGradePct: 3,
  /** ... and gains at least this much from its foot to its top. */
  minGainM: 30,
  /** Climbing stretches at most this far apart (a flatter bit, a short dip) are one climb. */
  maxGapM: 200,
  /** The profile is resampled every this many metres of distance. */
  stepM: 10,
  /** Elevation is averaged over ± this distance before the climbing stretches are found. */
  smoothM: 50,
  /** A point is climbing when the grade over this window centred on it ... */
  gradeWindowM: 100,
  /** ... is at least this. */
  climbingGradePct: 2,
  /** Foot, top, gain and the steepest window are read from elevation averaged over ± this distance. */
  measureSmoothM: 20,
} as const;

export interface ProfilePoint {
  distance_m: number;
  elevation_m: number;
}

export interface Climb {
  /** Distance from the start of the profile to the foot and the top. */
  start_m: number;
  end_m: number;
  length_m: number;
  /** Top minus foot. */
  gain_m: number;
  avg_grade_pct: number;
  /** Steepest `gradeWindowM` of the climb. */
  max_grade_pct: number;
}

const finite = (v: number) => Number.isFinite(v);

/** Moving average over ± `half` grid points, cut at the ends. */
function smooth(values: readonly number[], half: number): number[] {
  return values.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(values.length - 1, i + half); j++) {
      sum += values[j] ?? 0;
      n++;
    }
    return sum / n;
  });
}

/**
 * Climbs of a profile in distance order: the profile is resampled every `stepM`, smoothed,
 * and the points where the grade over `gradeWindowM` is at least `climbingGradePct` form
 * climbing stretches; stretches up to `maxGapM` apart are merged, the foot and the top are
 * moved to the lowest and highest point near each end, and what passes the length, grade and
 * gain minimums is a climb. Points out of distance order or without numbers are skipped.
 */
export function detectClimbs(points: readonly ProfilePoint[]): Climb[] {
  const R = CLIMB_RULES;
  const ordered: ProfilePoint[] = [];
  for (const p of points) {
    if (!finite(p.distance_m) || !finite(p.elevation_m)) continue;
    const last = ordered.at(-1);
    if (last && p.distance_m < last.distance_m) continue;
    if (last && p.distance_m === last.distance_m) ordered[ordered.length - 1] = p;
    else ordered.push(p);
  }
  const first = ordered[0];
  const lastPoint = ordered.at(-1);
  if (!first || !lastPoint || lastPoint.distance_m - first.distance_m < R.minLengthM) return [];

  // Elevation on a regular distance grid, linear between the points.
  const n = Math.floor((lastPoint.distance_m - first.distance_m) / R.stepM) + 1;
  const raw: number[] = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const d = first.distance_m + k * R.stepM;
    while (j < ordered.length - 2 && (ordered[j + 1]?.distance_m ?? Infinity) < d) j++;
    const a = ordered[j] ?? first;
    const b = ordered[j + 1] ?? a;
    const span = b.distance_m - a.distance_m;
    raw.push(span > 0 ? a.elevation_m + ((b.elevation_m - a.elevation_m) * (d - a.distance_m)) / span : b.elevation_m);
  }
  const detect = smooth(raw, Math.round(R.smoothM / R.stepM));
  const measure = smooth(raw, Math.round(R.measureSmoothM / R.stepM));
  const half = Math.round(R.gradeWindowM / R.stepM / 2);
  const window = 2 * half;

  // Climbing stretches as [first, last] grid indices, merged across short gaps.
  const stretches: [number, number][] = [];
  for (let k = half; k < n - half; k++) {
    const grade = (((detect[k + half] ?? 0) - (detect[k - half] ?? 0)) / (window * R.stepM)) * 100;
    if (grade < R.climbingGradePct) continue;
    const open = stretches.at(-1);
    if (open && (k - open[1]) * R.stepM <= R.maxGapM) open[1] = k;
    else stretches.push([k, k]);
  }

  const climbs: Climb[] = [];
  for (const [a, b] of stretches) {
    // Foot: the last lowest point near the start; top: the first highest point near the end.
    let foot = Math.max(0, a - half);
    for (let k = foot; k <= Math.min(n - 1, a + half); k++) if ((measure[k] ?? 0) <= (measure[foot] ?? 0)) foot = k;
    let top = Math.max(0, b - half);
    for (let k = top; k <= Math.min(n - 1, b + half); k++) if ((measure[k] ?? 0) > (measure[top] ?? 0)) top = k;
    if (top <= foot) continue;
    const length = (top - foot) * R.stepM;
    const gain = (measure[top] ?? 0) - (measure[foot] ?? 0);
    const avg = (gain / length) * 100;
    if (length < R.minLengthM || avg < R.minAvgGradePct || gain < R.minGainM) continue;
    let steepest = -Infinity;
    for (let k = foot; k + window <= top; k++) steepest = Math.max(steepest, (((measure[k + window] ?? 0) - (measure[k] ?? 0)) / (window * R.stepM)) * 100);
    climbs.push({
      start_m: first.distance_m + foot * R.stepM,
      end_m: first.distance_m + top * R.stepM,
      length_m: length,
      gain_m: Math.round(gain * 10) / 10,
      avg_grade_pct: Math.round(avg * 10) / 10,
      max_grade_pct: Math.round(Math.max(steepest, avg) * 10) / 10,
    });
  }
  return climbs;
}
