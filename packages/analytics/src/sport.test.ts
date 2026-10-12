import { describe, expect, it } from 'vitest';
import { sportGroup, type SportGroup } from './sport.js';

// Control list: every type key of `sport_group` in plan-v2 `scripts/lib.sh`.
const CONTROL: Record<Exclude<SportGroup, 'other'>, string[]> = {
  run: ['running', 'trail_running', 'treadmill_running', 'track_running', 'street_running', 'ultra_run', 'virtual_run', 'indoor_running'],
  bike: [
    'cycling',
    'indoor_cycling',
    'virtual_ride',
    'road_biking',
    'mountain_biking',
    'gravel_cycling',
    'cyclocross',
    'bmx',
    'track_cycling',
    'e_bike_fitness',
    'recumbent_cycling',
  ],
  swim: ['lap_swimming', 'open_water_swimming', 'swimming'],
  strength: ['strength_training', 'indoor_cardio', 'hiit', 'yoga', 'pilates', 'stretching', 'mobility', 'breathwork'],
  hike: [
    'hiking',
    'walking',
    'mountaineering',
    'casual_walking',
    'speed_walking',
    'rock_climbing',
    'backcountry_skiing',
    'resort_skiing',
    'cross_country_skiing',
    'skate_skiing',
    'snowshoeing',
  ],
};

describe('sportGroup', () => {
  it.each(Object.entries(CONTROL).flatMap(([group, keys]) => keys.map((key) => [key, group])))('%s → %s', (key, group) => {
    expect(sportGroup(key)).toBe(group);
  });

  it('maps unknown and missing types to other', () => {
    for (const key of ['multi_sport', 'indoor_rowing', 'elliptical', 'golf', 'tennis', '', null, undefined]) {
      expect(sportGroup(key)).toBe('other');
    }
  });

  it('applies the rules in order and ignores case', () => {
    expect(sportGroup('swimrun')).toBe('run');
    expect(sportGroup('Road_Biking')).toBe('bike');
    expect(sportGroup('e_bike_mountain')).toBe('bike');
  });
});
