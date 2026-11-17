import { detectClimbs, type ProfilePoint } from './climbs.js';
import { km, round } from './format.js';

/**
 * Courses of the account (`garmin://courses`, `garmin://course/{id}`) and the course of a
 * calendar event: the list entry in brief, and one course as its elevation profile in
 * {@link COURSE_PROFILE_SEGMENTS} stretches of equal length plus the climbs `detectClimbs` finds
 * in it. Coordinates only when asked (GARMIN_REDACT off).
 */

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const id = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined);

/** The profile of a course is cut into this many stretches of equal distance. */
export const COURSE_PROFILE_SEGMENTS = 20;

export interface CourseBrief {
  id?: number;
  name?: string;
  sport?: string;
  distance_km?: number;
  elevation_gain_m?: number;
}

/** One entry of Garmin's course list (`/course-service/course`). */
export function courseBrief(raw: unknown): CourseBrief {
  const c = obj(raw) ?? {};
  return {
    id: id(c.courseId),
    name: str(c.courseName),
    sport: str(obj(c.activityType)?.typeKey),
    distance_km: km(num(c.distanceInMeters)),
    elevation_gain_m: round(num(c.elevationGainInMeters), 0),
  };
}

/** The course list, newest first as Garmin gives it; anything but a list is no courses. */
export function courseList(raw: unknown): CourseBrief[] {
  return Array.isArray(raw) ? raw.map(courseBrief).filter((c) => c.id !== undefined) : [];
}

/** One course in brief from its detail (`/course-service/course/{id}`), for a course not in the list. */
export function courseBriefFromDetail(raw: unknown, sport?: string): CourseBrief {
  const c = obj(raw) ?? {};
  return { id: id(c.courseId), name: str(c.courseName), sport, distance_km: km(num(c.distanceMeter)), elevation_gain_m: round(num(c.elevationGainMeter), 0) };
}

export interface CourseSegment {
  start_km?: number;
  distance_km?: number;
  /** Elevation at the start of the stretch. */
  elevation_m?: number;
  elevation_gain_m?: number;
  elevation_loss_m?: number;
  /** Net: end minus start over the length. */
  avg_grade_pct?: number;
  lat?: number;
  lon?: number;
}

export interface CourseClimb {
  start_km?: number;
  distance_km?: number;
  elevation_gain_m?: number;
  avg_grade_pct: number;
  max_grade_pct: number;
}

export interface CourseDetail extends CourseBrief {
  elevation_loss_m?: number;
  min_elevation_m?: number;
  max_elevation_m?: number;
  start?: { lat?: number; lon?: number };
  profile: CourseSegment[];
  climbs: CourseClimb[];
}

interface Point extends ProfilePoint {
  lat?: number;
  lon?: number;
}

/** `geoPoints` with distance and elevation, in distance order (a point going back is skipped). */
function profilePoints(raw: unknown): Point[] {
  const list = Array.isArray(raw) ? raw : [];
  const points: Point[] = [];
  for (const item of list) {
    const p = obj(item);
    const d = num(p?.distance);
    const e = num(p?.elevation);
    if (d === undefined || e === undefined) continue;
    const last = points.at(-1);
    if (last && d < last.distance_m) continue;
    points.push({ distance_m: d, elevation_m: e, lat: num(p?.latitude), lon: num(p?.longitude) });
  }
  return points;
}

/** Elevation at distance `d`, linear between the neighbouring points; `from` is a search hint. */
function elevationAt(points: readonly Point[], d: number, from: number): { elevation: number; index: number } {
  let i = from;
  while (i < points.length - 2 && (points[i + 1]?.distance_m ?? Infinity) <= d) i++;
  const a = points[i] as Point;
  const b = points[i + 1] ?? a;
  const span = b.distance_m - a.distance_m;
  const t = span > 0 ? Math.min(1, Math.max(0, (d - a.distance_m) / span)) : 0;
  return { elevation: a.elevation_m + (b.elevation_m - a.elevation_m) * t, index: i };
}

const coord = (v: number | undefined) => round(v, 5);

/** The profile in {@link COURSE_PROFILE_SEGMENTS} equal stretches; gain and loss add up the point-to-point changes. */
function courseProfile(points: readonly Point[], coordinates: boolean): CourseSegment[] {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last || last.distance_m <= first.distance_m) return [];
  const length = (last.distance_m - first.distance_m) / COURSE_PROFILE_SEGMENTS;
  const segments: CourseSegment[] = [];
  let hint = 0;
  let k = 0;
  for (let s = 0; s < COURSE_PROFILE_SEGMENTS; s++) {
    const from = first.distance_m + s * length;
    const to = s === COURSE_PROFILE_SEGMENTS - 1 ? last.distance_m : from + length;
    const start = elevationAt(points, from, hint);
    const end = elevationAt(points, to, start.index);
    hint = start.index;
    // The elevations along the stretch: its start, every point inside, its end.
    while (k < points.length && (points[k]?.distance_m ?? Infinity) <= from) k++;
    const along = [start.elevation];
    for (let j = k; j < points.length && (points[j]?.distance_m ?? Infinity) < to; j++) along.push((points[j] as Point).elevation_m);
    along.push(end.elevation);
    let gain = 0;
    let loss = 0;
    for (let j = 1; j < along.length; j++) {
      const diff = (along[j] ?? 0) - (along[j - 1] ?? 0);
      if (diff > 0) gain += diff;
      else loss -= diff;
    }
    const at = points[start.index];
    segments.push({
      start_km: km(from - first.distance_m),
      distance_km: km(to - from),
      elevation_m: round(start.elevation, 0),
      elevation_gain_m: round(gain, 0),
      elevation_loss_m: round(loss, 0),
      avg_grade_pct: round(((end.elevation - start.elevation) / (to - from)) * 100, 1),
      ...(coordinates && { lat: coord(at?.lat), lon: coord(at?.lon) }),
    });
  }
  return segments;
}

/**
 * One course from its detail: distance and elevation from Garmin's totals, the lowest and
 * highest point, the profile and the climbs from `geoPoints`. `coordinates` adds the start and
 * the start of every stretch; without it the answer has no position at all.
 */
export function courseDetail(raw: unknown, opts: { coordinates: boolean; sport?: string }): CourseDetail {
  const c = obj(raw) ?? {};
  const points = profilePoints(c.geoPoints);
  const offset = points[0]?.distance_m ?? 0;
  const elevations = points.map((p) => p.elevation_m);
  const start = obj(c.startPoint) ?? (points[0] && { latitude: points[0].lat, longitude: points[0].lon });
  return {
    ...courseBriefFromDetail(raw, opts.sport),
    elevation_loss_m: round(num(c.elevationLossMeter), 0),
    min_elevation_m: elevations.length ? round(Math.min(...elevations), 0) : undefined,
    max_elevation_m: elevations.length ? round(Math.max(...elevations), 0) : undefined,
    start: opts.coordinates && start ? { lat: coord(num(start.latitude)), lon: coord(num(start.longitude)) } : undefined,
    profile: courseProfile(points, opts.coordinates),
    climbs: detectClimbs(points).map((cl) => ({
      start_km: km(cl.start_m - offset),
      distance_km: km(cl.length_m),
      elevation_gain_m: round(cl.gain_m, 0),
      avg_grade_pct: cl.avg_grade_pct,
      max_grade_pct: cl.max_grade_pct,
    })),
  };
}

/** The course of a calendar item (`courseId`, `courseName`), if one is assigned. */
export function eventCourseRef(raw: unknown): { id: number; name?: string } | undefined {
  const it = obj(raw);
  const courseId = id(it?.courseId);
  return courseId === undefined ? undefined : { id: courseId, name: str(it?.courseName) };
}
