import { describe, expect, it } from 'vitest';
import { courseDetail, courseList, eventCourseRef } from './courses.js';

describe('courses', () => {
  it('lists only entries with an id and reads anything but a list as no courses', () => {
    expect(courseList([{ courseId: 1, courseName: ' A ', distanceInMeters: 1234, elevationGainInMeters: 10.6, activityType: { typeKey: 'cycling' } }, { courseName: 'no id' }])).toEqual([
      { id: 1, name: 'A', sport: 'cycling', distance_km: 1.23, elevation_gain_m: 11 },
    ]);
    expect(courseList({ courses: [] })).toEqual([]);
  });

  it('has no profile and no climbs without usable points, and skips points going back', () => {
    expect(courseDetail({ courseId: 2, geoPoints: null }, { coordinates: true })).toMatchObject({ id: 2, profile: [], climbs: [] });
    const points = [
      { distance: 0, elevation: 100 },
      { distance: 500, elevation: 110 },
      { distance: 300, elevation: 900 },
      { distance: 1000, elevation: 100 },
    ];
    const detail = courseDetail({ courseId: 3, geoPoints: points }, { coordinates: false });
    expect(detail.max_elevation_m).toBe(110);
    expect(detail.profile).toHaveLength(20);
    expect(detail.profile.reduce((sum, s) => sum + (s.elevation_gain_m ?? 0), 0)).toBe(10);
    expect(detail.start).toBeUndefined();
  });

  it('reads the course of a calendar item', () => {
    expect(eventCourseRef({ courseId: 5, courseName: 'Loop' })).toEqual({ id: 5, name: 'Loop' });
    expect(eventCourseRef({ courseId: null, courseName: null })).toBeUndefined();
  });
});
