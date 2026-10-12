---
title: Troubleshooting
nav_order: 7
---
## First stop: `garmin doctor`

```bash
npx -y garmin-mcp-cli doctor
```

It checks the sign-in strategy, that Garmin's hosts are reachable, file permissions, whether tokens are present and valid, and the database driver, and prints what to do about anything that fails.

## The client does not show the server

- **`npx` not found** (typical in Claude Desktop): the app does not see your shell's PATH. Use the full path to `npx` as the command (`which npx` prints it), or install Node.js with the official installer and restart the app.
- **Node.js too old**: the server needs Node.js 22 or newer (`node --version`).
- **First start is slow**: `npx` downloads the package on first use; give it a minute, then reconnect.
- Logs: Claude Desktop → Settings → Developer → Open Logs Folder → `mcp-server-garmin.log`. Claude Code: `/mcp` shows the connection state. Set `GARMIN_LOG_LEVEL=debug` for more.

## Sign-in problems

- **The browser window does not open**: set `GARMIN_BROWSER_PATH` to your Chrome, Edge, Brave or Chromium, or sign in from the terminal with `--strategy fetch`.
- **Garmin shows a CAPTCHA or asks for a code**: complete it in the window; that is expected.
- **The terminal sign-in is blocked by Cloudflare**: use the browser, or sign in with Python and import the tokens ([Signing in](sign-in.md)).
- **"Not logged in" after it worked before**: tokens were invalidated (password change, long inactivity). Run `login` again.

## Answers say data is missing or still downloading

- The first question about a period downloads it; long ranges continue in the background. Ask again in a minute, or pre-load with `npx -y garmin-mcp-cli sync --scope all --from <date> --to <date>`.
- **Paused for 6 hours**: Garmin answered 429 or a Cloudflare challenge. Downloads resume by themselves; the cached data keeps working.
- **Daily budget reached**: at most 600 requests a day by default. Tomorrow continues where it stopped.
- **`GARMIN_AUTO_FETCH=false`** means nothing is downloaded unless you say so; the assistant tells you which days are missing.

## "Refuses to start: permissions"

Tokens and the database must be readable only by you. On macOS and Linux:

```bash
chmod 700 ~/.garmin-mcp && chmod 600 ~/.garmin-mcp/*.json ~/.garmin-mcp/*.db
```

On Windows this check is skipped.

## Windows

Everything works on Windows with Node.js 22 or newer; no compiler is needed. Use the same `npx -y garmin-mcp-server` command in your client.

## Still stuck

Open an issue at [github.com/endurancetools/garmin-mcp/issues](https://github.com/endurancetools/garmin-mcp/issues) with the output of `garmin doctor` and the relevant log lines. Do not paste tokens.
