---
title: "Coverage map: Garmin Connect → garmin-mcp tools"
nav_order: 8
---
Every Garmin Connect read and write this map tracks, and the garmin-mcp tool, resource or parameter that serves it.

Coverage:

- **full**: garmin-mcp answers the question. The answer is a dense summary from the local cache, not raw Garmin JSON.
- **partial**: garmin-mcp covers the main use, but some fields or options are missing. The note says what is missing.
- **missing**: not served yet; the note says what would be needed.

All reads come from the local SQLite cache. Data that garmin-mcp does not sync is not available, even if the client has a method for it.

Totals for the 111 reads: 55 full, 16 partial, 40 missing.

## Reads

### Activities

| Garmin Connect data | garmin-mcp | Coverage | Note |
| --- | --- | --- | --- |
| Activity list, newest first | `get_activities` `limit`, `cursor` | full | |
| Activities in a date range, by type | `get_activities` `from`, `to`, `type`, `limit`, `cursor` | full | `type` matches the Garmin type key partially |
| Activities on one day | `get_activities` `from` = `to` = date | full | |
| Activity count | `garmin://sync-status` → `tables` | partial | counts activities in the local cache, not on the account |
| Activity summary | `get_activity` `id`, `detail: "summary"` | full | |
| Activity laps | `get_activity` `detail: "splits"` | full | laps (`lapDTOs`) |
| Typed splits (run/walk/stand intervals) | `get_activity` `detail: "splits"` | partial | laps only; typed splits are not fetched. |
| Split summaries | `get_activity` `detail: "splits"` | partial | laps only; split summaries are not fetched. |
| Time in heart rate zones | `get_activity` `detail: "hr_zones"` | full | |
| Time in power zones | `get_activity` `detail: "power_zones"` | full | |
| Activity weather | `get_activity` `detail: "weather"` | full | always metric (°C, km/h) |
| Strength exercise sets | `get_activity` `detail: "exercise_sets"` | full | rest sets become `rest_after` of the preceding set |
| Gear used in an activity | `get_activity` → `gear_uuid`, name from `get_gear` | partial | one gear item (the one in the activity list), not the full gear list of the activity |
| Activity types | `garmin://activity-types` | full | type keys with parent type, from the reference sync; the same keys `get_activities` `type` and `update_activity` `type` take |
| Training effect of an activity | `get_activity` → `training_effect`, `training_load` | full | |
| Activity file (FIT, GPX, TCX, KML, CSV) | `download_activity_file` `id`, `format`, `output_dir` | full | FIT is unzipped |
| FIT file messages | — | missing | FIT parsing. |
| FIT data (Di2, power) | — | missing | FIT parsing. |
| Power-duration curve | — | missing | |

### Daily health

| Garmin Connect data | garmin-mcp | Coverage | Note |
| --- | --- | --- | --- |
| Daily stats | `query_health` `metrics: [steps, calories, resting_hr, stress, body_battery, intensity_minutes, floors]`, `from` = `to` = date | full | daily distance as `distance_km` next to `steps` |
| Daily user summary | as daily stats | full | as daily stats |
| Daily stats over a date range | `query_health` `metrics: [steps, calories]`, `from`, `to` | full | |
| Daily stats with body composition | `query_health` + `get_body_composition` | full | two calls |
| Energy balance | `get_period_summary` → `energy` | partial | burned vs resting only, week, month or range; food intake is nutrition. |
| Daily steps | `query_health` `metrics: [steps]` | full | |
| Weekly steps | `query_health` `metrics: [steps]`, `granularity: "week"` | full | |
| Steps in 15-minute intervals | — | missing | 15-minute series. |
| Resting heart rate | `query_health` `metrics: [resting_hr]` | full | |
| Daily heart rate summary (min, max, resting) | `query_health` `metrics: [resting_hr]` → `hr_min_bpm`, `hr_max_bpm` | full | |
| Intraday heart rate | — | missing | intraday series. |
| Daily stress | `query_health` `metrics: [stress]` | full | daily average |
| Weekly stress | `query_health` `metrics: [stress]`, `granularity: "week"` | full | |
| Intraday stress | — | missing | intraday series. |
| All-day stress with Body Battery values | — | missing | intraday series. |
| Body Battery | `query_health` `metrics: [body_battery]` | partial | daily high/low; no events. |
| Body Battery events | — | missing | |
| Daily respiration | `query_health` `metrics: [respiration]` | full | |
| Intraday respiration | — | missing | intraday series. |
| Pulse Ox (SpO2) | `query_health` `metrics: [spo2]`, `get_sleep` → `avg_spo2_pct` | partial | averages only; intraday readings |
| Weekly intensity minutes | `query_health` `metrics: [intensity_minutes]`, `granularity: "week"` | full | |
| Floors | `query_health` `metrics: [floors]` | full | floors climbed per day; no descended floors or 15-minute series |
| Training readiness | `get_training_status` `to` = date → `readiness` | full | |
| Morning training readiness | `get_training_status` → `readiness` | full | morning (`AFTER_WAKEUP_RESET`) value is preferred |
| Recovery time remaining | `get_training_status` `to` = date → `recovery.remaining_h` | full | newest readiness snapshot of the day; no fallback to recovery time of recent activities |
| Body composition | `get_body_composition` `from`, `to` | full | |
| Blood pressure | — | missing | not planned yet. |
| Hydration | — | missing | client has `getHydration`, not synced. |
| All-day events | — | missing | |
| Lifestyle logging | — | missing | |

### Sleep

| Garmin Connect data | garmin-mcp | Coverage | Note |
| --- | --- | --- | --- |
| Sleep of one night, full detail | `get_sleep` `date` | partial | stages, score, SpO2, respiration, HRV; no per-minute series () |
| Sleep summary of one night | `get_sleep` `date` | full | |
| Sleep over a date range | `get_sleep` `from`, `to` | full | adds averages and trend |

### Training

| Garmin Connect data | garmin-mcp | Coverage | Note |
| --- | --- | --- | --- |
| Training status | `get_training_status` `to` = date | full | |
| Training load trend | `get_training_status` `from`, `to`, `include_series: true` | full | `garmin_load_model`: CTL/ATL/TSB from Garmin's training load per activity; the own TSS model (power, pace, heart rate, RPE) is `get_load` |
| Training load balance | `get_training_status` `to` = date → `load_focus` | full | bands with targets and below/within/above |
| VO2max trend | `get_training_status` `from`, `to` → `vo2max.running_trend` | partial | trend, not the daily series |
| HRV of one night | `query_health` `metrics: [hrv]` → `hrv_status`, `hrv_baseline_low_ms`, `hrv_baseline_high_ms`; `get_sleep` `date` | partial | last-night average, status and baseline; no readings () |
| HRV trend | `query_health` `metrics: [hrv]`, `from`, `to` | full | |
| Respiration trend | `query_health` `metrics: [respiration]`, `from`, `to` | full | |
| Progress summary between dates | `get_period_summary` `period: "range"`, `from`, `to`; `get_activities` | full | any range up to 366 days; `period` week or month with `anchor_date` for calendar periods |
| Cycling FTP | `garmin://profile` → `power_zones[].ftp_w` | full | |
| Lactate threshold | `garmin://profile` → `lactate_threshold_hr_bpm` | partial | current HR only; no pace or history. |
| Endurance score | `get_training_status` → `metrics.endurance_score` | partial | latest score, class and weekly averages of the 4 weeks before the sync; no arbitrary range, no contributors. |
| Hill score | `get_training_status` → `metrics.hill_score` | partial | latest overall/strength/endurance and the 4-week max before the sync; no arbitrary range. |
| Fitness age | `get_training_status` `to` = date → `metrics.fitness_age` | partial | current value saved by each training sync that reaches today (one row per sync day); dates that were never synced have no value.; no component breakdown |
| Race predictions | `get_training_status` → `metrics.race_predictions` | full | 5k, 10k, half marathon, marathon; older predictions stay per sync day |
| Personal records | `get_training_status` → `metrics.personal_records` | full | |
| Heat and altitude acclimation | `get_training_status` `to` = date → `metrics.acclimation` | partial | current value saved by each training sync that reaches today (one row per sync day); dates that were never synced have no value. |
| Running tolerance | — | missing | no client method. |
| Running tolerance trend | — | missing | no client method. |

### Workouts and calendar

| Garmin Connect data | garmin-mcp | Coverage | Note |
| --- | --- | --- | --- |
| Workout library | `list_workouts` `limit`, `sport` | full | |
| One workout | `get_workout` `id` | full | readable steps instead of raw JSON; from the cache for 1 h (reference TTL) |
| Scheduled workouts | `list_workouts` `from`, `to` → `upcoming_schedule` | full | any date range, past or future; default today + 60 days |
| Garmin Coach / adaptive plan workouts | — | missing | |
| Training plan workouts | — | missing | |
| Workout as a FIT file | — | missing | |
| Calendar events and races | `list_workouts` `from`, `to` → `upcoming_events` | partial | any date range; the custom goal time is not fetched (one extra request per event;) |

### Profile, gear, devices, weight

| Garmin Connect data | garmin-mcp | Coverage | Note |
| --- | --- | --- | --- |
| User profile | `garmin://profile` | full | |
| User settings | `garmin://profile` | full | units, weight, height, birth date, VO2max, zones |
| Full name | `garmin://profile` → `name` | full | |
| Unit system | `garmin://profile` → `units` | full | |
| Heart rate zones | `garmin://profile` → `hr_zones`, `get_thresholds` → `zones` | full | all sports at once; `get_thresholds` also has the power zones, for clients without resources |
| Gear and gear stats | `get_gear` `include_activities` | full | stats always included |
| Devices | `get_devices` | full | |
| Device last used | `get_devices` → `last_sync_utc` | full | |
| Primary training device | `get_devices` → `primary` | full | |
| Device settings | `get_devices` → `settings` | full | every device, not one by id; time/date format, units, tones, activity tracking alerts, alarm counts |
| Device alarms | — | missing | part of device settings. |
| Device solar data | — | missing | |
| Weigh-ins over a date range | `get_body_composition` `from`, `to` | full | |
| Weigh-ins of one day | `get_body_composition` `from` = `to` = date | full | |

### Courses

| Garmin Connect data | garmin-mcp | Coverage | Note |
| --- | --- | --- | --- |
| Courses | — | missing | not planned yet. |
| Course details | — | missing | |
| Course as GPX | — | missing | |

### Stage 4: nutrition, women's health, challenges, badges

| Garmin Connect data | garmin-mcp | Coverage | Note |
| --- | --- | --- | --- |
| Daily food log | — | missing | |
| Nutrition summary over a date range | — | missing | |
| Daily meals | — | missing | |
| Daily nutrition settings | — | missing | |
| Food search | — | missing | |
| Custom foods | — | missing | |
| Custom food serving units | — | missing | |
| Pregnancy summary | — | missing | |
| Menstrual data for a day | — | missing | |
| Menstrual calendar | — | missing | |
| Earned badges | — | missing | |
| Ad-hoc challenges | — | missing | |
| Available badge challenges | — | missing | |
| Badge challenges | — | missing | |
| Non-completed badge challenges | — | missing | |
| Virtual challenges in progress | — | missing | |
| Goals | — | missing | goals. |

## Writes

garmin-mcp deliberately has few writes; listed so nothing disappears silently.

| Garmin Connect write | garmin-mcp |
| --- | --- |
| Activity name, type, description, perceived effort, feel | `update_activity` `name`, `type`, `description`, `rpe`, `feel` |
| Activity event type | — () |
| Manual activity | — () |
| Workout from a preset (run intervals, walk/run, easy Z2, strength circuit) | `create_workout` `preset` |
| Workout from typed steps (nestable repeats, HR/pace/power/cadence targets, strength exercises with load) | `create_workout` `definition` |
| Workout from raw Garmin JSON | `create_workout` `garmin_json` (one per call) |
| Edit a saved workout | `create_workout` `workout_id` (opt-in `GARMIN_ENABLE_DESTRUCTIVE`; overwrites in place, the id and calendar entries stay) |
| Schedule workouts on dates | `schedule_workouts` `items` |
| Unschedule workouts | `schedule_workouts` `unschedule` (schedule ids; the workout stays in the library) |
| Delete workouts | `delete_workout` (opt-in `GARMIN_ENABLE_DESTRUCTIVE`) |
| Delete weigh-ins | `delete_weigh_in` (opt-in, one sample) |
| Add weigh-in or body composition | — (client has `addWeighIn`;) |
| Blood pressure | — () |
| Add or remove gear on an activity | — () |
| Heart rate zones | — () |
| Reprocess data on Garmin's side | — (closest: `garmin_sync` `force: true`, which re-downloads instead of asking Garmin to reprocess) |
| FIT download directory (local setting) | `GARMIN_FIT_DOWNLOAD_DIR` or `download_activity_file` `output_dir` |
| Upload or delete a course | — () |
| Hydration, nutrition settings, custom foods, food log | — () |

Workout templates are served by the presets of `create_workout` and the `plan_next_week` prompt.

## Computed analytics

Not Garmin Connect reads: these are computed by garmin-mcp from data already in the local cache, so they are not part of the totals above. Formulas and defaults: [Training analytics](analytics.md).

| Computed data | garmin-mcp | Built from |
| --- | --- | --- |
| Own load model: TSS per activity (power, pace, heart rate or RPE), CTL/ATL/TSB, ACWR, monotony, strain, flags | `get_load` | activities (normalized power, grade adjusted speed, heart rate, duration), daily resting heart rate, threshold history |
| Weekly volume per sport, 3-zone intensity split, efficiency trend | `get_load` `include_activities`, `include_efficiency` | activities (HR zones, speed, grade adjusted speed, normalized power) |
| Morning GO / MODIFY / REST decision | `get_readiness` | HRV, resting heart rate, sleep, Body Battery, stress, training readiness, the load model |
| Threshold history (LTHR per sport, LT1, HRmax, FTP, VO2max...) | `get_thresholds`, `set_threshold` | Garmin profile values recorded on each change, plus your own test results |
| Activities from Garmin Connect CSV exports | `garmin import-activities` (CLI) | for dates the synced activities do not cover |
