---
title: "Getting started: connect Garmin Connect to Claude"
description: "Set up Garmin MCP in a few minutes: Node.js 22, Claude Code, Claude Desktop or another MCP client, and a one-time Garmin Connect sign-in in your browser."
nav_order: 2
---
Everything starts the same way, whichever client you use.

## Before you begin

- **Node.js 22 or newer.** Check with `node --version`; get it from [nodejs.org](https://nodejs.org) if needed.
- **A Garmin Connect account** with a watch or scale syncing to it.
- **Chrome, Edge, Brave or Chromium** for the sign-in window. Without a browser the sign-in falls back to the terminal, see [Signing in](sign-in.md).

## Connect Garmin to your AI assistant

Pick the guide for your client:

- [Claude Code](getting-started/claude-code.md)
- [Claude Desktop](getting-started/claude-desktop.md)
- [Other clients](getting-started/other-clients.md)

## Sign in once

Ask your first question. A browser window opens Garmin's own sign-in page. Sign in as you normally do, including a verification code or a CAPTCHA if Garmin asks. The window closes by itself. If the assistant says the window is still waiting, finish there and ask again. Only the tokens Garmin issues are stored, in `~/.garmin-mcp`; your password never passes through the tool.

You can also sign in from the terminal, before or instead; a server in Docker or reached over the network needs that ([Signing in](sign-in.md)):

```bash
npx -y garmin-mcp-cli login
```

To check at any time:

```bash
npx -y garmin-mcp-cli status
```

## Optional: pre-load your data

Nothing is downloaded until a question needs it, and the first question about a period waits a few seconds for the download. If you prefer to have the last months ready, download them once:

```bash
npx -y garmin-mcp-cli sync --scope all --from 2026-07-01 --to 2026-09-30
```

Downloads are gentle with Garmin: 7-day chunks, short random pauses, at most 600 requests a day. A 90-day history takes about an hour and happens only once; stored days are never downloaded again.
