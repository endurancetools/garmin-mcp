---
title: Garmin MCP
nav_order: 1
---

Ask your AI assistant about your Garmin data. Garmin MCP is a small server that connects Claude Code, Claude Desktop or any other MCP client to your Garmin Connect account: activities, sleep, health, training status, body composition, gear, devices, your workout library and your calendar.

It runs on your computer, keeps a local copy of what it has downloaded, and fetches only the days a question needs. It can also build structured workouts, show them to you first, and put them on your calendar so they sync to the watch.

## Three steps

1. **Sign in to Garmin once.** A browser window opens Garmin's own sign-in page; only the tokens Garmin issues are kept on your machine.
2. **Add the server to your client.** One command or one line of configuration.
3. **Ask.** "How did I sleep this week?", "Review my training week", "When is my next race?", "Build me 6×400 m for Thursday".

## Pick your client

- [Claude Code](getting-started/claude-code.md)
- [Claude Desktop](getting-started/claude-desktop.md)
- [Other clients](getting-started/other-clients.md): Codex, Antigravity CLI, opencode, anything that speaks MCP

Then see [what you can ask](asking.md).

## What it does not do

- It never sees your Garmin password. The sign-in happens on Garmin's page in your browser.
- It never sends your data anywhere except to the AI client you connect it to.
- It never deletes anything unless you turn destructive tools on yourself ([configuration](configuration.md)).
