import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { GarminError, type GarminConfig, type Logger, silentLogger } from 'garmin-mcp-config';

/** Raised when no Chromium-based browser can be found or started. */
export class BrowserUnavailableError extends GarminError {
  readonly kind = 'browser_unavailable' as const;
  constructor(detail: string) {
    super('AUTH_BROWSER_UNAVAILABLE', `Cannot open a browser for sign-in: ${detail}`, {
      hint: 'Install Chrome or Edge, set GARMIN_BROWSER_PATH, or log in from the terminal: `garmin login --strategy curl`.',
    });
  }
}

/** The user closed the window or did not finish in time. */
export class BrowserLoginAbortedError extends GarminError {
  readonly kind = 'browser_login_aborted' as const;
  constructor(reason: string) {
    super('AUTH_BROWSER_LOGIN_ABORTED', `Browser sign-in did not complete: ${reason}`, {
      hint: 'Run `garmin login` again and finish signing in in the window that opens.',
    });
  }
}

const CANDIDATES: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: ['google-chrome', 'google-chrome-stable', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser', 'chromium', 'chromium-browser'],
  win32: [
    String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
    String.raw`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`,
    String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
    String.raw`C:\Program Files\Microsoft\Edge\Application\msedge.exe`,
  ],
};

function onPath(cmd: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const full = path.join(dir, cmd);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

/** Path of an installed Chromium-based browser, or undefined. `configured` wins when it exists. */
export function findBrowser(configured?: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (configured) return fs.existsSync(configured) ? configured : undefined;
  for (const c of CANDIDATES[platform] ?? []) {
    const found = path.isAbsolute(c) ? (fs.existsSync(c) ? c : undefined) : onPath(c);
    if (found) return found;
  }
  return undefined;
}

export function portalSignInUrl(config: Pick<GarminConfig, 'hosts'>): string {
  const u = new URL(config.hosts.portalSignInUrl);
  u.searchParams.set('clientId', 'GarminConnect');
  u.searchParams.set('service', config.hosts.portalServiceUrl);
  return u.toString();
}

/** `ST-...` from a redirect URL to the service, or undefined. */
export function ticketFromUrl(url: string): string | undefined {
  return /[?&]ticket=(ST-[^&#]+)/.exec(url)?.[1];
}

// ------------------------------------------------------------------ minimal CDP client

type CdpEvent = { method: string; params: Record<string, unknown>; sessionId?: string };

/** The subset of a Chrome DevTools Protocol connection the capture needs. */
export interface CdpConnection {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>>;
  onEvent(listener: (e: CdpEvent) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

/** A message channel to the browser: one JSON string per CDP message. */
interface CdpWire {
  write(message: string): void;
  onMessage(listener: (message: string) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

/** Request/response bookkeeping on top of a wire; the same for WebSocket and pipe. */
function cdpOver(wire: CdpWire): CdpConnection {
  let nextId = 1;
  let closed = false;
  const pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  const events: ((e: CdpEvent) => void)[] = [];
  const closers: (() => void)[] = [];
  wire.onMessage((raw) => {
    const data = JSON.parse(raw) as { id?: number; result?: Record<string, unknown>; error?: { message: string } } & CdpEvent;
    if (data.id !== undefined) {
      const p = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) p?.reject(new Error(data.error.message));
      else p?.resolve(data.result ?? {});
    } else if (data.method) {
      for (const l of events) l(data);
    }
  });
  wire.onClose(() => {
    if (closed) return;
    closed = true;
    for (const p of pending.values()) p.reject(new Error('DevTools connection closed'));
    pending.clear();
    for (const l of closers) l();
  });
  return {
    send(method, params = {}, sessionId) {
      if (closed) return Promise.reject(new Error('DevTools connection closed'));
      const id = nextId++;
      return new Promise((res, rej) => {
        pending.set(id, { resolve: res, reject: rej });
        wire.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    onEvent: (l) => events.push(l),
    onClose: (l) => closers.push(l),
    close: () => wire.close(),
  };
}

/** CDP over the browser's DevTools WebSocket (`--remote-debugging-port`). */
export function connectCdp(wsUrl: string): Promise<CdpConnection> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const closers: (() => void)[] = [];
    ws.addEventListener('close', () => {
      for (const l of closers) l();
    });
    ws.addEventListener('error', () => reject(new BrowserUnavailableError('could not connect to the browser DevTools endpoint')), { once: true });
    ws.addEventListener('open', () =>
      resolve(
        cdpOver({
          write: (m) => ws.send(m),
          onMessage: (l) => ws.addEventListener('message', (msg) => l(String(msg.data))),
          onClose: (l) => closers.push(l),
          close: () => ws.close(),
        }),
      ),
    );
  });
}

/**
 * CDP over `--remote-debugging-pipe`: the browser reads commands from its fd 3
 * and writes replies to its fd 4, each message terminated by a NUL byte. Only
 * the parent process holds these descriptors, so nothing else on the machine
 * can attach to the session.
 */
export function pipeCdp(toBrowser: Writable, fromBrowser: Readable): CdpConnection {
  const messages: ((m: string) => void)[] = [];
  const closers: (() => void)[] = [];
  let buffered = Buffer.alloc(0);
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    for (const l of closers) l();
  };
  fromBrowser.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    let nul = buffered.indexOf(0);
    while (nul !== -1) {
      const message = buffered.subarray(0, nul).toString('utf8');
      buffered = buffered.subarray(nul + 1);
      for (const l of messages) l(message);
      nul = buffered.indexOf(0);
    }
  });
  fromBrowser.on('end', end);
  fromBrowser.on('close', end);
  fromBrowser.on('error', end);
  toBrowser.on('error', end);
  return cdpOver({
    write: (m) => {
      toBrowser.write(`${m}\0`);
    },
    onMessage: (l) => messages.push(l),
    onClose: (l) => closers.push(l),
    close: () => {
      toBrowser.destroy();
      fromBrowser.destroy();
      end();
    },
  });
}

const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>Garmin MCP</title>
<body style="font:16px system-ui;padding:3em;text-align:center">
<h2>Signed in to Garmin Connect</h2><p>You can close this window and return to the terminal.</p></body>`;

/**
 * Drive one page: open the sign-in URL, pause the redirect to the service, take
 * the ticket from it and answer with a local page so the single-use ticket never
 * reaches Garmin. Resolves with the ticket.
 */
export async function captureTicket(cdp: CdpConnection, signInUrl: string, serviceUrl: string, timeoutMs: number): Promise<string> {
  const { targetInfos } = (await cdp.send('Target.getTargets')) as { targetInfos: { targetId: string; type: string }[] };
  const page = targetInfos.find((t) => t.type === 'page');
  const targetId = page ? page.targetId : ((await cdp.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string }).targetId;
  const { sessionId } = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string };

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new BrowserLoginAbortedError(`no sign-in within ${Math.round(timeoutMs / 60_000)} min`))), timeoutMs);
    timer.unref();

    cdp.onClose(() => finish(() => reject(new BrowserLoginAbortedError('the browser window was closed'))));
    cdp.onEvent((e) => {
      if (e.method === 'Target.targetDestroyed' && e.params.targetId === targetId) {
        finish(() => reject(new BrowserLoginAbortedError('the browser window was closed')));
        return;
      }
      if (e.method !== 'Fetch.requestPaused' || e.sessionId !== sessionId) return;
      const { requestId, request } = e.params as { requestId: string; request: { url: string } };
      const ticket = ticketFromUrl(request.url);
      if (!ticket) {
        void cdp.send('Fetch.continueRequest', { requestId }, sessionId).catch(() => undefined);
        return;
      }
      void cdp
        .send(
          'Fetch.fulfillRequest',
          {
            requestId,
            responseCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
            body: Buffer.from(DONE_PAGE).toString('base64'),
          },
          sessionId,
        )
        .catch(() => undefined);
      finish(() => resolve(ticket));
    });

    void (async () => {
      await cdp.send('Target.setDiscoverTargets', { discover: true });
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: `${serviceUrl}*`, requestStage: 'Request' }] }, sessionId);
      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Page.navigate', { url: signInUrl }, sessionId);
    })().catch((err: unknown) => finish(() => reject(new BrowserUnavailableError(err instanceof Error ? err.message : String(err)))));
  });
}

// ------------------------------------------------------------------ launching the browser

export interface LaunchedBrowser {
  /** `pipe` unless the browser did not answer on the pipe and the port fallback was used. */
  transport: 'pipe' | 'port';
  connect(): Promise<CdpConnection>;
  close(): Promise<void>;
}

// `--remote-debugging-pipe` turns on navigator.webdriver, and Garmin's sign-in form then answers
// the credentials POST with 403 even for a correct password; the person typing is not automation.
const BASE_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-default-apps',
  '--disable-sync',
  '--disable-blink-features=AutomationControlled',
];

interface Started {
  child: ChildProcess;
  profile: string;
  exited: () => boolean;
  cleanup: () => Promise<void>;
}

function start(executable: string, debugArg: string, headless: boolean | undefined, stdio: ('ignore' | 'pipe')[]): Started {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'garmin-login-'));
  const args = [`--user-data-dir=${profile}`, debugArg, ...BASE_ARGS, ...(headless ? ['--headless=new'] : ['--new-window']), 'about:blank'];
  let child: ChildProcess;
  try {
    child = spawn(executable, args, { stdio, detached: false });
  } catch (err) {
    fs.rmSync(profile, { recursive: true, force: true });
    throw new BrowserUnavailableError(err instanceof Error ? err.message : String(err));
  }
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  // A missing executable surfaces as an async 'error'; the exit flag covers it.
  child.once('error', () => {
    exited = true;
  });
  return {
    child,
    profile,
    exited: () => exited,
    cleanup: async () => {
      for (const s of child.stdio) s?.destroy();
      if (!exited) {
        // The browser still writes to its profile while it shuts down; wait for the exit (bounded).
        const gone = new Promise((r) => child.once('exit', r));
        child.kill();
        await Promise.race([gone, new Promise((r) => setTimeout(r, 3000))]);
      }
      try {
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // A leftover temp profile must not fail a sign-in that already has its ticket.
      }
    },
  };
}

/** Launch with `--remote-debugging-pipe` and wait for an answer to `Browser.getVersion`. */
async function launchPipe(executable: string, headless: boolean | undefined, timeoutMs: number): Promise<{ cdp: CdpConnection; started: Started } | string> {
  const started = start(executable, '--remote-debugging-pipe', headless, ['ignore', 'ignore', 'ignore', 'pipe', 'pipe']);
  const toBrowser = started.child.stdio[3];
  const fromBrowser = started.child.stdio[4];
  if (!(toBrowser instanceof Writable) || !(fromBrowser instanceof Readable)) {
    await started.cleanup();
    return 'no DevTools pipe to the browser';
  }
  const cdp = pipeCdp(toBrowser, fromBrowser);
  let timer: NodeJS.Timeout | undefined;
  const failure = await Promise.race([
    cdp.send('Browser.getVersion').then(
      () => undefined,
      (err: unknown) => (started.exited() ? 'the browser exited during start' : err instanceof Error ? err.message : String(err)),
    ),
    new Promise<string>((r) => {
      timer = setTimeout(() => r('no answer on the DevTools pipe'), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  if (failure === undefined) return { cdp, started };
  cdp.close();
  await started.cleanup();
  return failure;
}

/** Launch with `--remote-debugging-port=0` and read the port the browser picked. */
async function launchPort(executable: string, headless: boolean | undefined, timeoutMs: number): Promise<{ wsUrl: string; started: Started }> {
  const started = start(executable, '--remote-debugging-port=0', headless, ['ignore', 'ignore', 'ignore']);
  const portFile = path.join(started.profile, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(portFile) || fs.readFileSync(portFile, 'utf8').split('\n').length < 2) {
    if (started.exited() || Date.now() > deadline) {
      await started.cleanup();
      throw new BrowserUnavailableError(started.exited() ? `${path.basename(executable)} exited during start` : 'the browser did not open its DevTools port in time');
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const [port, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
  return { wsUrl: `ws://127.0.0.1:${port}${wsPath}`, started };
}

/**
 * Start the browser with a throw-away profile. DevTools goes over a private
 * pipe (`--remote-debugging-pipe`), so no other local process can attach to the
 * session and take the ticket. Only a browser that does not answer on the pipe
 * is restarted with a localhost DevTools port, with a warning in the log.
 * No automation flags, so the window is an ordinary browser.
 */
export async function launchBrowser(
  executable: string,
  opts: { headless?: boolean; logger?: Logger; startTimeoutMs?: number } = {},
): Promise<LaunchedBrowser> {
  const log = opts.logger ?? silentLogger;
  const timeoutMs = opts.startTimeoutMs ?? 15_000;
  const piped = await launchPipe(executable, opts.headless, timeoutMs);
  if (typeof piped !== 'string') {
    log.debug('browser DevTools ready over pipe');
    return { transport: 'pipe', connect: () => Promise.resolve(piped.cdp), close: piped.started.cleanup };
  }
  log.warn(
    { browser: path.basename(executable), reason: piped },
    'browser does not support --remote-debugging-pipe; falling back to a DevTools port on 127.0.0.1, which other local processes can reach during sign-in',
  );
  const { wsUrl, started } = await launchPort(executable, opts.headless, timeoutMs);
  log.debug({ wsUrl }, 'browser DevTools ready over port');
  return { transport: 'port', connect: () => connectCdp(wsUrl), close: started.cleanup };
}

/** Full browser sign-in: launch, capture the ticket, always clean up. */
export async function browserSignIn(
  config: Pick<GarminConfig, 'hosts' | 'browserPath'>,
  opts: { timeoutMs?: number; headless?: boolean; signInUrl?: string; logger?: Logger; onStatus?: (m: string) => void } = {},
): Promise<string> {
  const exe = findBrowser(config.browserPath);
  if (!exe) throw new BrowserUnavailableError(config.browserPath ? `${config.browserPath} does not exist` : 'no Chrome, Edge, Brave or Chromium found');
  opts.onStatus?.(`Opening Garmin sign-in in ${path.basename(exe)}...`);
  const browser = await launchBrowser(exe, { headless: opts.headless, logger: opts.logger });
  let cdp: CdpConnection | undefined;
  try {
    cdp = await browser.connect();
    opts.onStatus?.('Waiting for you to sign in in the browser window (MFA and CAPTCHA are handled there)...');
    return await captureTicket(cdp, opts.signInUrl ?? portalSignInUrl(config), config.hosts.portalServiceUrl, opts.timeoutMs ?? 5 * 60_000);
  } finally {
    try {
      await cdp?.send('Browser.close');
    } catch {
      // already gone
    }
    cdp?.close();
    await browser.close();
  }
}
