---
title: Signing in
nav_order: 4
---
```bash
npx -y garmin-mcp-cli login
```

## In the browser (default)

The command opens Garmin's real sign-in page in your installed Chrome, Edge, Brave or Chromium, in a temporary profile that is removed afterwards. You sign in there, including a verification code (MFA) or a CAPTCHA if Garmin asks. The tool only catches the one-time ticket Garmin redirects to after a successful sign-in and exchanges it for tokens. Your password never passes through the tool.

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

Tokens refresh themselves. If Garmin invalidates them (for example after a password change), run `login` again.

## Signing out

```bash
npx -y garmin-mcp-cli logout
```

removes the tokens. The downloaded data stays until you delete the folder.
