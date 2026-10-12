import { hostHeaderValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, localhostAllowedHostnames } from '@modelcontextprotocol/server';
import { serveStdio as serveMcpStdio } from '@modelcontextprotocol/server/stdio';
import { ConfigError } from 'garmin-mcp-config';
import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { Runtime } from 'garmin-mcp-domain';
import { createMcpServer, SERVER_NAME, SERVER_VERSION } from './server.js';

/**
 * stdio for both protocol eras: the SDK answers `server/discover` (2026-07-28) or `initialize`
 * (2025 clients) and pins one server from the factory to the connection.
 */
export async function serveStdio(runtime: Runtime): Promise<void> {
  serveMcpStdio(() => createMcpServer(runtime), { onerror: (err) => runtime.logger.error({ err: String(err) }, 'stdio error') });
  runtime.logger.info({ transport: 'stdio' }, `${SERVER_NAME} ${SERVER_VERSION} ready`);
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function tokenMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? '');
  if (!m?.[1]) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Stateless streamable HTTP: one MCP server per request on a single endpoint (/mcp), for
 * 2026-07-28 requests and, through the SDK's stateless fallback, for 2025 clients.
 * Bearer token required; without one we only bind to localhost. `Host` and `Origin`
 * are checked before the token (DNS rebinding): localhost names plus GARMIN_HTTP_ALLOWED_HOSTS.
 */
export async function serveHttp(runtime: Runtime, opts: { port?: number; host?: string } = {}): Promise<http.Server> {
  const { config, logger } = runtime;
  const host = opts.host ?? config.httpHost;
  const port = opts.port ?? config.port;
  if (!config.httpToken && !LOCAL_HOSTS.has(host)) {
    throw new ConfigError(
      `Refusing to serve HTTP on ${host} without GARMIN_MCP_HTTP_TOKEN`,
      'Set GARMIN_MCP_HTTP_TOKEN to a long random secret, or bind to 127.0.0.1.',
    );
  }
  const handler = createMcpHandler(() => createMcpServer(runtime), { onerror: (err) => logger.warn({ err: String(err) }, 'MCP HTTP request rejected') });
  const mcp = toNodeHandler(handler);
  const allowedHosts = [...new Set([...localhostAllowedHostnames(), ...config.httpAllowedHosts])];
  const validHost = hostHeaderValidation(allowedHosts);
  const validOrigin = originValidation(allowedHosts);
  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, name: SERVER_NAME, version: SERVER_VERSION }));
      return;
    }
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    // Both guards answer 403 themselves when they return false.
    if (!validHost(req, res) || !validOrigin(req, res)) return;
    if (config.httpToken && !tokenMatches(req.headers.authorization, config.httpToken)) {
      res.writeHead(401, { 'www-authenticate': 'Bearer' }).end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    mcp(req, res).catch((err: unknown) => {
      logger.error({ err: String(err) }, 'HTTP request failed');
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  httpServer.on('close', () => void handler.close());
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => resolve());
  });
  logger.info({ transport: 'streamable-http', host, port, auth: Boolean(config.httpToken) }, `${SERVER_NAME} ${SERVER_VERSION} listening on http://${host}:${port}/mcp`);
  return httpServer;
}
