---
title: Signing in
description: "Sign in to Garmin Connect for Garmin MCP on Garmin's own page in your browser, MFA included; your password never passes through the tool. Signing out too."
nav_order: 4
---
You do not have to sign in before the first question: when a question needs Garmin and nobody is signed in, the server opens Garmin's sign-in page in your browser by itself. You can also sign in from the terminal at any time:

```bash
npx -y garmin-mcp-cli login
```

## From the assistant

Ask your first question. Garmin's sign-in page opens in a browser window; sign in there as you normally do. The question waits up to 30 seconds for you. If you need longer, the assistant says that the window is waiting: finish signing in, then ask again. If you close the window, nothing happens until the next question that needs Garmin, which opens it again. The same window comes back when Garmin stops accepting your tokens, for example after a password change.

This needs the server on your own computer (the usual setup, over stdio) and Chrome, Edge, Brave or Chromium. A server reached over the network or in Docker cannot open a window for you; sign in from the terminal there. `GARMIN_AUTO_LOGIN=false` turns it off everywhere.

## In the browser (default)

Either way, the sign-in opens Garmin's real sign-in page in your installed Chrome, Edge, Brave or Chromium, in a temporary profile that is removed afterwards. You sign in there, including a verification code (MFA) or a CAPTCHA if Garmin asks. The tool only catches the one-time ticket Garmin redirects to after a successful sign-in and exchanges it for tokens. Your password never passes through the tool.

If your browser is installed somewhere unusual, point to it with `GARMIN_BROWSER_PATH`.

## In the terminal

Without a browser (a server, Docker) or with `--strategy curl` or `--strategy fetch`, the command asks for your e-mail, password and MFA code in the terminal and talks to Garmin's mobile sign-in API. Garmin's protection sometimes blocks this path; the browser is the reliable one.

## With Python

If both fail, sign in with the `garminconnect` Python package and import its tokens. `garmin doctor` prints the exact command for your setup; it looks like this:

```bash
uvx --with "garminconnect>=0.3" python <path>/python-login.py ~/.garmin-mcp/garmin_tokens.json
npx -y garmin-mcp-cli import-tokens ~/.garmin-mcp/garmin_tokens.json
```

## Where things are kept

Tokens, the local database and `config.json` live in `~/.garmin-mcp` (change with `GARMIN_DATA_DIR`). Files are readable only by you; the server refuses to start if the permissions are looser.

Tokens refresh themselves. If Garmin invalidates them (for example after a password change), the next question opens the sign-in page again, or run `login` yourself.

## Signing out

```bash
npx -y garmin-mcp-cli logout
```

removes the tokens. The downloaded data stays until you delete the folder.
