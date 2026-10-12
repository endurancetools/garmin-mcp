#!/usr/bin/env python3
"""Log in to Garmin Connect with python-garminconnect and write a token file for garmin-mcp.

Fallback for when Cloudflare blocks every Node transport (strategy 3):
python-garminconnect rotates TLS fingerprints through curl_cffi.

Usage:
    uvx --with "garminconnect>=0.3" python python-login.py [OUT_FILE]

Then import the tokens:
    garmin import-tokens OUT_FILE
"""

import getpass
import os
import sys
from pathlib import Path


def main() -> int:
    try:
        from garminconnect import Garmin
    except ImportError:
        print('garminconnect is not installed. Run: uvx --with "garminconnect>=0.3" python python-login.py', file=sys.stderr)
        return 2

    out = Path(sys.argv[1] if len(sys.argv) > 1 else "~/.garmin-mcp/garmin_tokens.json").expanduser()
    email = os.environ.get("GARMIN_EMAIL") or input("Garmin email: ").strip()
    password = os.environ.get("GARMIN_PASSWORD") or getpass.getpass("Garmin password: ")

    garmin = Garmin(email=email, password=password, prompt_mfa=lambda: input("MFA code: ").strip())
    garmin.login()

    out.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    # Garmin.client.dump() writes {di_token, di_refresh_token, di_client_id} as 0600.
    garmin.client.dump(str(out))
    os.chmod(out, 0o600)

    print(f"Tokens written to {out}")
    print(f"Next: garmin import-tokens {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
