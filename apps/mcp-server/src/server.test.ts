import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { AuthService } from 'garmin-mcp-auth';
import { GarminError, InputError, loadConfig, silentLogger, type GarminConfig } from 'garmin-mcp-config';
import { GarminService, WorkoutDefinitionError } from 'garmin-mcp-domain';
import type { SyncJobReport, SyncJobRequest, SyncJobRunner, Syncer } from 'garmin-mcp-store';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Runtime } from 'garmin-mcp-domain';
import { toToolError } from './errors.js';
import { createMcpServer } from './server.js';
import { serveHttp } from './transports.js';

const meta = { source: 'cache' };
let autoSyncReads = 0;
const fakeService = {
  withAutoSync: async (read: () => Promise<unknown>) => {
    autoSyncReads++;
    return read();
  },
  getActivities: async (q: unknown) => ({ data: { activities: [{ id: 1, query: q }] }, meta }),
  queryHealth: async () => {
    throw new GarminError('AUTH_EXPIRED', 'Refresh token rejected', { hint: 'Run `garmin login`.' });
  },
  syncStatus: () => ({ today: '2026-10-08', tables: [] }),
  getProfile: async () => ({ data: { name: 'Test' }, meta }),
  createWorkout: async () => {
    throw new WorkoutDefinitionError('min (160 bpm) must be lower than max (150 bpm)', 'steps[2].steps[0].target', 'Swap the bounds.');
  },
  getActivityTypes: async () => ({ data: { activity_types: [{ key: 'trail_running', parent: 'running' }] }, meta }),
  getActivity: async (id: number, detail: string) => ({ data: { id, detail, name: 'Morning Run' }, meta }),
  getWorkout: async (id: number) => ({ data: { workout_id: id, name: 'Easy Z2' }, meta }),
  store: {
    queryActivities: (q: { limit?: number }) => [{ id: 21_001 }, { id: 21_002 }, { id: 3 }].slice(0, q.limit),
    getWorkouts: (q: { limit?: number }) => [{ id: 1_727_354_116 }].slice(0, q.limit),
  },
} as unknown as GarminService;

function runtime(overrides: Partial<GarminConfig> = {}, service: GarminService = fakeService): Runtime {
  const config = { ...loadConfig({ env: { HOME: os.tmpdir() } }), ...overrides };
  return {
    config,
    logger: silentLogger,
    auth: {} as AuthService,
    client: {} as Runtime['client'],
    service: async () => service,
    account: async () => ({ hash: 'x', displayName: null, fullName: null }),
    close: () => undefined,
  };
}

async function connect(rt: Runtime) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(rt);
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const text = (res: unknown) => JSON.parse(((res as { content: { text: string }[] }).content)[0]?.text ?? 'null') as Record<string, unknown>;

describe('MCP server', () => {
  it('exposes 17 tools, and destructive ones only when enabled', async () => {
    const tools = (await (await connect(runtime())).listTools()).tools.map((t) => t.name);
    expect(tools).toHaveLength(17);
    expect(tools).not.toContain('delete_activity');
    const all = (await (await connect(runtime({ enableDestructive: true }))).listTools()).tools;
    expect(all).toHaveLength(20);
    const del = all.find((t) => t.name === 'delete_activity');
    expect(del?.annotations?.destructiveHint).toBe(true);
    expect(del?.description?.startsWith('PERMANENTLY deletes')).toBe(true);
  });

  it('lets create_workout overwrite a saved workout only when destructive tools are enabled', async () => {
    const off = await connect(runtime());
    const res = await off.callTool({ name: 'create_workout', arguments: { preset: { name: 'easy_z2', params: { duration_min: 30 } }, workout_id: 1727354116 } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('GARMIN_ENABLE_DESTRUCTIVE=true');
    const on = (await (await connect(runtime({ enableDestructive: true }))).listTools()).tools.find((t) => t.name === 'create_workout');
    expect(Object.keys(on?.inputSchema.properties ?? {})).toContain('workout_id');
    expect(on?.annotations?.destructiveHint).toBe(true);
    expect(on?.description).toContain('overwrites that saved workout');
  });

  it('honours allow and deny lists', async () => {
    const tools = (await (await connect(runtime({ enabledTools: ['get_activities', 'query_health'], disabledTools: ['query_health'] }))).listTools()).tools;
    expect(tools.map((t) => t.name)).toEqual(['get_activities']);
  });

  it('publishes JSON schemas, including the typed workout definition', async () => {
    const tools = (await (await connect(runtime())).listTools()).tools;
    const create = tools.find((t) => t.name === 'create_workout');
    expect(JSON.stringify(create?.inputSchema)).toContain('repeat');
    expect(Object.keys(create?.inputSchema.properties ?? {})).toEqual(['preset', 'definition', 'garmin_json']);
    expect(create?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    // The preview takes the same workout input and is read-only and local, so clients need not ask before it.
    const preview = tools.find((t) => t.name === 'preview_workout');
    expect(preview?.inputSchema.properties).toEqual(create?.inputSchema.properties);
    expect(preview?.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect(JSON.stringify(create?.inputSchema)).toContain('strength_circuit');
    const qh = tools.find((t) => t.name === 'query_health');
    expect(qh?.inputSchema.required).toContain('metrics');
  });

  it('tool list stays within the context budget', async () => {
    // Clients pass name, description and inputSchema of every tool to the model with every
    // request; outputSchema is not part of the model's tool definition, so it only counts
    // towards the size of tools/list itself. Shared workout schemas sit in `$defs`
    // once per tool instead of being copied into every field that uses them.
    const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
    const context = (list: { name: string; description?: string; inputSchema: unknown }[]) =>
      size(list.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })));
    const tools = (await (await connect(runtime())).listTools()).tools;
    const all = (await (await connect(runtime({ enableDestructive: true }))).listTools()).tools;
    const create = tools.find((t) => t.name === 'create_workout')?.inputSchema;
    const preview = tools.find((t) => t.name === 'preview_workout')?.inputSchema;
    const overwrite = all.find((t) => t.name === 'create_workout')?.inputSchema;
    expect(context(tools)).toBeLessThanOrEqual(39_000);
    expect(size(create)).toBeLessThanOrEqual(11_500);
    expect(context(all)).toBeLessThanOrEqual(41_000);
    expect(size(tools)).toBeLessThanOrEqual(66_000);
    expect(size(all)).toBeLessThanOrEqual(70_000);
    // The preview is create_workout without `workout_id`. Without destructive tools create_workout
    // is a strict object (a stray workout_id fails loudly); the preview stays lenient.
    const { workout_id: _overwrite, ...properties } = overwrite?.properties ?? {};
    expect(preview).toEqual({ ...overwrite, properties });
    expect(create).toEqual({ ...preview, additionalProperties: false });
    expect(JSON.stringify(create)).toContain('"$ref":"#/$defs/Target"');
  });

  it('calls a tool and returns JSON with meta', async () => {
    const client = await connect(runtime());
    const before = autoSyncReads;
    const res = await client.callTool({ name: 'get_activities', arguments: { type: 'running', limit: 5 } });
    expect(res.isError).toBeFalsy();
    // Every tool goes through auto sync, which fills what the read reports missing.
    expect(autoSyncReads).toBe(before + 1);
    expect(text(res)).toEqual({ data: { activities: [{ id: 1, query: { type: 'running', limit: 5, sort: 'desc' } }] }, meta });
    // The same JSON as structured content, validated against outputSchema by the SDK on both ends.
    expect(res.structuredContent).toEqual(text(res));
  });

  it('publishes an output schema for every tool: the { data, meta } envelope', async () => {
    const all = (await (await connect(runtime({ enableDestructive: true }))).listTools()).tools;
    expect(all).toHaveLength(20);
    // SDK 2 types `properties` as a plain object, so the fields are looked up through a record.
    const props = (t: (typeof all)[number]) => (t.outputSchema?.properties ?? {}) as Record<string, unknown>;
    const envelope = (t: (typeof all)[number]) => ({ name: t.name, type: t.outputSchema?.type, required: t.outputSchema?.required, meta: props(t)['meta'] });
    expect(all.map(envelope)).toEqual(all.map((t) => ({ name: t.name, type: 'object', required: ['data', 'meta'], meta: { $ref: '#/$defs/ResponseMeta' } })));
    const activities = all.find((t) => t.name === 'get_activities');
    expect(JSON.stringify(activities && props(activities)['data'])).toContain('"avg_hr_bpm"');
  });

  it('reports sync progress as notifications/progress only when the client asks for it', async () => {
    // A real service on a fake job runner that reports three finished chunks at once.
    const requests: SyncJobRequest[] = [];
    const jobs = {
      current: () => undefined,
      limits: () => ({ requests_today: 9, max_requests_per_day: 600 }),
      start: async (req: SyncJobRequest): Promise<SyncJobReport> => {
        requests.push(req);
        const chunks = [['2026-10-06', '2026-10-12'], ['2026-09-29', '2026-10-05'], ['2026-09-22', '2026-09-28']] as const;
        chunks.forEach(([from, to], i) => req.onProgress?.({ phase: 'daily', chunk: { from, to }, chunks_done: i + 1, chunks_total: 3, requests: 3 * (i + 1) }));
        return { id: 1, scope: req.scope, from: req.from, to: req.to, status: 'done', requests: 9, fetched: { sleep: 21 }, errors: [], chunks_done: 3, chunks_total: 3, started_at: 0, finished_at: 1 };
      },
    } as unknown as SyncJobRunner;
    const service = new GarminService({
      client: {} as GarminService['client'],
      store: {} as GarminService['store'],
      syncer: { today: () => '2026-10-12' } as Syncer,
      jobs,
      timeZone: 'Europe/Warsaw',
      downloadDir: os.tmpdir(),
    });
    const client = await connect(runtime({}, service));
    const args = { name: 'garmin_sync', arguments: { scope: 'health', from: '2026-09-22', to: '2026-10-12' } };
    const notes: { progress: number; total?: number; message?: string }[] = [];
    const res = await client.callTool(args, { onprogress: (p) => notes.push(p) });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ data: { status: 'done', chunks: '3/3' } });
    expect(notes.length).toBeGreaterThanOrEqual(1);
    expect(notes.every((n) => n.total === 3 && typeof n.message === 'string')).toBe(true);
    // Throttled to one per second, but the last state always arrives before the response.
    expect(notes.at(-1)).toEqual({ progress: 3, total: 3, message: 'daily 2026-09-22..2026-09-28, 9 requests' });
    expect(notes.map((n) => n.progress)).toEqual([...new Set(notes.map((n) => n.progress))].toSorted());
    expect(requests[0]?.onProgress).toBeTypeOf('function');

    await client.callTool(args);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.onProgress).toBeUndefined();
  });

  it('keeps errors as text without structured content', async () => {
    const client = await connect(runtime());
    const res = await client.callTool({ name: 'query_health', arguments: { metrics: ['hrv'] } });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toBeUndefined();
  });

  it('returns errors as results with code and hint', async () => {
    const client = await connect(runtime());
    const res = await client.callTool({ name: 'query_health', arguments: { metrics: ['hrv'] } });
    expect(res.isError).toBe(true);
    expect(text(res)).toEqual({ error: { code: 'AUTH_EXPIRED', message: 'Refresh token rejected', hint: 'Run `garmin login`.' } });
  });

  it('returns workout definition errors with the step path and hint', async () => {
    const client = await connect(runtime());
    const res = await client.callTool({ name: 'create_workout', arguments: { preset: { name: 'easy_z2', params: { duration_min: 30 } } } });
    expect(res.isError).toBe(true);
    expect(text(res)).toEqual({
      error: { code: 'INVALID_INPUT', message: 'steps[2].steps[0].target: min (160 bpm) must be lower than max (150 bpm)', hint: 'Swap the bounds.' },
    });
  });

  it('reports only deliberate input errors as INVALID_INPUT', () => {
    expect(toToolError(new InputError('Invalid cursor', 'Pass next_cursor.'))).toEqual({ code: 'INVALID_INPUT', message: 'Invalid cursor', hint: 'Pass next_cursor.' });
    // Thrown by the runtime on a bug or an unexpected Garmin response, not by bad input.
    expect(toToolError(new TypeError("Cannot read properties of undefined (reading 'x')"))).toMatchObject({ code: 'INTERNAL' });
    expect(toToolError(new RangeError('Invalid time value'))).toMatchObject({ code: 'INTERNAL' });
  });

  it('names array items by index in validation issues', () => {
    const schema = z.object({ steps: z.array(z.object({ target: z.object({ zone: z.number() }) })) });
    const error = schema.safeParse({ steps: [{ target: { zone: 1 } }, { target: { zone: 'x' } }] }).error;
    expect(toToolError(error).issues?.map((i) => i.path)).toEqual(['steps[1].target.zone']);
  });

  it('rejects invalid input before reaching the domain', async () => {
    const client = await connect(runtime());
    const res = await client.callTool({ name: 'query_health', arguments: { metrics: ['mood'] } });
    expect(res.isError).toBe(true);
  });

  it('serves activity and workout templates with id completion, without listing them', async () => {
    const client = await connect(runtime());
    const templates = (await client.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate);
    expect(templates).toEqual(['garmin://activity/{id}', 'garmin://workout/{id}']);
    expect((await client.listResources()).resources.map((r) => r.uri)).not.toContain('garmin://activity/1');
    const body = (uri: string) => client.readResource({ uri }).then((r) => JSON.parse((r.contents[0] as { text: string }).text) as Record<string, unknown>);
    expect(await body('garmin://activity/1')).toEqual({ data: { id: 1, detail: 'summary', name: 'Morning Run' }, meta });
    expect(await body('garmin://workout/1727354116')).toEqual({ data: { workout_id: 1727354116, name: 'Easy Z2' }, meta });
    expect(await body('garmin://activity/abc')).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    const complete = (uri: string, value: string) => client.complete({ ref: { type: 'ref/resource', uri }, argument: { name: 'id', value } }).then((r) => r.completion.values);
    expect(await complete('garmin://activity/{id}', '')).toEqual(['21001', '21002', '3']);
    expect(await complete('garmin://activity/{id}', '210')).toEqual(['21001', '21002']);
    expect(await complete('garmin://workout/{id}', '')).toEqual(['1727354116']);
  });

  it('serves resources and prompts', async () => {
    const client = await connect(runtime());
    const resources = (await client.listResources()).resources.map((r) => r.uri);
    expect(resources).toEqual(['garmin://profile', 'garmin://gear', 'garmin://devices', 'garmin://activity-types', 'garmin://sync-status']);
    const types = await client.readResource({ uri: 'garmin://activity-types' });
    expect(JSON.parse((types.contents[0] as { text: string }).text)).toMatchObject({ data: { activity_types: [{ key: 'trail_running', parent: 'running' }] } });
    const status = await client.readResource({ uri: 'garmin://sync-status' });
    expect(JSON.parse((status.contents[0] as { text: string }).text)).toMatchObject({ today: '2026-10-08' });
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
    expect(prompts).toEqual(['weekly_review', 'plan_next_week']);
    const p = await client.getPrompt({ name: 'weekly_review', arguments: { week_of: '2026-10-05' } });
    expect(JSON.stringify(p.messages)).toContain('get_period_summary');
  });

  it('matches the tools and prompts listed in the Claude Desktop manifest', async () => {
    const manifest = JSON.parse(readFileSync(new URL('../../../mcpb/manifest.json', import.meta.url), 'utf8')) as {
      long_description: string;
      tools: { name: string; description: string }[];
      prompts: { name: string; arguments?: string[]; text: string }[];
    };
    const client = await connect(runtime({ enableDestructive: false }));
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(manifest.tools.map((t) => t.name)).toEqual(tools);
    expect(manifest.long_description).toContain(`${tools.length} coarse tools`);
    const prompts = (await client.listPrompts()).prompts;
    expect(manifest.prompts.map((p) => p.name)).toEqual(prompts.map((p) => p.name));
    // Manifest `text` is the server prompt rendered with every argument as an mcpb `${arguments.<name>}` placeholder.
    for (const prompt of prompts) {
      const names = (prompt.arguments ?? []).map((a) => a.name);
      const entry = manifest.prompts.find((p) => p.name === prompt.name);
      expect(entry?.arguments ?? []).toEqual(names);
      const rendered = await client.getPrompt({ name: prompt.name, arguments: Object.fromEntries(names.map((n) => [n, `\${arguments.${n}}`])) });
      expect(entry?.text).toBe(rendered.messages.map((m) => (m.content as { text: string }).text).join());
    }
  });
});

describe('HTTP transport', () => {
  const servers: { close(): void }[] = [];
  afterEach(() => servers.splice(0).forEach((s) => s.close()));

  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
  const post = (port: number, token?: string) =>
    fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(init),
    });

  it('requires the bearer token when one is configured', async () => {
    const srv = await serveHttp(runtime({ httpToken: 's3cret' }), { port: 0, host: '127.0.0.1' });
    servers.push(srv);
    const port = (srv.address() as { port: number }).port;
    expect((await post(port)).status).toBe(401);
    expect((await post(port, 'wrong!')).status).toBe(401);
    const ok = await post(port, 's3cret');
    expect(ok.status).toBe(200);
    // A 2025 client is served statelessly by the SDK's fallback, which answers as an SSE event.
    expect(await ok.text()).toContain('"name":"garmin-mcp"');
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
  });

  it('serves protocol 2026-07-28 on the same endpoint', async () => {
    const srv = await serveHttp(runtime({ httpToken: 's3cret' }), { port: 0, host: '127.0.0.1' });
    servers.push(srv);
    const port = (srv.address() as { port: number }).port;
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: 'Bearer s3cret' } } });
    const client = new Client({ name: 'sdk-2', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    await client.connect(transport);
    expect(client.getProtocolEra()).toBe('modern');
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(17);
    expect(tools).toMatchObject({ ttlMs: 3_600_000, cacheScope: 'private' });
    const res = await client.callTool({ name: 'get_activities', arguments: { limit: 1 } });
    expect(res.structuredContent).toMatchObject({ data: { activities: [{ id: 1 }] }, meta });
    await client.close();
  });

  /** node:http, because fetch derives Host from the URL. */
  const rawPost = (port: number, headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end(JSON.stringify(init));
    });

  it('rejects a foreign Host or Origin with 403 before checking the token (DNS rebinding)', async () => {
    const srv = await serveHttp(runtime({ httpToken: 's3cret', httpAllowedHosts: ['mcp.example.com'] }), { port: 0, host: '127.0.0.1' });
    servers.push(srv);
    const port = (srv.address() as { port: number }).port;
    // No token at all: 403 rather than 401 shows the guard runs first.
    expect(await rawPost(port, { host: 'evil.example' })).toBe(403);
    expect(await rawPost(port, { host: `localhost:${port}`, origin: 'https://evil.example' })).toBe(403);
    expect(await rawPost(port, { host: `evil.example:${port}`, authorization: 'Bearer s3cret' })).toBe(403);
    expect(await rawPost(port, { host: `localhost:${port}` })).toBe(401);
    expect(await rawPost(port, { host: `localhost:${port}`, authorization: 'Bearer s3cret' })).toBe(200);
    expect(await rawPost(port, { host: `[::1]:${port}`, origin: `http://127.0.0.1:${port}`, authorization: 'Bearer s3cret' })).toBe(200);
    expect(await rawPost(port, { host: 'mcp.example.com', origin: 'https://mcp.example.com', authorization: 'Bearer s3cret' })).toBe(200);
  });

  it('allows only localhost names when GARMIN_HTTP_ALLOWED_HOSTS is unset', async () => {
    const srv = await serveHttp(runtime(), { port: 0, host: '127.0.0.1' });
    servers.push(srv);
    const port = (srv.address() as { port: number }).port;
    expect(await rawPost(port, { host: `127.0.0.1:${port}` })).toBe(200);
    expect(await rawPost(port, { host: 'mcp.example.com' })).toBe(403);
  });

  it('refuses to listen on a public interface without a token', async () => {
    await expect(serveHttp(runtime(), { port: 0, host: '0.0.0.0' })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });
});
