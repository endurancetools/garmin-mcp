/** Coarse sport group used for thresholds, zones and per-sport load. */
export type SportGroup = 'run' | 'bike' | 'swim' | 'strength' | 'nordic' | 'row' | 'hike' | 'other';

export const SPORT_GROUPS: readonly SportGroup[] = ['run', 'bike', 'swim', 'strength', 'nordic', 'row', 'hike', 'other'];

// Substring rules, first match wins (so `trail_running` is `run`, `skate_skiing` is `nordic`,
// `resort_skiing` is `hike`).
const RULES: readonly (readonly [RegExp, SportGroup])[] = [
  [/run/, 'run'],
  [/cycling|biking|bike|ride|bmx|gravel|cyclocross/, 'bike'],
  [/swim/, 'swim'],
  [/strength|cardio|hiit|yoga|pilates|stretch|mobility|breath/, 'strength'],
  [/cross_country|skate_ski|classic_ski|backcountry_ski|snowshoe/, 'nordic'],
  [/rowing/, 'row'],
  [/hik|walk|mountaineer|climb|ski/, 'hike'],
];

/** Sport group of a Garmin activity type key (`running`, `road_biking`, …); no type is `other`. */
export function sportGroup(typeKey: string | null | undefined): SportGroup {
  if (!typeKey) return 'other';
  const key = typeKey.toLowerCase();
  for (const [re, group] of RULES) if (re.test(key)) return group;
  return 'other';
}
