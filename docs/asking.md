---
title: What you can ask
description: "Example questions for your AI assistant about Garmin data: sleep, HRV, training load, weekly reviews, and creating Garmin workouts with Claude."
nav_order: 3
---
Ask in your own words. The assistant picks the right tool; you do not need to know tool names.

## Health and recovery

- "How did I sleep this week?" / "Show me my sleep stages for last night."
- "How did my HRV and resting heart rate trend over the summer?"
- "How many steps did I do yesterday?" / "Calories and intensity minutes this week?"
- "Am I fatigued? What is my form right now?" (training status, recovery time, readiness, CTL/ATL/TSB)
- "What is my VO2max and what does Garmin predict for a half marathon?"
- "How did my weight and body fat change over the last three months?"

## Training

- "Show me my last 5 activities." / "What did I do last week?"
- "Show me the lap splits of activity 21001." / "What was the weather during that run?"
- "How much time did I spend in each heart rate zone last week?"
- "Review my training week." / "Summarise my September." / "Summarise my block from 2026-08-04 to 2026-09-28."
- "How many kilometres do my running shoes have?" / "Which firmware is on my watch?"
- "Rename activity 21001 to Parkrun PB." / "Mark yesterday's run as a trail run."
- "Download the GPX of activity 21001."

## Workouts and calendar

- "When is my next race?" / "What is planned for this week?"
- "What are the steps of my workout 'Hill repeats'?"
- "Build me 6×400 m with 90 s rest." / "An easy 45-minute zone 2 run for tomorrow." / "A walk/run session for a beginner."
- "Schedule that for Thursday." / "Take it off the calendar."

When you ask for a new workout, the assistant shows the steps and the estimated duration first and saves nothing until you agree. Saved workouts sync to the watch through Garmin Connect as usual.

## How data arrives

Nothing is downloaded until a question needs it. When a question covers days that are not on your machine yet, the server downloads exactly that range, waits up to about 20 seconds and answers. If the range is long, the rest keeps downloading in the background and the answer says so; ask again in a minute for the complete picture.

Everything downloaded stays on your machine, so repeating a question costs nothing and works offline. Past days are never downloaded again.

If you would rather be asked before anything is downloaded, set `GARMIN_AUTO_FETCH=false` ([configuration](configuration.md)); the assistant then tells you which days are missing and waits for your go-ahead.

## Deleting things

Deleting activities, workouts or weigh-ins, and overwriting a saved workout, are off by default. Turn them on with `GARMIN_ENABLE_DESTRUCTIVE=true` when you want them.
