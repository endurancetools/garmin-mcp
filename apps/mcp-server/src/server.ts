import { McpServer, ResourceTemplate, type ServerContext } from '@modelcontextprotocol/server';
import { InputError } from 'garmin-mcp-config';
import type { GarminService } from 'garmin-mcp-domain';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { toToolError } from './errors.js';
import type { Runtime, SyncProgressOptions } from 'garmin-mcp-domain';
import type { SyncJobProgress } from 'garmin-mcp-store';
import { inputSchema, selectTools, type ToolDef } from './tools.js';

export const SERVER_NAME = 'garmin-mcp';
/** Read from the package's own package.json (src/ in tests, dist/ when installed), so `nx release` bumps it. */
export const SERVER_VERSION: string = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

const INSTRUCTIONS = `Garmin Connect data for the signed-in user, served from a local cache. Read tools download data that is not in the cache yet by themselves (within the daily Garmin request limit), so just call them and answer; there is no need to ask about or describe syncing. If auto fetch is turned off (GARMIN_AUTO_FETCH=false), missing data comes back as meta.sync_hint; then ask the user before calling garmin_sync with it.
- Dates are YYYY-MM-DD in the user's local time zone; "today" is resolved by the server.
- Prefer one coarse call (query_health with several metrics, get_period_summary) over many small ones.
- Every result has meta.source: "cache", "live", "partial" or "local" (computed by the server without Garmin, e.g. create_workout with dry_run: true). On "partial", mention briefly that some days are still downloading (meta.note says when to ask again). meta.fetched_at is when the oldest record in the answer was downloaded; newer ones may be fresher.
- Errors come back as {"error":{"code","message","hint"}}; relay the hint to the user (e.g. to run \`garmin login\`).
- Every result is also in structuredContent (the same JSON, typed by the tool's outputSchema), and a workout is saved only after you showed the user its steps from create_workout with dry_run: true and they agreed.`;

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

/** The result as text for clients without structured output, and the very same JSON as `structuredContent`. */
function structured(value: unknown) {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text' as const, text }], structuredContent: JSON.parse(text) as Record<string, unknown> };
}

/** At most one progress notification per this many ms; the last state is flushed before the response. */
const PROGRESS_INTERVAL_MS = 1_000;

function progressMessage(p: SyncJobProgress): string {
  return `${p.phase}${p.chunk ? ` ${p.chunk.from}..${p.chunk.to}` : ''}, ${p.requests} requests`;
}

/**
 * Sync job progress as MCP `notifications/progress` for a client that sent `_meta.progressToken`;
 * `undefined` without a token, so nothing is sent and the job gets no callback. `progress` is
 * `chunks_done`, which the spec wants increasing, so a state without a new finished chunk is
 * not sent (the first one is). Nothing is sent after `flush`: the token ends with the response,
 * while a long sync keeps running in the background.
 */
function progressReporter(request: ServerContext, now: () => number = Date.now): { ctx: SyncProgressOptions; flush(): Promise<void> } | undefined {
  const progressToken = request.mcpReq['_meta']?.progressToken;
  if (progressToken === undefined) return undefined;
  let latest: SyncJobProgress | undefined;
  let sent: number | undefined;
  let sentAt = -Infinity;
  let closed = false;
  const send = async (p: SyncJobProgress) => {
    sent = p.chunks_done;
    sentAt = now();
    await request.mcpReq
      .notify({
        method: 'notifications/progress',
        params: { progressToken, progress: p.chunks_done, ...(p.chunks_total > 0 && { total: p.chunks_total }), message: progressMessage(p) },
      })
      .catch(() => undefined);
  };
  const advanced = (p: SyncJobProgress) => sent === undefined || p.chunks_done > sent;
  return {
    ctx: {
      onProgress: (p) => {
        if (closed) return;
        latest = { ...p };
        if (advanced(latest) && now() - sentAt >= PROGRESS_INTERVAL_MS) void send(latest);
      },
    },
    flush: async () => {
      if (closed) return;
      closed = true;
      if (latest && advanced(latest)) await send(latest);
    },
  };
}

function registerTool(server: McpServer, def: ToolDef, getService: () => Promise<GarminService>, runtime: Runtime) {
  server.registerTool(
    def.name,
    { title: def.title, description: def.description, inputSchema: inputSchema(def), outputSchema: def.output, annotations: def.annotations },
    async (args: Record<string, unknown>, request: ServerContext) => {
      const started = performance.now();
      const progress = progressReporter(request);
      const ctx = progress?.ctx ?? {};
      try {
        const service = await getService();
        const result = await service.withAutoSync(() => def.run(service, args, ctx), ctx).finally(() => progress?.flush());
        runtime.logger.debug({ tool: def.name, ms: Math.round(performance.now() - started) }, 'tool ok');
        return structured(result);
      } catch (err) {
        // The SDK skips output validation for errors, so they stay text only.
        const error = toToolError(err);
        runtime.logger.warn({ tool: def.name, code: error.code, msg: error.message }, 'tool failed');
        return { ...json({ error }), isError: true };
      }
    },
  );
}

/** `{id}` from a resource URI as a Garmin id; anything else is an input error the reader sees as `{ error }`. */
function resourceId(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const id = Number(raw);
  if (!raw || !Number.isSafeInteger(id) || id <= 0) throw new InputError(`Resource id must be a positive integer, got "${raw ?? ''}"`);
  return id;
}

/** Up to 20 cached ids starting with what the user typed; never calls Garmin. */
async function completeIds(getService: () => Promise<GarminService>, ids: (s: GarminService) => number[], value: string): Promise<string[]> {
  try {
    return ids(await getService())
      .map(String)
      .filter((id) => id.startsWith(value));
  } catch {
    return [];
  }
}

function registerResources(server: McpServer, getService: () => Promise<GarminService>) {
  const readJson = async (uri: URL, read: (s: GarminService) => Promise<unknown> | unknown) => {
    let body: unknown;
    try {
      const service = await getService();
      body = await service.withAutoSync(async () => read(service));
    } catch (err) {
      body = { error: toToolError(err) };
    }
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(body) }] };
  };
  const resource = (name: string, uri: string, description: string, read: (s: GarminService) => Promise<unknown> | unknown) =>
    server.registerResource(name, uri, { description, mimeType: 'application/json' }, (u) => readJson(u, read));
  // Templates are not enumerated in resources/list (`list: undefined`): the cache can hold
  // thousands of activities. Completion of {id} offers the 20 most recent cached ids instead.
  const template = (
    name: string,
    uri: string,
    description: string,
    ids: (s: GarminService) => number[],
    read: (s: GarminService, id: number) => Promise<unknown>,
  ) =>
    server.registerResource(
      name,
      new ResourceTemplate(uri, { list: undefined, complete: { id: (value) => completeIds(getService, ids, value) } }),
      { description, mimeType: 'application/json' },
      (u, vars) => readJson(u, (s) => read(s, resourceId(vars.id))),
    );

  resource('profile', 'garmin://profile', 'User profile: name, units, time zone, VO2max, HR and power zones', (s) => s.getProfile());
  resource('gear', 'garmin://gear', 'Gear list with distances', (s) => s.getGear(false));
  resource('devices', 'garmin://devices', 'Garmin devices, last sync and settings', (s) => s.getDevices());
  resource(
    'activity-types',
    'garmin://activity-types',
    'Garmin activity type keys (e.g. running, trail_running, lap_swimming) with their parent type: the values get_activities `type` filters by and update_activity `type` accepts. Comes from the reference sync.',
    (s) => s.getActivityTypes(),
  );
  resource('sync-status', 'garmin://sync-status', 'Recent sync runs, date coverage and record counts of the local cache', (s) => s.syncStatus());

  template(
    'activity',
    'garmin://activity/{id}',
    'One activity by id: the same summary as get_activity with detail "summary"',
    (s) => s.store.queryActivities({ limit: 20 }).map((a) => a.id),
    (s, id) => s.getActivity(id, 'summary'),
  );
  template(
    'workout',
    'garmin://workout/{id}',
    'One saved workout by id with its steps: the same as get_workout',
    (s) => s.store.getWorkouts({ limit: 20 }).map((w) => w.id),
    (s, id) => s.getWorkout(id),
  );
}

function registerPrompts(server: McpServer) {
  server.registerPrompt(
    'weekly_review',
    {
      title: 'Weekly training review',
      description: 'Review a training week and ask how it felt',
      argsSchema: z.object({ week_of: z.string().optional().describe('Any date in the week, YYYY-MM-DD; default this week') }),
    },
    ({ week_of }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Review my training week${week_of ? ` containing ${week_of}` : ''}. ` +
              'Call get_period_summary (period "week") first, then query_health for sleep, hrv and resting_hr over the same week, and get_training_status. ' +
              'Summarise volume per sport, intensity distribution, recovery signals and form (TSB) in a few short paragraphs, compare with the previous week if useful, ' +
              'flag anything concerning, and finish with two or three questions about how the week felt (energy, soreness, motivation).',
          },
        },
      ],
    }),
  );
  server.registerPrompt(
    'plan_next_week',
    {
      title: 'Plan next week',
      description: 'Propose next week of training and create the workouts on request',
      argsSchema: z.object({
        goal: z.string().optional().describe('Goal, e.g. "half marathon on 2026-11-15" or "base building"'),
        days_available: z.string().optional().describe('e.g. "Mon, Wed, Fri, Sun"'),
      }),
    },
    ({ goal, days_available }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Plan my next training week.${goal ? ` Goal: ${goal}.` : ''}${days_available ? ` Days available: ${days_available}.` : ''} ` +
              'Look at get_period_summary for the last two weeks, get_training_status and query_health (hrv, sleep, resting_hr, last 14 days) before proposing. ' +
              'Propose day by day with purpose, duration and intensity (HR zones or pace). Do not create anything yet: after I approve, ' +
              'show each session with create_workout and dry_run: true, then save it with create_workout (a preset for standard sessions, otherwise a typed definition) and put them on the calendar with schedule_workouts.',
          },
        },
      ],
    }),
  );
}

/**
 * `ttlMs`/`cacheScope` of the list results on protocol 2026-07-28 (2025-era responses carry no
 * cache fields). The lists change only with the configuration, which needs a restart; private,
 * because they depend on the user's tool switches.
 */
const LIST_CACHE = { ttlMs: 3_600_000, cacheScope: 'private' } as const;

/** Build an MCP server bound to `runtime`. One per stdio connection or per HTTP request. */
export function createMcpServer(runtime: Runtime): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS, cacheHints: { 'tools/list': LIST_CACHE, 'resources/list': LIST_CACHE, 'prompts/list': LIST_CACHE } },
  );
  const getService = () => runtime.service();
  const cfg = runtime.config;
  for (const def of selectTools({ enabled: cfg.enabledTools, disabled: cfg.disabledTools, destructive: cfg.enableDestructive })) {
    registerTool(server, def, getService, runtime);
  }
  registerResources(server, getService);
  registerPrompts(server);
  return server;
}
