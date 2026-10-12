import { fileURLToPath } from 'node:url';

/**
 * Last-resort login path when Cloudflare blocks every Node transport (strategy 3):
 * python-garminconnect uses curl_cffi with rotating TLS fingerprints. The helper script ships
 * in this package under `scripts/python-login.py`.
 */
export const PYTHON_LOGIN_SCRIPT = 'python-login.py';

export const PYTHON_FALLBACK_COMMAND =
  'uvx --with "garminconnect>=0.3" python python-login.py ~/.garmin-mcp/garmin_tokens.json && garmin import-tokens ~/.garmin-mcp/garmin_tokens.json';

/** Absolute path of the bundled helper script (works from src/ and dist/). */
export function pythonLoginScriptPath(): string {
  return fileURLToPath(new URL(`../scripts/${PYTHON_LOGIN_SCRIPT}`, import.meta.url));
}

/** The fallback command with the real script path filled in. */
export function pythonFallbackCommand(outFile = '~/.garmin-mcp/garmin_tokens.json'): string {
  return `uvx --with "garminconnect>=0.3" python "${pythonLoginScriptPath()}" ${outFile} && garmin import-tokens ${outFile}`;
}
