import { DEFAULT_APP_IDENTITY, hostsForRegion, InputError } from 'garmin-mcp-config';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GarminClient } from './client.js';
import { ForbiddenError, NotFoundError, RateLimitedError, UnauthorizedError, ValidationError, ClientNetworkError } from './errors.js';
import { API, createServer, fakeTokens } from './test-utils/server.js';

const server = createServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const config = { hosts: hostsForRegion('global'), app: DEFAULT_APP_IDENTITY, concurrency: 4 };

function makeClient(overrides: { sleeps?: number[]; concurrency?: number } = {}) {
  const tokens = fakeTokens();
  const sleeps = overrides.sleeps ?? [];
  const client = new GarminClient({ ...config, concurrency: overrides.concurrency ?? 4 }, tokens.provider, {
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  return { client, tokens, sleeps };
}

describe('GarminClient', () => {
  it('sends Bearer and native app headers', async () => {
    let headers: Headers | undefined;
    server.use(
      http.get(`${API}/device-service/deviceregistration/devices`, ({ request }) => {
        headers = request.headers;
        return HttpResponse.json([]);
      }),
    );
    await makeClient().client.listDevices();
    expect(headers?.get('authorization')).toBe('Bearer test-token');
    expect(headers?.get('user-agent')).toBe('GCM-Android-5.23');
    expect(headers?.get('x-garmin-paired-app-version')).toBe('10861');
    expect(headers?.get('x-gcexperience')).toBe('GC5');
  });

  it('uses the display name for per-user endpoints and caches the profile', async () => {
    let profileCalls = 0;
    let summaryPath = '';
    server.use(
      http.get(`${API}/userprofile-service/socialProfile`, () => {
        profileCalls++;
        return HttpResponse.json({ displayName: 'name with space', profileId: 1 });
      }),
      http.get(`${API}/usersummary-service/usersummary/daily/:name`, ({ request }) => {
        summaryPath = new URL(request.url).pathname + new URL(request.url).search;
        return HttpResponse.json({ calendarDate: '2026-10-07' });
      }),
    );
    const { client } = makeClient();
    await client.getDailySummary('2026-10-07');
    await client.getDailySummary('2026-10-07');
    expect(summaryPath).toBe('/usersummary-service/usersummary/daily/name%20with%20space?calendarDate=2026-10-07');
    expect(profileCalls).toBe(1);
  });

  it('reads every v1 endpoint from fixtures', async () => {
    const { client } = makeClient();
    const d = '2026-10-07';
    const results = await Promise.all([
      client.getUserSettings(),
      client.listActivities({ from: '2026-10-01', to: d }),
      client.getActivity(20000000002),
      client.getActivitySplits(20000000002),
      client.getActivityHrZones(20000000002),
      client.getActivityPowerZones(20000000002),
      client.getActivityWeather(20000000002),
      client.getActivityExerciseSets(20000000002),
      client.getActivityDetails(20000000002),
      client.getDailySummary(d),
      client.getSteps(d),
      client.getHeartRate(d),
      client.getStress(d),
      client.getBodyBattery(d, d),
      client.getRespiration(d),
      client.getSpo2(d),
      client.getIntensityMinutes(d),
      client.getSleep(d),
      client.getHrv(d),
      client.getTrainingStatus(d),
      client.getTrainingReadiness(d),
      client.getVo2Max(d),
      client.getRacePredictions(),
      client.getFitnessAge(d),
      client.listWorkouts(),
      client.getWorkout(700001),
      client.getCalendar(2026, 10),
      client.listGear(),
      client.getGearStats('0a1b2c3d4e5f60718293a4b5c6d7e8f9'),
      client.getGearActivities('0a1b2c3d4e5f60718293a4b5c6d7e8f9'),
      client.getWeighIns('2026-10-01', d),
      client.listDevices(),
      client.getLastUsedDevice(),
      client.getDeviceSettings(3333),
      client.getHeartRateZones(),
      client.getPowerZones(),
    ]);
    expect(results.every((r) => r !== undefined && r !== null)).toBe(true);
  });

  it('pages through all activities', async () => {
    const pages: number[] = [];
    const { client } = makeClient();
    const all = await client.listAllActivities({ pageSize: 2 }, (page) => pages.push(page.length));
    expect(all).toHaveLength(5);
    expect(pages).toEqual([2, 2, 1]);
  });

  it('counts calendar months from zero like Garmin', async () => {
    let path = '';
    server.use(
      http.get(`${API}/calendar-service/year/:y/month/:m`, ({ request }) => {
        path = new URL(request.url).pathname;
        return HttpResponse.json({ calendarItems: [] });
      }),
    );
    await makeClient().client.getCalendar(2026, 1);
    expect(path).toBe('/calendar-service/year/2026/month/0');
  });

  it('refreshes once on 401, then fails with UnauthorizedError', async () => {
    let calls = 0;
    server.use(
      http.get(`${API}/device-service/deviceregistration/devices`, () => {
        calls++;
        return new HttpResponse(null, { status: 401 });
      }),
    );
    const { client, tokens } = makeClient();
    await expect(client.listDevices()).rejects.toBeInstanceOf(UnauthorizedError);
    expect(calls).toBe(2);
    expect(tokens.invalidations).toBe(1);
  });

  it('recovers when the retried request after 401 succeeds', async () => {
    let calls = 0;
    server.use(
      http.get(`${API}/device-service/deviceregistration/devices`, () =>
        ++calls === 1 ? new HttpResponse(null, { status: 401 }) : HttpResponse.json([]),
      ),
    );
    await expect(makeClient().client.listDevices()).resolves.toEqual([]);
  });

  it('backs off 1/2/4/8 s on 5xx and then gives up', async () => {
    server.use(http.get(`${API}/hrv-service/hrv/:date`, () => new HttpResponse('oops', { status: 503 })));
    const { client, sleeps } = makeClient();
    await expect(client.getHrv('2026-10-07')).rejects.toBeInstanceOf(ClientNetworkError);
    expect(sleeps).toEqual([1000, 2000, 4000, 8000]);
  });

  it('honours Retry-After on 429', async () => {
    let calls = 0;
    server.use(
      http.get(`${API}/hrv-service/hrv/:date`, () =>
        ++calls === 1
          ? new HttpResponse(null, { status: 429, headers: { 'retry-after': '3' } })
          : HttpResponse.json({ hrvSummary: null }),
      ),
    );
    const { client, sleeps } = makeClient();
    await client.getHrv('2026-10-07');
    expect(sleeps).toEqual([3000]);
  });

  it('fails fast with RateLimitedError when Retry-After is too long', async () => {
    server.use(
      http.get(`${API}/hrv-service/hrv/:date`, () =>
        new HttpResponse(null, { status: 429, headers: { 'retry-after': '3600' } }),
      ),
    );
    const { client, sleeps } = makeClient();
    const err = await client.getHrv('2026-10-07').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAfter).toBe(3600);
    expect(sleeps).toEqual([]);
  });

  it('classifies 403 HTML as a Cloudflare challenge without retrying', async () => {
    let calls = 0;
    server.use(
      http.get(`${API}/hrv-service/hrv/:date`, () => {
        calls++;
        return new HttpResponse('<!DOCTYPE html><title>Just a moment...</title>', {
          status: 403,
          headers: { 'content-type': 'text/html' },
        });
      }),
    );
    const err = await makeClient().client.getHrv('2026-10-07').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as ForbiddenError).cloudflare).toBe(true);
    expect(calls).toBe(1);
  });

  it('classifies a 200 HTML page as Cloudflare too', async () => {
    server.use(http.get(`${API}/hrv-service/hrv/:date`, () => HttpResponse.html('<html>challenge</html>')));
    await expect(makeClient().client.getHrv('2026-10-07')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('maps 404 to NotFoundError but treats missing gear stats as null', async () => {
    server.use(
      http.get(`${API}/activity-service/activity/:id`, () => new HttpResponse(null, { status: 404 })),
      http.get(`${API}/gear-service/gear/stats/:uuid`, () => new HttpResponse(null, { status: 404 })),
    );
    const { client } = makeClient();
    await expect(client.getActivity(1)).rejects.toBeInstanceOf(NotFoundError);
    await expect(client.getGearStats('0a1b2c3d4e5f60718293a4b5c6d7e8f9')).resolves.toBeNull();
  });

  it('passes through invalid shapes leniently but throws in strict mode', async () => {
    server.use(
      http.get(`${API}/hrv-service/hrv/:date`, () => HttpResponse.json({ hrvSummary: { weeklyAvg: 'not a number' } })),
      http.get(`${API}/device-service/deviceregistration/devices`, () => HttpResponse.json([{ displayName: 'no id' }])),
    );
    const { client } = makeClient();
    await expect(client.getHrv('2026-10-07')).resolves.toEqual({ hrvSummary: { weeklyAvg: 'not a number' } });
    await expect(client.listDevices()).rejects.toBeInstanceOf(ValidationError);
  });

  it('limits concurrency to the configured pool size', async () => {
    let inFlight = 0;
    let peak = 0;
    server.use(
      http.get(`${API}/hrv-service/hrv/:date`, async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return HttpResponse.json({ hrvSummary: null });
      }),
    );
    const { client } = makeClient({ concurrency: 3 });
    await Promise.all(Array.from({ length: 12 }, () => client.getHrv('2026-10-07')));
    expect(peak).toBe(3);
  });

  it('spaces request starts by the minimum interval with jitter and counts requests', async () => {
    const tokens = fakeTokens();
    server.use(http.get(`${API}/hrv-service/hrv/:date`, () => HttpResponse.json({ hrvSummary: null })));
    // Planned starts, not arrival times: timers and the event loop would add their own noise.
    const planned: number[] = [];
    const client = new GarminClient({ ...config, minRequestIntervalMs: 40 }, tokens.provider, {
      sleep: (ms) => {
        planned.push(Date.now() + ms);
        return Promise.resolve();
      },
    });
    await Promise.all(Array.from({ length: 4 }, () => client.getHrv('2026-10-07')));
    // The first request starts at once; each next one 40 ms ±25 % after the previous slot (1 ms for the clock tick).
    expect(planned).toHaveLength(3);
    for (const [i, t] of planned.slice(1).entries()) {
      const gap = t - (planned[i] as number);
      expect(gap).toBeGreaterThanOrEqual(29);
      expect(gap).toBeLessThanOrEqual(51);
    }
    expect(client.http.requestCount).toBe(4);
  });

  it('sends minimal activity updates', async () => {
    let body: unknown;
    server.use(
      http.put(`${API}/activity-service/activity/:id`, async ({ request }) => {
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await makeClient().client.updateActivity(42, { name: 'Tempo', typeKey: 'trail_running', rpe: 7, feel: 75 });
    expect(body).toEqual({
      activityId: 42,
      activityName: 'Tempo',
      activityTypeDTO: { typeId: 6, typeKey: 'trail_running', parentTypeId: 1 },
      summaryDTO: { directWorkoutRpe: 70, directWorkoutFeel: 75 },
    });
  });

  it('uses an activity type resolved by the caller without fetching the type list', async () => {
    let body: unknown;
    let typeListRequests = 0;
    server.use(
      http.get(`${API}/activity-service/activity/activityTypes`, () => {
        typeListRequests++;
        return HttpResponse.json([]);
      }),
      http.put(`${API}/activity-service/activity/:id`, async ({ request }) => {
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await makeClient().client.updateActivity(42, { typeKey: 'trail_running', activityType: { typeId: 6, typeKey: 'trail_running', parentTypeId: 1 } });
    expect(body).toEqual({ activityId: 42, activityTypeDTO: { typeId: 6, typeKey: 'trail_running', parentTypeId: 1 } });
    expect(typeListRequests).toBe(0);
  });

  it('overwrites a workout with PUT carrying its id', async () => {
    let put: { id?: unknown; body?: unknown } = {};
    server.use(
      http.put(`${API}/workout-service/workout/:id`, async ({ params, request }) => {
        put = { id: params.id, body: await request.json() };
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await makeClient().client.updateWorkout(1727354116, { workoutName: 'Tempo', workoutId: 1 });
    expect(put).toEqual({ id: '1727354116', body: { workoutName: 'Tempo', workoutId: 1727354116 } });
  });

  it('removes a calendar entry by schedule id', async () => {
    let removed: unknown;
    server.use(
      http.delete(`${API}/workout-service/schedule/:id`, ({ params }) => {
        removed = params.id;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await makeClient().client.deleteWorkoutSchedule(1806427533);
    expect(removed).toBe('1806427533');
  });

  it('downloads binary files', async () => {
    const file = await makeClient().client.downloadActivity(20000000002, 'fit');
    expect(Array.from(file.data.slice(0, 2))).toEqual([0x50, 0x4b]);
    expect(file.filename).toBe('20000000002.zip');
  });

  it('rejects unsafe ids and paths before any request', async () => {
    const { client } = makeClient();
    await expect(client.getActivity(-1)).rejects.toBeInstanceOf(InputError);
    await expect(client.getGearStats('../../x')).rejects.toBeInstanceOf(InputError);
    // A path that slips past the argument checks is a bug, not bad input.
    await expect(client.http.request('GET', '/a/%2e%2e/b')).rejects.toBeInstanceOf(RangeError);
  });
});
