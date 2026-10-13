/** Coarse sport group used for thresholds, zones and per-sport load. */
export type SportGroup = 'run' | 'bike' | 'swim' | 'strength' | 'nordic' | 'row' | 'hike' | 'other';

export const SPORT_GROUPS: readonly SportGroup[] = ['run', 'bike', 'swim', 'strength', 'nordic', 'row', 'hike', 'other'];

/** Default sport groups of the intensity distribution (`flags.intensity_sports`): the endurance sports measured by HR. */
export const INTENSITY_SPORTS: readonly SportGroup[] = ['run', 'bike', 'nordic', 'row'];

/** Is `v` a known sport group. */
export const isSportGroup = (v: unknown): v is SportGroup => typeof v === 'string' && (SPORT_GROUPS as readonly string[]).includes(v);

/** Sport groups as prose: `run, bike, nordic and row`. */
export function sportList(groups: readonly string[]): string {
  return groups.length < 2 ? groups.join('') : `${groups.slice(0, -1).join(', ')} and ${groups.at(-1)}`;
}

// Substring rules, first match wins (so `trail_running` is `run`, `skate_skiing` is `nordic`,
// `resort_skiing` is `hike`).
const RULES: readonly (readonly [RegExp, SportGroup])[] = [
  [/run/, 'run'],
  [/cycling|biking|bike|ride|bmx|gravel|cyclocross/, 'bike'],
  [/swim/, 'swim'],
  [/strength|cardio|hiit|yoga|pilates|stretch|mobility|breath/, 'strength'],
  [/cross_country|skate_ski|classic_ski|backcountry_ski|snowshoe|snow_shoe/, 'nordic'],
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
