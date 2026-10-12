import { pino, type Logger } from 'pino';

export type { Logger } from 'pino';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Paths pino blanks out wherever they appear in a log object. */
const REDACT = [
  'password',
  '*.password',
  'headers.authorization',
  'headers.Authorization',
  '*.headers.authorization',
  '*.headers.Authorization',
  'access_token',
  'refresh_token',
  '*.access_token',
  '*.refresh_token',
  'di_token',
  'di_refresh_token',
  'serviceTicketId',
];

/**
 * Logger writing JSON lines to stderr. stdout is reserved for the MCP stdio
 * protocol, so nothing here may ever write to fd 1.
 */
export function createLogger(level: LogLevel = 'info', name = 'garmin-mcp'): Logger {
  return pino(
    { name, level, redact: { paths: REDACT, censor: '[redacted]' } },
    pino.destination({ fd: 2, sync: true }),
  );
}

/** A logger that drops everything; the default for library code and tests. */
export const silentLogger: Logger = pino({ level: 'silent' });
