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
| `get_thresholds` | Which thresholds apply on a date? | `effective` (value, since, source per parameter), `by_sport` (LTHR and LT1 for run, bike, swim), `hrmax`, `rhr_28d`, `zones` (Garmin profile HR and power zones per sport); optional `history` |
| `set_threshold` | Record a field test result | `added`, `row`, `effective` (the value in use from now on) |

`get_load` is a model of its own built from power, pace and heart rate. Garmin's status, its EPOC-based load and load focus stay in `get_training_status`, whose `garmin_load_model` runs the same CTL/ATL averages on Garmin's training load instead of TSS (see [Load model](#load-model) for the two models).

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
| `run_threshold_pace_s_per_km` | running threshold pace (s per km) |

Sources of a row: `garmin-auto` (the Garmin profile), `test` and `manual` (`set_threshold` or `garmin thresholds add`), `import` (`garmin thresholds import`).

- **From the Garmin profile.** Before every analytics read, the values of the stored profile are compared with the last `garmin-auto` row of each parameter, and a new row dated with the day the profile was downloaded is added only when a value changed: `hrmax`, `rhr` and `lthr_run` from the default heart rate zones (running LTHR falls back to the user settings), `lthr_bike` from the cycling zones, `ftp_w` and `run_ftp_w` from the power zones, `vo2max_run` and `run_threshold_pace_s_per_km` from the user settings. Garmin keeps the lactate threshold speed in units of 10 m/s (0.3806 is 3.806 m/s); it is converted to whole seconds per km (263, i.e. 4:23 per km), a value of 1 or more is read as m/s, and a pace outside 2:00-15:00 per km is not recorded. The profile comes from the reference sync; when it is not in the cache yet, the first analytics read downloads it (as `get_profile` does, within the daily request limit). With auto fetch off (`GARMIN_AUTO_FETCH=false`, and always in the CLI), a missing profile comes back as a note and `meta.sync_hint` with `scope: "reference"` instead.
- **Value on a day D.** The row with the latest date on or before D wins, whatever its source. When every row is later than D, the first row is carried back. No row: no value.
- **LTHR of a sport.** Cycling uses `lthr_bike`, swimming `lthr_swim`, both falling back to `lthr_run` (with a note in `by_sport`); every other sport uses `lthr_run`. Without any LTHR, 0.89 × HRmax (rounded) is used when HRmax is in the history, noted as estimated from HRmax and to be confirmed with a test (HRmax 185 gives 165 bpm); without HRmax either, 170 bpm is used and the answer says so.
- **LT1.** Cycling and swimming with their own LTHR row (`lthr_bike`, `lthr_swim`) use 0.90 × that LTHR rounded, noted as an approximation; an `lt1_hr` row is a running value and does not replace it. Otherwise: the `lt1_hr` row, else 0.90 × running LTHR rounded (noted as an approximation to confirm with a test), and cycling LT1 is then 7 bpm lower.
- **Resting heart rate on D.** The mean of Garmin's daily resting heart rate over the 28 days before D (D − 28 to D − 1), to 0.1 bpm, when at least 14 of those days have a value; else the `rhr` row; else 50 bpm with a note.
- **HRmax.** From the history only (Garmin profile or `set_threshold`). Without a row, `hrmax` has a note and no value: no age formula or activity maximum is guessed. HRmax is used only for the LTHR estimate above.
- **Zones.** `zones` lists the heart rate and power zones of every sport in the stored Garmin profile, keyed by Garmin's sport in lower case (`hr.default`, `hr.cycling`, `power.cycling`, `power.running` ...): `floors` are the lower bounds of zones 1-5 in bpm, or of the power zones in W (five to seven; Garmin fills unused zones 6 and 7 with 0 and they are left out); heart rate zones also carry `method` (Garmin's `trainingMethod`: `HR_MAX`, `HR_RESERVE` or `LACTATE_THRESHOLD`) and the `hrmax`, `rhr` and `lthr` Garmin set them from, power zones the `ftp`. `fetched` is the day the profile was downloaded: these are the profile's current zones, not a history, so unlike the thresholds above they do not change with `date`. A sport without five rising zone floors is left out; without a profile in the cache `zones` is absent and `meta.note` says so (the profile is downloaded as described above).

Each activity is computed with the thresholds that applied on its own date. A new test result therefore changes the metrics from its date on and leaves older activities as they were: hrTSS of different periods describes the load relative to the fitness of that time. Progress shows in CTL, efficiency and the tests themselves, not in hrTSS of the same session repeated months apart.

A row recorded with a past date (`set_threshold` with the day of an earlier test) recomputes every activity from that date on at the next read. The first `garmin-auto` row holds the profile as it was on the day it was first downloaded (usually the first analytics read) and is carried back before that day, so older activities use those values until an older test row is recorded.

## Sport groups

Thresholds, zones and weekly volume use a coarse sport group from the Garmin activity type key (for imported CSV files, the activity type label in lower case). The first matching substring wins:

| Group | Substrings |
| --- | --- |
| `run` | `run` |
| `bike` | `cycling`, `biking`, `bike`, `ride`, `bmx`, `gravel`, `cyclocross` |
| `swim` | `swim` |
| `strength` | `strength`, `cardio`, `hiit`, `yoga`, `pilates`, `stretch`, `mobility`, `breath` |
| `nordic` | `cross_country`, `skate_ski`, `classic_ski`, `backcountry_ski`, `snowshoe`, `snow_shoe` |
| `row` | `rowing` |
| `hike` | `hik`, `walk`, `mountaineer`, `climb`, `ski` |
| `other` | everything else, and activities without a type |

So `trail_running` is `run`, `e_bike_fitness` is `bike`, `skate_skiing`, `snowshoeing` and `snow_shoe_ws` are `nordic`, `indoor_rowing` is `row`, and `resort_skiing` (downhill) is `hike`. `nordic` and `row` have no threshold of their own: they use the running LTHR and LT1.

## Per-activity metrics

With `RHR` the resting heart rate and `LTHR` the threshold of the activity's sport, both on the activity's date:

```
hr_method "zones" (time in Garmin's HR zones 1-5 and the profile's zone bounds):
IF_z    = (midHR_z − RHR) / (LTHR − RHR)             midHR_z the middle of zone z, zone 5 up to HRmax; 0 at or below RHR
hrTSS   = Σ_z (t_z / 3600) × IF_z² × 100              t_z the seconds in zone z                           1 place
IF      = √(Σ_z t_z × IF_z² / Σ_z t_z)                                                                    3 places

hr_method "avg" (no time in zones, no zone bounds in the profile, or flags.hr_method "avg"):
IF      = (avg_hr − RHR) / (LTHR − RHR)              0 without avg_hr, when avg_hr ≤ RHR or LTHR ≤ RHR   3 places
hrTSS   = duration_h × IF² × 100                                                                          1 place

EF      = run:  speed in m/min / avg_hr               bike: normalized power / avg_hr                     3 places
EF-GAP  = run:  grade adjusted speed in m/min / avg_hr                                                    3 places
```

IF here is the heart rate reserve between resting and threshold heart rate, so an hour at LTHR scores 100, as an hour at FTP does in the power-based TSS (Allen, Coggan, McGregor 2019). The zone method follows TrainingPeaks' hrTSS, which scores the time in zones derived from LTHR with an estimate of TSS per hour in each zone (Friel: zone 1 about 20-40 an hour, zone 2 about 60, threshold 100) rather than the average heart rate of the whole activity (TrainingPeaks, "Training with TSS vs. hrTSS" and "Estimating Training Stress Score", references 15 and 17). Stress grows with the square of IF, so a session of hard intervals and easy recoveries scores more by zones than from its average: 5 × 3 min in zone 5 with 32 min in zone 1 (average 135 bpm, LTHR 170, resting 50) gives 44 by zones and 39 from the average, while a steady session gives almost the same either way. Zone bounds come from the Garmin profile (`heartRateZones`, cycling the CYCLING zones when the profile has them, every other group the default ones, as in the intensity distribution); time below zone 1 is not in Garmin's zones and adds nothing. `hr_method` of each activity says which method gave its `hrtss`; `flags: {"hr_method": "avg"}` forces the average for every activity (for comparison with models that use the average). hrTSS is one of the load candidates below; the load the model sums is `tss`, with its `if` and `load_source`. `include_activities` returns one row per activity with these values and the inputs: type, sport group, duration, moving time, distance, elevation, heart rate, power, cadence, calories, Garmin training load and training effect, RPE (Foster's CR-10 scale, 1-10; Garmin stores it × 10) and feel (when the activity detail was downloaded), seconds in Garmin's HR zones 1-5, the LTHR and resting heart rate used, and `source` (`db` or `import`).

Rough hrTSS orientation: an hour in zone 1 is about 40-55, an hour in zone 2 about 60-80, an hour at threshold 100, a 10 km race about 80-90, a marathon about 250-300, a 10-hour mountain ultra 500 and more.

## Load sources

Each activity gets one training stress `tss` from the first candidate that gives a positive value, in this order (as TrainingPeaks ranks TSS, rTSS, sTSS and hrTSS: heart rate is the last measured source, because it lags behind short efforts; the athlete's own rating comes after every measurement). All candidates share the scale where an hour at threshold is 100, so they add up in one daily sum and one CTL.

| Order | `load_source` | Sport group | Needs | Intensity factor | Stress |
| --- | --- | --- | --- | --- | --- |
| 1 | `power` | `bike` | normalized power `np_w`, `ftp_w` on the activity's date | IF = NP / FTP | TSS = duration_h × IF² × 100 (Coggan) |
| 2 | `pace` | `run` | Garmin's grade adjusted speed `gap_mps`, `run_threshold_pace_s_per_km` on the activity's date | IF = GAP / (1000 / threshold pace) | rTSS = duration_h × IF² × 100 (McGregor) |
| 3 | `swim_pace` | `swim` | distance, moving time, `css_s_per_100m` on the activity's date | IF = (distance / moving time) / (100 / CSS) | sTSS = moving_h × IF³ × 100 |
| 4 | `hr` | any | time in HR zones and the profile's zone bounds, else average heart rate | IF_z per zone, else IF = (avg_hr − RHR) / (LTHR − RHR) | hrTSS (above, `hr_method`) |
| 5 | `rpe` | any | session RPE 1-10 from the activity detail, duration | none (`if` absent) | sRPE = RPE × duration_min × `rpe_calibration` (Foster) |
| - | `none` | | none of the above | | no `tss` |

- **Zero is no load.** A candidate whose stress rounds to 0 (a power meter that read 0, a speed of 0) is skipped, so it does not hide the heart-rate stress of the same activity. An activity with no candidate has no `tss` and no `if` at all, never 0; it adds nothing to the daily sum.
- **Thresholds of the day.** FTP, threshold pace and CSS are taken on the activity's date, as LTHR is. Without `ftp_w` a ride with power, without `run_threshold_pace_s_per_km` a run with grade adjusted speed, and without `css_s_per_100m` a swim with distance and moving time, falls back to heart rate and `meta.note` says which threshold to record.
- **Rounding.** `tss` to 1 place and `if` to 3 places, both computed from the unrounded intensity factor.
- **Pace is an average.** rTSS proper uses the normalized graded pace (NGP), weighted like normalized power from the second-by-second record. The activity list has only Garmin's average grade adjusted speed, which corrects for hills but not for the variability of the run, so rTSS of interval sessions reads a little low.
- **Swimming is cubed.** sTSS follows TrainingPeaks (reference 18): the intensity factor is the average speed over the moving time against the critical swim speed (CSS), and stress grows with its cube, not its square, because water drag makes the cost of swimming rise faster with speed than that of running. Both the speed and the hours use Garmin's moving time of the activity, so rests that Garmin leaves out of it count neither as slow swimming nor as stress. Example: CSS 75 m/min (`css_s_per_100m` 80) and 1 600 m in 23:10 of moving time give IF 0.92 and sTSS 30. The Garmin profile has no CSS, so it comes only from `set_threshold` (`thresholds_used.by_sport.swim.css` shows it); a swim without distance or moving time, or without CSS, is scored from heart rate as before. The speed is an average of the whole swim, drills and kicking included.
- **Session RPE is an approximation.** Foster's session RPE (RPE × minutes, Foster 1998; Foster et al. 2001) is in its own unit: an RPE of 6 gives 360 an hour, against about 80 for a typical hour scored from heart rate. `rpe_calibration` (default 0.23) brings it to the scale where an hour at threshold is 100, so an hour at RPE 6 scores about 83 and an hour at RPE 10 about 138. The factor is a fixed estimate, not fitted to your own heart-rate or power data; override it with `flags`, e.g. `{"rpe_calibration": 0.2}`. It counts only for activities with no measured source (strength without a heart-rate strap, for example), and only when the RPE was entered in Garmin Connect and the activity detail was downloaded.
- `hrtss` stays on every activity as the heart-rate candidate, and `get_load` with `source: "hrtss"` sums it alone, as the model did before power and pace were added.

## Load model

There are two CTL/ATL/TSB models, with the same averages and different daily stress:

- **`get_load`**: the own model below, from TSS per activity (power, pace, heart rate, RPE) with your thresholds. Use it for "what is my form", TSB, ACWR and load flags; the readiness `load` signal uses it with `source: "hrtss"`.
- **`garmin_load_model`** in `get_training_status` (and at the end of a `get_period_summary` period): the same 42/7-day averages on Garmin's per-activity training load (EPOC), with form bands scaled to CTL because EPOC is not in TSS points. Use it next to Garmin's own status, acute/chronic load and load focus. `get_load` with `source: "garmin_load"` gives the same input with the own flags.

The two read differently in absolute numbers; compare directions, not values.

- **Daily stress.** `source: "auto"` (default) sums the `tss` of the day's activities (load sources above; activities without load count 0); `source: "hrtss"` sums their hrTSS only; `source: "garmin_load"` sums Garmin's per-activity training load (activities without one, including imported ones, count 0). The series runs from the first stored activity to the later of `to` and today; days without activities are 0. The full history is always used, whatever `from` is.
- **CTL, ATL, TSB.** Exponentially weighted averages of the daily stress over 42 days (CTL, fitness) and 7 days (ATL, fatigue), with `k = 1 − e^(−1/N)`; TSB (form) is CTL − ATL at the start of the day (Banister 1991; Allen, Coggan, McGregor 2019). CTL needs about 42 days of history before `from` to settle; with less, the answer says so. Every day of the series, `latest` included, carries `warming_up`: true while fewer than 42 days have passed since the first activity.
- **ACWR.** Mean daily stress of the last 7 days divided by the mean of the last 28 days, both rolling averages ending on the day, windows cut at the start of the series; 0 when the 28-day mean is 0. 2 places.
- **Monotony and strain.** Monotony = mean / sample standard deviation of the last 7 days (0 when the deviation is 0 or there are fewer than 2 days); strain = sum of the last 7 days × monotony (Foster 1998). 2 and 0 places.
- **Per sport.** One model for the whole body is the default, as in TrainingPeaks' Performance Management Chart: every activity adds to the same CTL, ATL and TSB. `include_by_sport: true` adds `by_sport` next to it: for every sport group with an activity up to `to`, CTL, ATL, TSB and ACWR on `to` from that group's activities only, its series starting at the group's first activity. With `include_series` each day of the series also gets the columns `<sport>_ctl`, `<sport>_atl`, `<sport>_tsb` and `<sport>_acwr` (e.g. `run_ctl`, `bike_tsb`) for the groups whose series has begun by then. This is a tool for triathletes and other multisport athletes, because fitness and form carry over between sports only in part: a cycling block raises the total CTL without making the legs ready for a hard run. There are no weights between sports (corrections such as running × 1.2 are coaches' proposals, not a method), so the groups' CTL and ATL add up to the total ones (up to rounding); their ACWR does not, and a group with a short history reads low the same way the total does while warming up.
- **Weeks.** Per ISO week and sport group: sessions, hours, km, elevation gain, TSS (`tss`), hrTSS, Garmin load, and hours in Garmin's HR zones 1-2, 3 and 4-5 (activities with zones only).

### Load flags

`flags` raised on `to`. Override any threshold with `flags`, e.g. `{"acwr_high": 1.4, "week_jump_pct": 10}`; missing keys keep the default, unknown keys and invalid values (a non-number, or for `hr_method` anything but `zones` and `avg`) are ignored with a note.

| Key | Default | Flag |
| --- | --- | --- |
| `acwr_high` | 1.5 | `acwr_high`: ACWR above it, a load spike |
| `acwr_warn` | 1.3 | `acwr_warn`: ACWR above it (up to `acwr_high`), load rising fast |
| `acwr_low` | 0.8 | `acwr_low`: ACWR below it while CTL is above 20 (taper or undertraining); below CTL 20 the ratio says little and the flag stays off |
| `monotony_high` | 2.0 | `monotony_high`: 7-day monotony above it |
| `tsb_low` | −30 | `tsb_low`: TSB below it, deep fatigue |
| `tsb_fresh` | 15 | `tsb_fresh`: TSB above it, fresh (taper or rest) |
| `week_jump_pct` | 15 | `week_jump`: total hours or running km of the last 7 days ending on `to` grew by more than this percentage against the 7 days before (rolling windows, not ISO weeks, so a heavy week still shows on the Monday or Tuesday after it); not raised when the 7 days before hold less than 1 h |
| `z1_min_pct` | 75 | `z1_below_target`: Z1 share of run, bike, nordic and row time below this percentage (see intensity) |
| `rpe_calibration` | 0.23 | no flag: the multiplier of session RPE × minutes for activities with `load_source: "rpe"` (load sources above) |
| `hr_method` | `zones` | no flag: `zones` scores hrTSS from the time in HR zones when the activity has them and the profile has zone bounds, `avg` always from the average heart rate (per-activity metrics above) |

At most one of the three ACWR flags is raised. While `warming_up` is true, `tsb_low` and `tsb_fresh` are not raised: CTL still reads low, so TSB is deeply negative after a few ordinary days. The ACWR, monotony and week-jump flags work as usual.

## Intensity distribution

`intensity` splits the time of the endurance groups `run`, `bike`, `nordic` and `row` in the last 28 days of the range (the whole range when shorter) into three zones (Seiler 2010): Z1 below LT1, Z2 between LT1 and LTHR, Z3 above LTHR. Nordic skiing and rowing are judged against the running LT1 and LTHR, which suits whole-body sports with a similar heart rate response; their efficiency factor is not computed (EF stays running and cycling only). Swimming, strength, hiking and other activities are left out.

- An activity with Garmin's time in HR zones: each Garmin zone goes to Z1, Z2 or Z3 by its heart rate range in the Garmin profile (`heartRateZones`: the zone floors, zone 5 up to the HRmax Garmin uses; cycling uses the CYCLING zones when the profile has them, every other group the default ones) against LT1 and LTHR of the activity's sport and date. A zone whose ceiling is at or below LT1 is Z1, a zone whose floor is at or above LTHR is Z3, the one in between is Z2, and a zone that crosses a threshold is split in proportion to its width in bpm. Example: floors 94/134/154/163/174, HRmax 185, LT1 151, LTHR 168: zone 2 (134-154) is 17/20 Z1 and 3/20 Z2, zone 3 is Z2, zone 4 (163-174) is 5/11 Z2 and 6/11 Z3, zone 5 is Z3.
- Without zone bounds in the profile (no profile yet, or a profile without them), Z1 = zones 1-2, Z2 = zone 3, Z3 = zones 4-5, and `meta.note` says so.
- An activity without zones: its whole duration goes to the zone of its average heart rate (below LT1, below LTHR, else Z3), with LT1 and LTHR of its sport and date.
- Activities with neither are skipped.

The answer has minutes and percentages per zone, the number of activities counted each way (`sessions_with_zones`, `sessions_by_avg_hr`), and the `z1_below_target` flag.

The zone bounds come from the profile as it is now, while Garmin counted the time in zones of each activity with the zones valid on the activity's day. After a change of HRmax, resting heart rate or the zone method, older activities are split with the new bounds, so their split is an approximation.

## Efficiency

`include_efficiency` adds the monthly trend (`YYYY-MM`) of the efficiency factor over aerobic sessions: average heart rate below LT1 of the activity's sport and date (Z1 of the intensity distribution) and at least 30 minutes. Each entry of `activities[]` shows the thresholds it was judged with: `lt1_used` next to `lthr_used`. Running uses EF from speed (and EF-GAP when Garmin gave a grade adjusted speed), cycling EF from normalized power when the activity has it. Per month and sport: `n`, `ef_avg`, `ef_max`, `ef_gap_avg`.

Below LT1 heart rate and pace are close to steady state, so EF reflects aerobic fitness rather than how hard a tempo session was; a session between LT1 and LTHR is left out even though it is still below threshold. A rising EF at the same heart rate means more speed or power per beat, i.e. better aerobic fitness. Compare like with like: the same routes and conditions. Hills and walking breaks lower EF by definition; EF-GAP corrects for gradient, not for walking or surface.

## Morning readiness

`get_readiness` reports seven signals of day D (default today) and turns six of them into a decision. A counted signal is `ok`, `yellow`, `red`, or `unknown` when its data is missing; Garmin's Training Readiness is `info`: shown, never rated. Neither `unknown` nor `info` signals count (`counts.info`, `counts.unknown`).

| Signal | Counted | Value | Compared with | Red | Yellow |
| --- | --- | --- | --- | --- | --- |
| `hrv` | yes | overnight HRV of D; Garmin's HRV status shown, not rated | Garmin's 7-day average and baseline of D (its rolling averages of the raw nights), mean of the 28 nights before (from 7 nights with data; fewer: not compared, noted in the detail) | below `hrv_red_base_factor` × baseline low, or below `hrv_red_mean28_factor` × 28-night mean | below the baseline low, or below `hrv_yellow_weekly_factor` × 7-day average |
| `rhr` | yes | resting heart rate of D | mean of the 28 days before | ≥ mean + `rhr_red_delta` | ≥ mean + `rhr_yellow_delta` |
| `sleep` | yes | sleep score and hours of the night before D | | score below `sleep_score_red` or hours below `sleep_h_red` | score below `sleep_score_yellow` or hours below `sleep_h_yellow` |
| `body_battery` | yes | Body Battery high of D | | below `bb_red` | below `bb_yellow` |
| `training_readiness` | no (`info`) | Garmin Training Readiness of D: the newest morning (after wake-up) value, else the newest of the day; with level and recovery time | | never | never |
| `stress` | yes | average stress of D − 1 (D itself is still running) | | never | above `stress_yellow` |
| `load` | yes | TSB and ACWR of the load model on D, summed from hrTSS (as `source: "hrtss"` of `get_load`); `unknown` while the model warms up (fewer than 42 days since the first activity, detail "load model warming up (N of 42 days)") | | ACWR above `acwr_red` or TSB below `tsb_red` | ACWR above `acwr_yellow` or TSB below `tsb_yellow` |

Decision: at least `decision_red_min` red signals is **REST**; else at least `decision_yellow_min` yellow signals is **MODIFY**; else **GO**.

Garmin's Training Readiness does not vote because it is itself a blend of overnight HRV, sleep, recovery time and recent load. Those inputs are already rated on their own here, so counting Garmin's score as well would count the same night twice: one poor night could give a red Training Readiness on top of a red HRV and a yellow sleep. The decision is built from your own data against your own baselines; Garmin's score stays in `signals` with its level and recovery time so you can compare. `partial` is true when D is today or later, or when a row of D was downloaded before the day had ended, so a later sync may change the answer. `recommendation` gives short advice for the decision.

### Readiness rules

Override any of them with `rules`, e.g. `{"sleep_h_yellow": 7.5, "decision_yellow_min": 3}`. Unknown keys, including the former `readiness_red` and `readiness_yellow`, are ignored with a note.

| Key | Default | Key | Default |
| --- | --- | --- | --- |
| `hrv_red_base_factor` | 0.9 | `bb_red` | 30 |
| `hrv_red_mean28_factor` | 0.85 | `bb_yellow` | 50 |
| `hrv_yellow_weekly_factor` | 0.9 | `stress_yellow` | 50 |
| `rhr_red_delta` | 5 bpm | `acwr_red` | 1.5 |
| `rhr_yellow_delta` | 3 bpm | `acwr_yellow` | 1.3 |
| `sleep_score_red` | 60 | `tsb_red` | −30 |
| `sleep_score_yellow` | 75 | `tsb_yellow` | −20 |
| `sleep_h_red` | 6 h | `decision_red_min` | 1 |
| `sleep_h_yellow` | 7 h | `decision_yellow_min` | 2 |

The HRV rules follow day-to-day HRV-guided training, which compares the night with the athlete's own recent baseline rather than with population norms (Kiviniemi et al. 2007; Plews et al. 2013; Javaloyes et al. 2019); resting heart rate is read the same way (Buchheit 2014).

## Reading the numbers

- **ACWR** detects a sudden jump in load against what you are used to; it does not predict injuries (Gabbett 2016; Hulin et al. 2016; Impellizzeri et al. 2020). After a break of more than 10 days the chronic mean is low and the ratio rises artificially on the first sessions back.
- **hrTSS** comes from heart rate, so it under-rates strength work and short intervals (heart rate lags behind), and over-rates sessions in the heat (cardiac drift). Scoring by time in zones takes back part of the interval gap, not the lag itself. That is why it comes last among the load sources; `load_source` of each activity shows which one counted. Load measured internally and externally answer different questions (Impellizzeri, Marcora, Coutts 2019).
- **Own load vs Garmin load** (`load_ratio_28d`, `load_ratio_usual` in `latest`): the sum of own daily load divided by the sum of Garmin's training load (EPOC), on the days that have both, over the last 28 days of the range, and the median of the same ratio over the earlier 28-day windows of the whole history (from 8 windows on). The two models never agree in absolute terms, but their ratio is stable while nothing changes. When the current ratio is more than 25 % away from the usual one, `meta.note` says "Own load vs Garmin load drifted (ratio a vs usual b): check thresholds or the HR strap": an outdated LTHR, FTP or threshold pace, a new or failing heart-rate strap, or a new power meter usually explains it. With `source: "garmin_load"` there is no ratio.
- **Monotony**: a rest day with stress 0 lowers it strongly, which is intended: varying hard and easy days is the point. Read **strain** as a trend; a jump of more than 30 % week to week deserves attention.
- **TSB in the first 42 days** of the history (`warming_up`) is not fatigue: CTL starts at 0 and climbs slowly, so a week of ordinary training already gives a TSB of −25 or lower. The TSB flags and the `load` signal of the readiness stay off until the model has settled.
- **Readiness**: in the first four weeks without a 28-day history, the resting heart rate and HRV comparisons are weaker; in the first 42 days the `load` signal is `unknown`. On a race day, the decision does not change the race plan.

## Limits

- Power counts for cycling only (running power `run_ftp_w` is not used) and pace for running only; swimming and every other sport use heart rate. Treadmill runs use the speed the watch reports, which may be off. Session RPE counts only for activities without power, pace or heart rate: an RPE never replaces or corrects a measured source, and its calibration to the threshold scale is a fixed approximation. There is no aerobic decoupling.
- Thresholds that were never tested fall back to defaults or approximations (LTHR 0.89 × HRmax, or 170 without HRmax; resting heart rate 50; LT1 = 0.90 × LTHR); the answer then carries a note. Record real values with `set_threshold`.
- Activities without power, pace, heart rate or RPE (as the load sources need them) add no load.
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
13. TrainingPeaks. Running Training Stress Score (rTSS) explained (rTSS after S. McGregor). https://www.trainingpeaks.com/learn/articles/running-training-stress-score-rtss-explained/
14. TrainingPeaks. What is Normalized Graded Pace? (NGP after S. McGregor). https://www.trainingpeaks.com/learn/articles/what-is-normalized-graded-pace/
15. TrainingPeaks. Training with TSS vs. hrTSS: what's the difference? https://www.trainingpeaks.com/learn/articles/training-with-tss-vs-hrtss-whats-the-difference/
16. Foster C, Florhaug JA, Franklin J, Gottschall L, Hrovatin LA, Parker S, Doleshal P, Dodge C. A new approach to monitoring exercise training. J Strength Cond Res. 2001;15(1):109-115.
17. TrainingPeaks. Estimating Training Stress Score (TSS) (TSS per hour by zone after J. Friel). https://www.trainingpeaks.com/learn/articles/estimating-training-stress-score-tss/
18. TrainingPeaks. Calculating swimming TSS score (sTSS from CSS). https://www.trainingpeaks.com/learn/articles/calculating-swimming-tss-score/
