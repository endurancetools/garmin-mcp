import type { AuthService } from 'garmin-mcp-auth';
import { GarminError, loadConfig, silentLogger } from 'garmin-mcp-config';
import { readAccount } from 'garmin-mcp-store';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntime } from './runtime.js';
import { fixture } from './test-utils/fake.js';

/**
 * A runtime on a temporary data directory whose Garmin answers come from `fetch`: the profile
 * belongs to whoever signed in last (`guid`), and nobody is signed in until `loginWithBrowser`.
 */
function signedOutRuntime() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'garmin-runtime-'));
  const config = loadConfig({ env: { HOME: home, GARMIN_MIN_REQUEST_INTERVAL_MS: '0' } });
  const state = { guid: undefined as string | undefined, next: 'guid-a', signIns: 0, profileRequests: 0 };
  let finish: (() => void) | undefined;
  const auth = {
    getAccessToken: async () => {
      if (!state.guid) throw new GarminError('AUTH_NOT_LOGGED_IN', 'No Garmin tokens found');
      return 'token';
    },
    invalidate: async () => undefined,
    loginWithBrowser: async () => {
      state.signIns++;
      // Stays "in the browser" until the test lets the user finish.
      await new Promise<void>((resolve) => (finish = resolve));
      state.guid = state.next;
      return { strategy: 'browser' as const, clientId: 'c', expiresAt: new Date(0) };
    },
  } as unknown as AuthService;
  vi.stubGlobal('fetch', async (url: string | URL) => {
    if (!String(url).endsWith('/userprofile-service/socialProfile')) return new Response('not found', { status: 404 });
    state.profileRequests++;
    return Response.json({ ...(fixture('social-profile') as object), garminGUID: state.guid, displayName: `user-${state.guid}` });
  });
  const runtime = createRuntime(config, { logger: silentLogger, auth });
  return { runtime, config, state, finishSignIn: () => finish?.() };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('runtime sign-in', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('signs in once for concurrent callers, then opens the account and ends a pause for the missing sign-in', async () => {
    const { runtime, config, state, finishSignIn } = signedOutRuntime();
    await expect(runtime.service()).rejects.toMatchObject({ code: 'AUTH_NOT_LOGGED_IN' });
    const [first, second] = [runtime.signIn(), runtime.signIn()];
    await tick();
    expect(state.signIns).toBe(1);
    finishSignIn();
    expect(await first).toMatchObject({ displayName: 'user-guid-a' });
    expect(await second).toMatchObject({ displayName: 'user-guid-a' });
    expect(readAccount(config.dataDir)?.displayName).toBe('user-guid-a');
    const service = await runtime.service();

    // A sync that found nobody signed in paused all syncing; the next sign-in ends that pause, not a rate limit's.
    const pause = (reason: string) => {
      service.store.setMeta('sync:paused_until', String(Date.now() + 3_600_000));
      service.store.setMeta('sync:pause_reason', reason);
    };
    pause('AUTH_EXPIRED: The Garmin refresh token is no longer valid');
    const again = runtime.signIn();
    await tick();
    finishSignIn();
    await again;
    expect(state.signIns).toBe(2);
    expect(service.jobs.limits().paused_until).toBeUndefined();
    expect(await runtime.service()).toBe(service);
    pause('RATE_LIMITED: Garmin rate limited /x');
    const third = runtime.signIn();
    await tick();
    finishSignIn();
    await third;
    expect(service.jobs.limits().pause_reason).toBe('RATE_LIMITED: Garmin rate limited /x');
    runtime.close();
  });

  it('opens the database of the account that signed in when it is another one', async () => {
    const { runtime, config, state, finishSignIn } = signedOutRuntime();
    const a = runtime.signIn();
    await tick();
    finishSignIn();
    const accountA = await a;
    const serviceA = await runtime.service();
    serviceA.store.setMeta('owner', 'a');

    state.next = 'guid-b';
    const b = runtime.signIn();
    await tick();
    finishSignIn();
    const accountB = await b;
    expect(accountB.hash).not.toBe(accountA.hash);
    // The profile is asked again instead of answered from the first account's.
    expect(accountB.displayName).toBe('user-guid-b');
    const serviceB = await runtime.service();
    expect(serviceB).not.toBe(serviceA);
    expect(serviceB.store.getMeta('owner')).toBeUndefined();
    expect(fs.readdirSync(config.dataDir).filter((f) => f.endsWith('.db')).toSorted()).toEqual([`garmin-${accountA.hash}.db`, `garmin-${accountB.hash}.db`].toSorted());
    runtime.close();
  });
});
