---
title: Training analytics
nav_order: 10
---
Four tools compute training metrics on your machine, from the data already in the local database: `get_load`, `get_readiness`, `get_thresholds` and `set_threshold`. The same results are in the CLI as `garmin load`, `garmin readiness` and `garmin thresholds`. Nothing here is sent to Garmin, and every formula, default and limit is on this page, so you can check a number by hand.

The defaults below are starting points taken from the literature, not personal prescriptions. Every flag and rule can be overridden in the call (`flags` of `get_load`, `rules` of `get_readiness`), and every answer returns the values it used (`flags_used`, `rules_used`).

## What each tool answers

| Tool | Question | Main fields |
| --- | --- | --- |
| `get_load` | How much have I trained, how fit and how fatigued am I? | `latest` (TSS, CTL, ATL, TSB, ACWR, monotony, strain on `to`), `flags`, `weeks` (ISO week × sport), `intensity` (3-zone split of the last 28 days), `thresholds_used`; optional `series`, `activities`, `efficiency` |
| `get_readiness` | Can I train hard this morning? | `decision` (GO, MODIFY, REST), `counts`, `signals` (value, reference, rating, detail), `partial`, `rules_used`, `recommendation` |
| `get_thresholds` | Which thresholds apply on a date? | `effective` (value, since, source per parameter), `by_sport` (LTHR and LT1 for run, bike, swim), `hrmax`, `rhr_28d`; optional `history` |
| `set_threshold` | Record a field test result | `added`, `row`, `effective` (the value in use from now on) |

`get_load` is a model of its own built from heart rate. Garmin's status, its EPOC-based load and load focus stay in `get_training_status`, whose `computed_load` runs the same CTL/ATL averages on Garmin's training load instead of hrTSS. `get_load` with `source: "garmin_load"` reproduces that input.

## Thresholds with history

Every threshold has a history: one row per date from which it applies.

| Parameter | Meaning |
| --- | --- |
| `hrmax` | maximum heart rate (bpm) |
| `rhr` | resting heart rate (bpm), used only when the rolling value below is missing |
| `lthr_run`, `lthr_bike`, `lthr_swim` | lactate threshold heart rate per sport (bpm) |
| `lt1_hr` | first lactate (aerobic) threshold heart rate (bpm) |
| `ftp_w`, `run_ftp_w` | cycling and running threshold power (W) |
| `vo2max_run` | running VO2max |
| `css_s_per_100m` | critical swim speed (s per 100 m) |

Sources of a row: `garmin-auto` (the Garmin profile), `test` and `manual` (`set_threshold` or `garmin thresholds add`), `import` (`garmin thresholds import`).

- **From the Garmin profile.** Before every analytics read, the values of the stored profile are compared with the last `garmin-auto` row of each parameter, and a new row dated with the day the profile was downloaded is added only when a value changed: `hrmax`, `rhr` and `lthr_run` from the default heart rate zones (running LTHR falls back to the user settings), `lthr_bike` from the cycling zones, `ftp_w` and `run_ftp_w` from the power zones, `vo2max_run` from the user settings. The profile comes from the reference sync; when it is not in the cache yet, the first analytics read downloads it (as `get_profile` does, within the daily request limit). With auto fetch off (`GARMIN_AUTO_FETCH=false`, and always in the CLI), a missing profile comes back as a note and `meta.sync_hint` with `scope: "reference"` instead.
- **Value on a day D.** The row with the latest date on or before D wins, whatever its source. When every row is later than D, the first row is carried back. No row: no value.
- **LTHR of a sport.** Cycling uses `lthr_bike`, swimming `lthr_swim`, both falling back to `lthr_run` (with a note in `by_sport`); every other sport uses `lthr_run`. Without any LTHR, 170 bpm is used and the answer says so.
- **LT1.** The `lt1_hr` row, else 0.90 × running LTHR rounded (noted as an approximation to confirm with a test). Cycling LT1 is 7 bpm lower.
- **Resting heart rate on D.** The mean of Garmin's daily resting heart rate over the 28 days before D (D − 28 to D − 1), to 0.1 bpm, when at least 14 of those days have a value; else the `rhr` row; else 50 bpm with a note.
- **HRmax.** From the history only (Garmin profile or `set_threshold`). Without a row, `hrmax` has a note and no value: no age formula or activity maximum is guessed. The metrics on this page do not use HRmax.

Each activity is computed with the thresholds that applied on its own date. A new test result therefore changes the metrics from its date on and leaves older activities as they were: hrTSS of different periods describes the load relative to the fitness of that time. Progress shows in CTL, efficiency and the tests themselves, not in hrTSS of the same session repeated months apart.

## Sport groups

Thresholds, zones and weekly volume use a coarse sport group from the Garmin activity type key (for imported CSV files, the activity type label in lower case). The first matching substring wins:

| Group | Substrings |
| --- | --- |
| `run` | `run` |
| `bike` | `cycling`, `biking`, `bike`, `ride`, `bmx`, `gravel`, `cyclocross` |
| `swim` | `swim` |
| `strength` | `strength`, `cardio`, `hiit`, `yoga`, `pilates`, `stretch`, `mobility`, `breath` |
| `hike` | `hik`, `walk`, `mountaineer`, `climb`, `ski`, `snowshoe` |
| `other` | everything else, and activities without a type |

So `trail_running` is `run`, `e_bike_fitness` is `bike` and `skate_skiing` is `hike`.

## Per-activity metrics

With `RHR` the resting heart rate and `LTHR` the threshold of the activity's sport, both on the activity's date:

```
IF      = (avg_hr − RHR) / (LTHR − RHR)              0 without avg_hr, when avg_hr ≤ RHR or LTHR ≤ RHR   3 places
hrTSS   = duration_h × IF² × 100                                                                          1 place
EF      = run:  speed in m/min / avg_hr               bike: normalized power / avg_hr                     3 places
EF-GAP  = run:  grade adjusted speed in m/min / avg_hr                                                    3 places
```

IF is the heart rate reserve between resting and threshold heart rate, so an hour at LTHR scores 100, as an hour at FTP does in the power-based TSS (Allen, Coggan, McGregor 2019). `include_activities` returns one row per activity with these values and the inputs: type, sport group, duration, moving time, distance, elevation, heart rate, power, cadence, calories, Garmin training load and training effect, RPE and feel (when the activity detail was downloaded), seconds in Garmin's HR zones 1-5, the LTHR and resting heart rate used, and `source` (`db` or `import`).

Rough hrTSS orientation: an hour in zone 1 is about 40-55, an hour in zone 2 about 60-80, an hour at threshold 100, a 10 km race about 80-90, a marathon about 250-300, a 10-hour mountain ultra 500 and more.

## Load model

- **Daily stress.** `source: "hrtss"` (default) sums the hrTSS of the day's activities; `source: "garmin_load"` sums Garmin's per-activity training load (activities without one, including imported ones, count 0). The series runs from the first stored activity to the later of `to` and today; days without activities are 0. The full history is always used, whatever `from` is.
- **CTL, ATL, TSB.** Exponentially weighted averages of the daily stress over 42 days (CTL, fitness) and 7 days (ATL, fatigue), with `k = 1 − e^(−1/N)`; TSB (form) is CTL − ATL at the start of the day (Banister 1991; Allen, Coggan, McGregor 2019). CTL needs about 42 days of history before `from` to settle; with less, the answer says so. Every day of the series, `latest` included, carries `warming_up`: true while fewer than 42 days have passed since the first activity.
- **ACWR.** Mean daily stress of the last 7 days divided by the mean of the last 28 days, both rolling averages ending on the day, windows cut at the start of the series; 0 when the 28-day mean is 0. 2 places.
- **Monotony and strain.** Monotony = mean / sample standard deviation of the last 7 days (0 when the deviation is 0 or there are fewer than 2 days); strain = sum of the last 7 days × monotony (Foster 1998). 2 and 0 places.
- **Weeks.** Per ISO week and sport group: sessions, hours, km, elevation gain, hrTSS, Garmin load, and hours in Garmin's HR zones 1-2, 3 and 4-5 (activities with zones only).

### Load flags

`flags` raised on `to`. Override any threshold with `flags`, e.g. `{"acwr_high": 1.4, "week_jump_pct": 10}`; missing keys keep the default, unknown keys and non-numbers are ignored with a note.

| Key | Default | Flag |
| --- | --- | --- |
| `acwr_high` | 1.5 | `acwr_high`: ACWR above it, a load spike |
| `acwr_warn` | 1.3 | `acwr_warn`: ACWR above it (up to `acwr_high`), load rising fast |
| `acwr_low` | 0.8 | `acwr_low`: ACWR below it while CTL is above 20 (taper or undertraining); below CTL 20 the ratio says little and the flag stays off |
| `monotony_high` | 2.0 | `monotony_high`: 7-day monotony above it |
| `tsb_low` | −30 | `tsb_low`: TSB below it, deep fatigue |
| `tsb_fresh` | 15 | `tsb_fresh`: TSB above it, fresh (taper or rest) |
| `week_jump_pct` | 15 | `week_jump`: total hours or running km of the ISO week of `to` grew by more than this percentage against the week before |
| `z1_min_pct` | 75 | `z1_below_target`: Z1 share of run and bike time below this percentage (see intensity) |

At most one of the three ACWR flags is raised. While `warming_up` is true, `tsb_low` and `tsb_fresh` are not raised: CTL still reads low, so TSB is deeply negative after a few ordinary days. The ACWR, monotony and week-jump flags work as usual.

## Intensity distribution

`intensity` splits run and bike time of the last 28 days of the range (the whole range when shorter) into three zones (Seiler 2010): Z1 below LT1, Z2 between LT1 and LTHR, Z3 above LTHR.

- An activity with Garmin's time in HR zones: Z1 = zones 1-2, Z2 = zone 3, Z3 = zones 4-5.
- An activity without zones: its whole duration goes to the zone of its average heart rate (below LT1, below LTHR, else Z3), with LT1 and LTHR of its sport and date.
- Activities with neither are skipped.

The answer has minutes and percentages per zone, the number of activities counted each way (`sessions_with_zones`, `sessions_by_avg_hr`), and the `z1_below_target` flag.

## Efficiency

`include_efficiency` adds the monthly trend (`YYYY-MM`) of the efficiency factor over aerobic sessions: average heart rate below the LTHR of the date and at least 30 minutes. Running uses EF from speed (and EF-GAP when Garmin gave a grade adjusted speed), cycling EF from normalized power when the activity has it. Per month and sport: `n`, `ef_avg`, `ef_max`, `ef_gap_avg`.

A rising EF at the same heart rate means more speed or power per beat, i.e. better aerobic fitness. Compare like with like: the same routes and conditions. Hills and walking breaks lower EF by definition; EF-GAP corrects for gradient, not for walking or surface.

## Morning readiness

`get_readiness` rates seven signals of day D (default today) and turns them into a decision. Each signal is `ok`, `yellow`, `red`, or `unknown` when its data is missing; unknown signals do not count.

| Signal | Value | Compared with | Red | Yellow |
| --- | --- | --- | --- | --- |
| `hrv` | overnight HRV of D | Garmin's 7-day average and baseline of D, mean of the 28 nights before | Garmin status `LOW` or `POOR`, or below `hrv_red_base_factor` × baseline low, or below `hrv_red_mean28_factor` × 28-night mean | status `UNBALANCED`, or below the baseline low, or below `hrv_yellow_weekly_factor` × 7-day average |
| `rhr` | resting heart rate of D | mean of the 28 days before | ≥ mean + `rhr_red_delta` | ≥ mean + `rhr_yellow_delta` |
| `sleep` | sleep score and hours of the night before D | | score below `sleep_score_red` or hours below `sleep_h_red` | score below `sleep_score_yellow` or hours below `sleep_h_yellow` |
| `body_battery` | Body Battery high of D | | below `bb_red` | below `bb_yellow` |
| `training_readiness` | Garmin Training Readiness of D: the newest morning (after wake-up) value, else the newest of the day; with level and recovery time | | below `readiness_red` | below `readiness_yellow` |
| `stress` | average stress of D − 1 (D itself is still running) | | never | above `stress_yellow` |
| `load` | TSB and ACWR of the load model on D; `unknown` while the model warms up (fewer than 42 days since the first activity, detail "load model warming up (N of 42 days)") | | ACWR above `acwr_red` or TSB below `tsb_red` | ACWR above `acwr_yellow` or TSB below `tsb_yellow` |

Decision: at least `decision_red_min` red signals is **REST**; else at least `decision_yellow_min` yellow signals is **MODIFY**; else **GO**. `partial` is true when D is today or later, or when a row of D was downloaded before the day had ended, so a later sync may change the answer. `recommendation` gives short advice for the decision.

### Readiness rules

Override any of them with `rules`, e.g. `{"sleep_h_yellow": 7.5, "decision_yellow_min": 3}`.

| Key | Default | Key | Default |
| --- | --- | --- | --- |
| `hrv_red_base_factor` | 0.9 | `bb_red` | 30 |
| `hrv_red_mean28_factor` | 0.85 | `bb_yellow` | 50 |
| `hrv_yellow_weekly_factor` | 0.9 | `readiness_red` | 30 |
| `rhr_red_delta` | 5 bpm | `readiness_yellow` | 50 |
| `rhr_yellow_delta` | 3 bpm | `stress_yellow` | 50 |
| `sleep_score_red` | 60 | `acwr_red` | 1.5 |
| `sleep_score_yellow` | 75 | `acwr_yellow` | 1.3 |
| `sleep_h_red` | 6 h | `tsb_red` | −30 |
| `sleep_h_yellow` | 7 h | `tsb_yellow` | −20 |
| `decision_red_min` | 1 | `decision_yellow_min` | 2 |

The HRV rules follow day-to-day HRV-guided training, which compares the night with the athlete's own recent baseline rather than with population norms (Kiviniemi et al. 2007; Plews et al. 2013; Javaloyes et al. 2019); resting heart rate is read the same way (Buchheit 2014).

## Reading the numbers

- **ACWR** detects a sudden jump in load against what you are used to; it does not predict injuries (Gabbett 2016; Hulin et al. 2016; Impellizzeri et al. 2020). After a break of more than 10 days the chronic mean is low and the ratio rises artificially on the first sessions back.
- **hrTSS** comes from heart rate, so it under-rates strength work and short intervals (heart rate lags behind), and over-rates sessions in the heat (cardiac drift). Load measured internally and externally answer different questions (Impellizzeri, Marcora, Coutts 2019).
- **Monotony**: a rest day with stress 0 lowers it strongly, which is intended: varying hard and easy days is the point. Read **strain** as a trend; a jump of more than 30 % week to week deserves attention.
- **TSB in the first 42 days** of the history (`warming_up`) is not fatigue: CTL starts at 0 and climbs slowly, so a week of ordinary training already gives a TSB of −25 or lower. The TSB flags and the `load` signal of the readiness stay off until the model has settled.
- **Readiness**: in the first four weeks without a 28-day history, the resting heart rate and HRV comparisons are weaker; in the first 42 days the `load` signal is `unknown`. On a race day, the decision does not change the race plan.

## Limits

- Only heart-rate stress is modelled: no power-based TSS for cycling, no session RPE for strength, no aerobic decoupling. `np_w` and `rpe` are returned per activity but not summed.
- Thresholds that were never tested fall back to defaults or approximations (LTHR 170, resting heart rate 50, LT1 = 0.90 × LTHR); the answer then carries a note. Record real values with `set_threshold`.
- Activities without heart rate add no hrTSS.
- The analytics read the local database only. Missing days and a missing Garmin profile are downloaded as for the other tools (or reported in `meta.sync_hint` with `GARMIN_AUTO_FETCH=false`); the CLI commands never download and print the `garmin sync` command instead.

## Activities from Garmin Connect exports

`garmin import-activities <file.csv...>` reads the "Activities" CSV export of Garmin Connect (English or Polish headers, numbers such as `1,234`, `--` for missing values, `h:mm:ss` times, duplicate column names, rows with a comma in the title). Imported activities count only on dates that the synced activities do not cover, so nothing is counted twice; the command reports how many rows fall inside the synced range. They have no Garmin training load, zones, RPE or grade adjusted speed.

## Thresholds in a file

`garmin thresholds export [--out file.csv]` writes the history as `date,param,value,source,note`; `garmin thresholds import file.csv` reads it back. Rows from the Garmin profile (`garmin-auto`) are skipped, an empty source becomes `import`, an identical row is skipped, and a row with the same date, parameter and source but a different value or note replaces it. One bad row rejects the whole file.

## References

1. Allen H, Coggan A, McGregor S. Training and Racing with a Power Meter. 3rd ed. VeloPress; 2019.
2. Banister EW. Modeling elite athletic performance. In: Physiological Testing of Elite Athletes. Human Kinetics; 1991:403-424.
3. Foster C. Monitoring training in athletes with reference to overtraining syndrome. Med Sci Sports Exerc. 1998;30(7):1164-1168.
4. Gabbett TJ. The training-injury prevention paradox: should athletes be training smarter and harder? Br J Sports Med. 2016;50(5):273-280.
5. Hulin BT, Gabbett TJ, Lawson DW, Caputi P, Sampson JA. The acute:chronic workload ratio predicts injury: high chronic workload may decrease injury risk in elite rugby league players. Br J Sports Med. 2016;50(4):231-236.
6. Impellizzeri FM, Marcora SM, Coutts AJ. Internal and external training load: 15 years on. Int J Sports Physiol Perform. 2019;14(2):270-273.
7. Impellizzeri FM, Tenan MS, Kempton T, Novak A, Coutts AJ. Acute:chronic workload ratio: conceptual issues and fundamental pitfalls. Int J Sports Physiol Perform. 2020;15(6):907-913.
8. Seiler S. What is best practice for training intensity and duration distribution in endurance athletes? Int J Sports Physiol Perform. 2010;5(3):276-291.
9. Plews DJ, Laursen PB, Stanley J, Kilding AE, Buchheit M. Training adaptation and heart rate variability in elite endurance athletes: opening the door to effective monitoring. Sports Med. 2013;43(9):773-781.
10. Buchheit M. Monitoring training status with HR measures: do all roads lead to Rome? Front Physiol. 2014;5:73.
11. Kiviniemi AM, Hautala AJ, Kinnunen H, Tulppo MP. Endurance training guided individually by daily heart rate variability measurements. Eur J Appl Physiol. 2007;101(6):743-751.
12. Javaloyes A, Sarabia JM, Lamberts RP, Moya-Ramon M. Training prescription guided by heart-rate variability in cycling. Int J Sports Physiol Perform. 2019;14(1):23-32.
