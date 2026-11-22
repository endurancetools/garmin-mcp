---
title: "Coverage map: Garmin Connect → garmin-mcp tools"
description: "Which Garmin Connect data Garmin MCP covers: every read and write mapped to its MCP tool, resource or parameter, marked full, partial or missing."
nav_order: 8
---
Every Garmin Connect read and write this map tracks, and the garmin-mcp tool, resource or parameter that serves it.

Coverage:

- **full**: garmin-mcp answers the question. The answer is a dense summary from the local cache, not raw Garmin JSON.
- **partial**: garmin-mcp covers the main use, but some fields or options are missing. The note says what is missing.
- **missing**: not served yet; the note says what would be needed.

All reads come from the local SQLite cache. Data that garmin-mcp does not sync is not available, even if the client has a method for it.

Totals for the 111 reads: 76 full, 14 partial, 21 missing.

## Reads

### Activities

| Garmin Connect data | garmin-mcp | Coverage | Note |
| --- | --- | --- | --- |
| Activity list, newest first | `get_activities` `limit`, `cursor` | full | |
| Activities in a date range, by type | `get_activities` `from`, `to`, `type`, `event_type`, `limit`, `cursor` | full | `type` matches the Garmin type key partially; `event_type` (e.g. `race`) the whole key |
| Activities on one day | `get_activities` `from` = `to` = date | full | |
| Activity count | `garmin://sync-status` → `tables` | partial | counts activities in the local cache, not on the account |
| Activity summary | `get_activity` `id`, `detail: "summary"` | full | a swim has the pace per 100 m (`avg_pace_100m`) next to `avg_speed_kmh`, as in `get_activities` and in the laps, typed splits and `stream_summary` buckets of the swim |
| Activity laps | `get_activity` `detail: "splits"` | full | laps (`lapDTOs`); `lap_summary`: the laps summed per intensity (warmup, active, interval, recovery, rest, cooldown) with count, time, distance, pace or speed from the totals, and heart rate, GAP and power averaged over time |
| Typed splits (run/walk/stand intervals) | `get_activity` `detail: "splits"` → `typed_splits` | full | run, walk, stand, ClimbPro climbs and other types with start, time, distance, elevation, grade, pace, GAP, HR; ClimbPro climb sections are left out |
| Split summaries | `get_activity` `detail: "splits"` → `split_summaries` | full | totals per split type (count, time, distance, elevation, pace, GAP, HR) with `time_pct` and `distance_pct`, the share within the types that split the activity between them (run/walk/stand, the interval types; none for a type alone, such as a climb); run/walk/stand shares also in `motion` of the summary |
| Time in heart rate zones | `get_activity` `detail: "hr_zones"` | full | |
| Time in power zones | `get_activity` `detail: "power_zones"` | full | |
| Activity weather | `get_activity` `detail: "weather"` | full | always metric (°C, km/h); `observed_at` in your time zone |
| Strength exercise sets | `get_activity` `detail: "exercise_sets"` | full | rest sets become `rest_after` of the preceding set |
| Gear used in an activity | `get_activity` → `gear_uuid`, name from `get_gear` | partial | one gear item (the one in the activity list), not the full gear list of the activity |
| Activity types | `garmin://activity-types` | full | type keys with parent type, from the reference sync; the same keys `get_activities` `type` and `update_activity` `type` take |
| Training effect of an activity | `get_activity` → `training_effect`, `training_load` | full | |
| Activity file (FIT, GPX, TCX, KML, CSV) | `download_activity_file` `id`, `format`, `output_dir` | full | FIT is unzipped |
| FIT file messages | `get_activity` `detail: "power_curve"` | partial | the 1 Hz power records, for the power curve; gear shifts and other messages are not served |
| FIT data (Di2, power) | — | missing | power is served as the power curve of `get_activity` `detail: "power_curve"`; gear shifts (Di2, eTap) are read from the FIT file and kept with the curve, but not served until a recording of a file with shift events confirms them |
| Power-duration curve | `get_activity` `detail: "power_curve"` | full | best power for 1, 5, 15, 30 s and 1, 2, 5, 10, 20, 30, 60 min, W and W/kg, also running power; from the FIT file, downloaded once and kept as the curve |

### Daily health

| Garmin Connect data | garmin-mcp | Coverage | Note |
| --- | --- | --- | --- |
| Daily stats | `query_health` `metrics: [steps, calories, resting_hr, stress, body_battery, intensity_minutes, floors]`, `from` = `to` = date | full | daily distance as `distance_km` next to `steps`; calories eaten as `calories_consumed_kcal` next to `calories_total_kcal` and `calories_active_kcal` (absent on days without food entries) |
| Daily user summary | as daily stats | full | as daily stats |
| Daily stats over a date range | `query_health` `metrics: [steps, calories]`, `from`, `to` | full | |
| Daily stats with body composition | `query_health` + `get_body_composition` | full | two calls |
| Energy balance | `get_period_summary` → `energy`; `query_health` `metrics: [calories]` | partial | `energy`: burned vs resting, week, month or range; calories eaten per day or week in `query_health` (`calories_consumed_kcal`), from a food log linked to Garmin Connect (e.g. MyFitnessPal). |
| Daily steps | `query_health` `metrics: [steps]` | full | |
| Weekly steps | `query_health` `metrics: [steps]`, `granularity: "week"` | full | |
| Steps in 15-minute intervals | `query_health` `granularity: "hour"`, `metrics: [steps]` | full | hourly totals with the busiest hour, up to 3 days per call; the 15-minute series is downloaded only by this question |
| Resting heart rate | `query_health` `metrics: [resting_hr]` | full | |
| Daily heart rate summary (min, max, resting) | `query_health` `metrics: [resting_hr]` → `hr_min_bpm`, `hr_max_bpm` | full | |
| Intraday heart rate | `query_health` `granularity: "hour"`, `metrics: [resting_hr]` | full | average, lowest and highest heart rate per hour, up to 3 days per call |
| Daily stress | `query_health` `metrics: [stress]` | full | daily average |
| Weekly stress | `query_health` `metrics: [stress]`, `granularity: "week"` | full | |
| Intraday stress | `query_health` `granularity: "hour"`, `metrics: [stress]` | full | average and highest stress per hour, the most and least stressful hour |
| All-day stress with Body Battery values | `query_health` `granularity: "hour"`, `metrics: [stress, body_battery]` | full | one series for both, per hour |
| Body Battery | `query_health` `metrics: [body_battery]` | full | daily high/low; per hour with `granularity: "hour"`: level at the start and end of each hour, highest and lowest level with the hour, and the events |
| Body Battery events | `query_health` `granularity: "hour"`, `metrics: [body_battery]` or `[stress]` → `events` | full | sleep, nap, activity and stress events with local start, duration, impact and Garmin's feedback |
| Daily respiration | `query_health` `metrics: [respiration]` | full | |
| Intraday respiration | `query_health` `granularity: "hour"`, `metrics: [respiration]` | full | average breaths per minute per hour |
| Pulse Ox (SpO2) | `query_health` `metrics: [spo2]`, `get_sleep` → `avg_spo2_pct` | full | daily averages; per hour with `granularity: "hour"` (the shape of the intraday readings is not confirmed by a recording yet) |
| Weekly intensity minutes | `query_health` `metrics: [intensity_minutes]`, `granularity: "week"` | full | |
| Floors | `query_health` `metrics: [floors]` | full | floors climbed per day; no descended floors or 15-minute series |
| Training readiness | `get_training_status` `to` = date → `readiness` | full | |
| Morning training readiness | `get_training_status` → `readiness` | full | morning (`AFTER_WAKEUP_RESET`) value is preferred |
| Recovery time remaining | `get_training_status` `to` = date → `recovery.remaining_h` | full | newest readiness snapshot of the day; no fallback to recovery time of recent activities; `recovery.as_of` in your time zone |
| Body composition | `get_body_composition` `from`, `to` | full | `measurements[].time_local` in your time zone; only the date for a weigh-in Garmin sent without a time |
| Blood pressure | — | missing | client has `getBloodPressure`; waits for a recording with readings to confirm their shape. |
| Hydration | `query_health` `metrics: [hydration]` | full | ml drunk, goal and sweat loss per day (week: averages); downloaded per day by the question, days without a water entry left out |
| All-day events | — | missing | waits for a recording of its shape. |
| Lifestyle logging | — | missing | |

### Sleep

| Garmin Connect data | garmin-mcp | Coverage | Note |
| --- | --- | --- | --- |
| Sleep of one night, full detail | `get_sleep` `date` → `timeline` | full | stages, score, SpO2, respiration, HRV; `timeline`: stage segments (at most 60), awakenings with times, restless moments, lowest heart rate, HRV and SpO2 with times, Body Battery at the start and end; clock times in the user's time zone |
| Sleep summary of one night | `get_sleep` `date` | full | bed and wake time as `start_local`, `end_local` in your time zone |
| Sleep over a date range | `get_sleep` `from`, `to` | full | adds averages and trend |

### Training

| Garmin Connect data | garmin-mcp | Coverage | Note |
| --- | --- | --- | --- |
| Training status | `get_training_status` `to` = date | full | |
| Training load trend | `get_training_status` `from`, `to`, `include_series: true` | full | `garmin_load_model`: CTL/ATL/TSB from Garmin's training load per activity; the own TSS model (power, pace, heart rate, RPE) is `get_load` |
| Training load balance | `get_training_status` `to` = date → `load_focus` | full | bands with targets and below/within/above |
| VO2max trend | `get_training_status` `from`, `to` → `vo2max.running_trend` | partial | trend, not the daily series |
| HRV of one night | `query_health` `metrics: [hrv]` → `hrv_status`, `hrv_baseline_low_ms`, `hrv_baseline_high_ms`; `get_sleep` `date` → `timeline.hrv` | full | last-night average, status and baseline; the night's lowest and highest 5-minute reading with times, not the reading series |
| HRV trend | `query_health` `metrics: [hrv]`, `from`, `to`; `get_period_summary` → `health.hrv` | full | `summary.hrv.status_days`: days per HRV status (`balanced`, `unbalanced`, `low`, `poor`, stored days without a status in `no_status`), also with `granularity: "week"`; the same `health.hrv.status_days` in `get_period_summary` |
| Respiration trend | `query_health` `metrics: [respiration]`, `from`, `to` | full | |
| Progress summary between dates | `get_period_summary` `period: "range"`, `from`, `to`; `get_activities` | full | any range up to 366 days; `period` week or month with `anchor_date` for calendar periods; `vs_previous`: the change against the period of the same length just before (sessions, hours, km, training load, resting heart rate, HRV, sleep) with its values, from the cache only, left out when that period is not fully synced |
| Cycling FTP | `garmin://profile` → `power_zones[].ftp_w`, `get_thresholds` `ftp_w` | full | `get_thresholds` dates it with the day Garmin set it |
| Lactate threshold | `get_thresholds` `lthr_run`, `run_threshold_pace_s_per_km` (`history: true`); `garmin://profile` → `lactate_threshold_hr_bpm` | full | heart rate and pace with Garmin's dates, the last 365 days, downloaded once a day by the analytics reads |
| Endurance score | `get_training_status` → `metrics.endurance_score` | partial | latest score, class and weekly averages of the 4 weeks before the sync; no arbitrary range, no contributors. |
| Hill score | `get_training_status` → `metrics.hill_score` | partial | latest overall/strength/endurance and the 4-week max before the sync; no arbitrary range. |
| Fitness age | `get_training_status` `to` = date → `metrics.fitness_age` | partial | current value saved by each training sync that reaches today (one row per sync day); dates that were never synced have no value; no component breakdown |
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
| Garmin Coach / adaptive plan workouts | `list_workouts` → `upcoming_schedule` (`source: "plan"`), `plan` | partial | plan name, kind, dates, current phase and target event; a one-line description (time, distance, Training Effect) only for the current week, as Garmin lists the tasks of one week; no steps (`get_workout` needs a library workout); cannot be unscheduled |
| Training plan workouts | `list_workouts` → `upcoming_schedule` (`source: "plan"`), `plan` | partial | phased plans are not confirmed by a recording: workouts with a plan id are listed, the plan itself may not download |
| Workout as a FIT file | — | missing | |
| Calendar events and races | `list_workouts` `from`, `to` → `upcoming_events` | partial | any date range; with the assigned course (id, name, distance, elevation gain); the custom goal time is not fetched (one extra request per event) |

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
| Device last used | `get_devices` → `last_sync_local` | full | in your time zone |
| Primary training device | `get_devices` → `primary` | full | |
| Device settings | `get_devices` → `settings` | full | every device, not one by id; time/date format, units, tones, activity tracking alerts, alarm counts |
| Device alarms | `get_devices` → `settings.alarms`, `settings.alarms_on` | partial | how many alarms are set and how many are on; alarm times and days are not shown until a recording with an alarm set confirms their shape |
| Device solar data | `get_devices` → `solar` | full | devices that charge from the sun, last 7 days: time gained, minutes with solar input and the day's peak `solarUtilization`; the minute readings are summed up, not shown |
| Weigh-ins over a date range | `get_body_composition` `from`, `to` | full | |
| Weigh-ins of one day | `get_body_composition` `from` = `to` = date | full | |

### Courses

| Garmin Connect data | garmin-mcp | Coverage | Note |
| --- | --- | --- | --- |
| Courses | `garmin://courses` | full | id, name, sport, distance and elevation gain, newest first; downloaded when read (auto fetch) and kept for an hour |
| Course details | `garmin://course/{id}` | full | distance, elevation, lowest and highest point, the profile in 20 stretches (gain, loss, grade) and the climbs; positions only with `GARMIN_REDACT=false` |
| Course as GPX | `garmin course download <id>` (CLI, `--out` for a file or directory) | full | |

### Stage 4: nutrition, women's health, challenges, badges

| Garmin Connect data | garmin-mcp | Coverage | Note |
| --- | --- | --- | --- |
| Daily food log | — | missing | the daily total of calories eaten is in `query_health` `metrics: [calories]` → `calories_consumed_kcal`; no foods, meals or macros. |
| Nutrition summary over a date range | — | missing | |
| Daily meals | — | missing | |
| Daily nutrition settings | — | missing | |
| Food search | — | missing | |
| Custom foods | — | missing | |
| Custom food serving units | — | missing | |
| Pregnancy summary | — | missing | |
| Menstrual data for a day | — | missing | |
| Menstrual calendar | — | missing | |
| Earned badges | `garmin://challenges` → `badges` | full | how many are earned and the 10 latest: name, date, points, how many times; downloaded when read (auto fetch) and kept for an hour |
| Ad-hoc challenges | — | missing | not planned: challenges between connections are a contest with friends, not training data |
| Available badge challenges | — | missing | not planned: a catalogue of challenges to sign up for, not training data |
| Badge challenges | `garmin://challenges` → `badges` | partial | a completed challenge shows only as the badge it earned; no list of completed challenges |
| Non-completed badge challenges | `garmin://challenges` → `challenges` | full | joined challenges in progress: name, start and end date, progress in %, value and target in Garmin's unit (`unit_id`) |
| Virtual challenges in progress | — | missing | the endpoint answers (`garmin record virtual-challenges`), but no recording with a challenge in progress shows the shape of one yet |
| Goals | — | missing | waits for a recording with a goal set; the recorded account had none |

## Writes

garmin-mcp deliberately has few writes; listed so nothing disappears silently.

| Garmin Connect write | garmin-mcp |
| --- | --- |
| Activity name, type, description, perceived effort, feel | `update_activity` `name`, `type`, `description`, `rpe`, `feel` |
| Activity event type (race, training, recreation...) | `update_activity` `event_type` |
| Activity privacy | `update_activity` `privacy` (`public`, `followers`, `groups`, `private`) |
| Strength exercise sets (exercise, reps, weight) | `update_activity` `exercise_sets` (opt-in `GARMIN_ENABLE_DESTRUCTIVE`; replaces all sets; `keep_timing: true` keeps the recorded times; the previous sets come back in the answer) |
| Manual activity | `update_activity` without `id`: `type`, `start` (local time), `duration_min`, optional `distance_km`, `name`, `description`, `rpe`, `feel`, `privacy` (private unless set) |
| Upload an activity file (FIT, GPX, TCX) | `garmin upload <file...>` (CLI; prints the new activity id and stores the activity in the local cache; a duplicate is reported, not an error) |
| Workout from a preset (run intervals, walk/run, easy Z2, strength circuit) | `create_workout` `preset` (with `dry_run: true` first: steps and estimated duration, nothing saved) |
| Workout from typed steps (nestable repeats, HR/pace/power/cadence targets, strength exercises with load) | `create_workout` `definition` (`dry_run: true` shows it first, with the category and exercise key of each strength exercise; an exercise that is not in Garmin's catalogue is refused with the similar ones, also in a preset or `garmin_json`) |
| Workout from raw Garmin JSON | `create_workout` `garmin_json` (one per call; `dry_run: true` shows it first) |
| Edit a saved workout | `create_workout` `workout_id` (opt-in `GARMIN_ENABLE_DESTRUCTIVE`; overwrites in place, the id and calendar entries stay) |
| Schedule workouts on dates | `schedule_workouts` `items` |
| Unschedule workouts | `schedule_workouts` `unschedule` (schedule ids; the workout stays in the library) |
| Delete workouts | `delete_workout` (opt-in `GARMIN_ENABLE_DESTRUCTIVE`) |
| Delete weigh-ins | `delete_weigh_in` (opt-in, one sample) |
| Add weigh-in or body composition | `garmin log weight <kg>` (CLI, `--date` for an earlier time; the day's weigh-ins are downloaded again into the local cache); `--fat <pct>` adds body fat, sent as a weight scale FIT file through the upload service. Muscle mass, bone mass, water and the other body composition values are not written |
| Blood pressure | `garmin log bp <systolic/diastolic>` (CLI, optional `--pulse`, `--note`, `--date`) |
| Add or remove gear on an activity | `update_activity` `add_gear`, `remove_gear` (gear name or uuid) |
| Add, edit or retire gear | — |
| Heart rate zones | — |
| Reprocess data on Garmin's side | — (closest: `garmin_sync` `force: true`, which re-downloads instead of asking Garmin to reprocess) |
| FIT download directory (local setting) | `GARMIN_FIT_DOWNLOAD_DIR` or `download_activity_file` `output_dir` |
| Upload a course (GPX) | `garmin course upload <file.gpx>` (CLI; prints the new course id; without a name in the file the course is named after it) |
| Delete a course | — |
| Hydration | `garmin log water <ml>` (CLI, `--date` for another day; prints the day's total) |
| Nutrition settings, custom foods, food log | — |

Workout templates are served by the presets of `create_workout` and the `plan_next_week` prompt.

## Computed analytics

Not Garmin Connect reads: these are computed by garmin-mcp from data already in the local cache, so they are not part of the totals above. Formulas and defaults: [Training analytics](analytics.md).

| Computed data | garmin-mcp | Built from |
| --- | --- | --- |
| Own load model: TSS per activity (power, pace, heart rate or RPE), CTL/ATL/TSB, ACWR, monotony, strain, flags | `get_load` | activities (normalized power, grade adjusted speed, heart rate, duration), daily resting heart rate, threshold history |
| Weekly volume per sport, 3-zone intensity split, efficiency trend | `get_load` `include_activities`, `include_efficiency` | activities (HR zones, speed, grade adjusted speed, normalized power) |
| Week totals of all sports with the TSS change, range totals with rest days, the longest break and the days since the last session, the CTL peak | `get_load` → `week_totals`, `totals`, `ctl_peak` | activities, the load model over the whole history |
| Morning GO / MODIFY / REST decision | `get_readiness` | HRV, resting heart rate, hours of sleep, the load model; Body Battery, stress, sleep score and training readiness shown, not counted |
| Threshold history (LTHR per sport, LT1, HRmax, FTP, VO2max...) | `get_thresholds`, `set_threshold` | Garmin profile values recorded on each change, Garmin's lactate threshold and FTP history with its dates, plus your own test results |
| FTP estimate: 95 % of the best 20 min ride power of 90 days, shown and not recorded | `get_thresholds` → `estimates.ftp_w` | power curves stored by `get_activity` `detail: "power_curve"` |
| Best 5 and 20 min power next to the other session metrics | `compare_activities` → `best_5min_w`, `best_20min_w` | power curves stored by `get_activity` `detail: "power_curve"` |
| Differences from the reference session (duration, distance, pace, GAP, heart rate, power, TSS, EF, decoupling, best 5 and 20 min power) | `compare_activities` → `vs_reference` | the compared rows; EF only between the same sport, decoupling only with the same basis |
| Activities from Garmin Connect CSV exports | `garmin import-activities` (CLI) | for dates the synced activities do not cover |
