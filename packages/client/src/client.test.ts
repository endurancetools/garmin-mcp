import { DEFAULT_APP_IDENTITY, hostsForRegion, InputError, silentLogger } from 'garmin-mcp-config';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { GarminClient } from './client.js';
import { ForbiddenError, NotFoundError, RateLimitedError, UnauthorizedError, ValidationError, ClientNetworkError } from './errors.js';
import { fixture } from './test-utils/fixtures.js';
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

  // Recorded in E8-2 (all but the phased plan); this pins what the client sends.
  it.each<[string, (c: GarminClient) => Promise<unknown>, string, unknown]>([
    ['typed splits', (c) => c.getActivityTypedSplits(20000000002), '/activity-service/activity/20000000002/typedsplits', {}],
    ['split summaries', (c) => c.getActivitySplitSummaries(20000000002), '/activity-service/activity/20000000002/split_summaries', {}],
    ['training plans', (c) => c.listTrainingPlans(), '/trainingplan-service/trainingplan/plans', {}],
    ['phased plan', (c) => c.getTrainingPlan(51), '/trainingplan-service/trainingplan/phased/51', {}],
    ['adaptive plan', (c) => c.getAdaptiveTrainingPlan(52), '/trainingplan-service/trainingplan/fbt-adaptive/52', {}],
    [
      'lactate threshold heart rate',
      (c) => c.getLactateThresholdHeartRate('2025-10-07', '2026-10-07'),
      '/biometric-service/stats/lactateThresholdHeartRate/range/2025-10-07/2026-10-07?sport=RUNNING&aggregation=daily&aggregationStrategy=LATEST',
      [],
    ],
    [
      'lactate threshold speed',
      (c) => c.getLactateThresholdSpeed('2025-10-07', '2026-10-07'),
      '/biometric-service/stats/lactateThresholdSpeed/range/2025-10-07/2026-10-07?sport=RUNNING&aggregation=daily&aggregationStrategy=LATEST',
      [],
    ],
    ['cycling FTP', (c) => c.getCyclingFtp(), '/biometric-service/biometric/latestFunctionalThresholdPower/CYCLING', {}],
    ['hydration', (c) => c.getHydration('2026-10-07'), '/usersummary-service/usersummary/hydration/daily/2026-10-07', {}],
    [
      'blood pressure',
      (c) => c.getBloodPressure('2026-09-08', '2026-10-07'),
      '/bloodpressure-service/bloodpressure/range/2026-09-08/2026-10-07?includeAll=true',
      {},
    ],
    ['daily events', (c) => c.getDailyEvents('2026-10-07'), '/wellness-service/wellness/dailyEvents?calendarDate=2026-10-07', []],
    ['goals', (c) => c.getGoals(), '/goal-service/goal/goals?status=active&start=1&limit=100', []],
    ['past goals', (c) => c.getGoals('past'), '/goal-service/goal/goals?status=past&start=1&limit=100', []],
    ['courses', (c) => c.listCourses(), '/course-service/course', []],
    ['course', (c) => c.getCourse(4242), '/course-service/course/4242', {}],
    [
      'device solar',
      (c) => c.getDeviceSolar(3333, '2026-10-01', '2026-10-07'),
      '/web-gateway/solar/3333/2026-10-01/2026-10-07?singleDayView=false',
      {},
    ],
    ['solar of one day', (c) => c.getDeviceSolar(3333, '2026-10-07'), '/web-gateway/solar/3333/2026-10-07/2026-10-07?singleDayView=true', {}],
    ['nutrition', (c) => c.getNutritionDay('2026-10-07'), '/nutrition-service/food/logs/2026-10-07', {}],
    ['menstrual day', (c) => c.getMenstrualDay('2026-10-07'), '/periodichealth-service/menstrualcycle/dayview/2026-10-07', {}],
    ['earned badges', (c) => c.getEarnedBadges(), '/badge-service/badge/earned', []],
    ['badge challenges', (c) => c.getBadgeChallengesInProgress(), '/badgechallenge-service/badgeChallenge/non-completed?start=1&limit=100', []],
  ])('requests %s from the expected path', async (_name, call, expected, body) => {
    const seen: string[] = [];
    server.use(
      http.get(`${API}/*`, ({ request }) => {
        const url = new URL(request.url);
        seen.push(url.pathname + url.search);
        return HttpResponse.json(body as never);
      }),
    );
    await expect(call(makeClient().client)).resolves.toEqual(body);
    expect(seen).toEqual([expected]);
  });

  it('checks ids and dates of stage 8 endpoints before any request', async () => {
    const { client } = makeClient();
    await expect(client.getCourse(0)).rejects.toBeInstanceOf(InputError);
    await expect(client.getDeviceSolar(-3, '2026-10-07')).rejects.toBeInstanceOf(InputError);
    await expect(client.getBloodPressure('2026-13-01')).rejects.toBeInstanceOf(InputError);
  });

  it('accepts the recorded list of courses without a schema warning', async () => {
    const courses = fixture<unknown[]>('courses');
    server.use(http.get(`${API}/course-service/course`, () => HttpResponse.json(courses as never)));
    const logger = silentLogger.child({});
    const warn = vi.spyOn(logger, 'warn');
    const client = new GarminClient(config, fakeTokens().provider, { logger });
    await expect(client.listCourses()).resolves.toEqual(courses);
    expect(warn).not.toHaveBeenCalled();
  });

  it('downloads a course as GPX', async () => {
    const gpx = '<?xml version="1.0"?><gpx><trk><name>Loop</name></trk></gpx>';
    let path = '';
    server.use(
      http.get(`${API}/course-service/course/gpx/:id`, ({ request }) => {
        path = new URL(request.url).pathname;
        return new HttpResponse(gpx, { headers: { 'content-type': 'application/gpx+xml', 'content-disposition': 'attachment; filename="Loop.gpx"' } });
      }),
    );
    const file = await makeClient().client.downloadCourseGpx(102339772);
    expect(path).toBe('/course-service/course/gpx/102339772');
    expect(new TextDecoder().decode(file.data)).toBe(gpx);
    expect(file.filename).toBe('Loop.gpx');
    await expect(makeClient().client.downloadCourseGpx(0)).rejects.toBeInstanceOf(InputError);
  });

  it('uploads a GPX file as a course: import, then save with a name', async () => {
    const seen: { path: string; file?: string; body?: unknown }[] = [];
    let imported: unknown = { courseName: null, distanceMeter: 5000, geoPoints: [{ latitude: 1, longitude: 2, elevation: 100, distance: 0 }] };
    let saved: unknown = { courseId: 777, courseName: 'Evening Loop', distanceMeter: 5000 };
    server.use(
      http.post(`${API}/course-service/course/import`, async ({ request }) => {
        const file = (await request.formData()).get('file') as File;
        seen.push({ path: 'import', file: file.name });
        return HttpResponse.json(imported as never);
      }),
      http.post(`${API}/course-service/course`, async ({ request }) => {
        seen.push({ path: 'save', body: await request.json() });
        return HttpResponse.json(saved as never);
      }),
    );
    const { client } = makeClient();
    const data = new TextEncoder().encode('<gpx/>');
    await expect(client.uploadCourseGpx('/tmp/Evening Loop.GPX', data)).resolves.toMatchObject({ courseId: 777 });
    expect(seen).toEqual([
      { path: 'import', file: 'Evening Loop.GPX' },
      { path: 'save', body: expect.objectContaining({ courseName: 'Evening Loop', distanceMeter: 5000 }) },
    ]);
    // A name from the file stays.
    imported = { courseName: 'Kampinos', distanceMeter: 5000 };
    await client.uploadCourseGpx('a.gpx', data);
    expect(seen.at(-1)?.body).toMatchObject({ courseName: 'Kampinos' });
    // Without an id in the answer the course may still exist: the error says to check first.
    saved = { courseName: 'Kampinos' };
    await expect(client.uploadCourseGpx('a.gpx', data)).rejects.toMatchObject({ code: 'VALIDATION', hint: expect.stringMatching(/check the courses/) });
    imported = [];
    await expect(client.uploadCourseGpx('a.gpx', data)).rejects.toMatchObject({ code: 'VALIDATION' });
    const before = seen.length;
    await expect(client.uploadCourseGpx('a.fit', data)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(seen).toHaveLength(before);
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

  it('sends the event type as eventTypeDTO with id and key only', async () => {
    let body: unknown;
    server.use(
      http.put(`${API}/activity-service/activity/:id`, async ({ request }) => {
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await makeClient().client.updateActivity(42, { eventType: { typeId: 1, typeKey: 'race', sortOrder: 1 } });
    expect(body).toEqual({ activityId: 42, eventTypeDTO: { typeId: 1, typeKey: 'race' } });
  });

  it('sends privacy as the access control rule', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.put(`${API}/activity-service/activity/:id`, async ({ request }) => {
        bodies.push(await request.json());
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { client } = makeClient();
    await client.updateActivity(42, { privacy: 'private' });
    await client.updateActivity(42, { privacy: 'followers' });
    await client.updateActivity(42, { privacy: 'public' });
    expect(bodies).toEqual([
      { activityId: 42, accessControlRuleDTO: { typeId: 2, typeKey: 'private' } },
      { activityId: 42, accessControlRuleDTO: { typeId: 3, typeKey: 'subscribers' } },
      { activityId: 42, accessControlRuleDTO: { typeId: 1, typeKey: 'public' } },
    ]);
    await expect(client.updateActivity(42, { privacy: 'friends' as never })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(bodies).toHaveLength(3);
  });

  it('replaces the exercise sets of an activity', async () => {
    let call: { id?: string; body?: unknown } = {};
    server.use(
      http.put(`${API}/activity-service/activity/:id/exerciseSets`, async ({ request, params }) => {
        call = { id: String(params.id), body: await request.json() };
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const sets = [{ setType: 'ACTIVE', exercises: [{ category: 'SQUAT', name: 'BARBELL_BACK_SQUAT', probability: 100 }], repetitionCount: 8, weight: 80_000, duration: 40 }];
    await makeClient().client.updateActivityExerciseSets(42, sets);
    expect(call).toEqual({ id: '42', body: { activityId: 42, exerciseSets: sets } });
  });

  it('adds a manual activity and returns its id', async () => {
    const bodies: unknown[] = [];
    let answer: Record<string, unknown> = { activityId: 777, activityName: 'Yoga' };
    server.use(
      http.post(`${API}/activity-service/activity`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(answer as Record<string, string | number>);
      }),
    );
    const { client } = makeClient();
    const yoga = { typeKey: 'yoga', activityType: { typeId: 43, typeKey: 'yoga', parentTypeId: 29 }, name: 'Yoga', startLocal: '2026-11-16T18:30:00', timeZone: 'Europe/Warsaw', durationS: 2700, privacy: 'private' as const };
    expect(await client.createManualActivity(yoga)).toBe(777);
    await client.createManualActivity({ ...yoga, distanceM: 5000, privacy: 'followers' });
    expect(bodies).toEqual([
      {
        activityTypeDTO: { typeId: 43, typeKey: 'yoga', parentTypeId: 29 },
        accessControlRuleDTO: { typeId: 2, typeKey: 'private' },
        timeZoneUnitDTO: { unitKey: 'Europe/Warsaw' },
        activityName: 'Yoga',
        metadataDTO: { autoCalcCalories: true },
        summaryDTO: { startTimeLocal: '2026-11-16T18:30:00.000', duration: 2700 },
      },
      expect.objectContaining({ accessControlRuleDTO: { typeId: 3, typeKey: 'subscribers' }, summaryDTO: { startTimeLocal: '2026-11-16T18:30:00.000', duration: 2700, distance: 5000 } }),
    ]);
    // Without an id in the answer the activity may still exist: the error says to check before retrying.
    answer = { activityName: 'Yoga' };
    await expect(client.createManualActivity(yoga)).rejects.toMatchObject({ code: 'VALIDATION', hint: expect.stringMatching(/check get_activities/) });
    await expect(client.createManualActivity({ ...yoga, durationS: 0 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(bodies).toHaveLength(3);
  });

  it('uploads an activity file as multipart and reads created, duplicate, processing and refused answers', async () => {
    const seen: { name: string; size: number; type: string | null }[] = [];
    let reply: { status: number; body: unknown } = { status: 201, body: {} };
    server.use(
      http.post(`${API}/upload-service/upload`, async ({ request }) => {
        const file = (await request.formData()).get('file') as File;
        seen.push({ name: file.name, size: file.size, type: request.headers.get('content-type') });
        return HttpResponse.json(reply.body as Record<string, unknown>, { status: reply.status });
      }),
    );
    const { client } = makeClient();
    const data = new Uint8Array([14, 0x20, 1, 2, 3]);
    reply = { status: 201, body: { detailedImportResult: { uploadId: 5, successes: [{ internalId: 901, externalId: null, messages: null }], failures: [] } } };
    expect(await client.uploadActivityFile('/tmp/rides/Morning.FIT', data)).toEqual({ status: 'created', activityId: 901 });
    expect(seen[0]).toEqual({ name: 'Morning.FIT', size: 5, type: expect.stringMatching(/^multipart\/form-data; boundary=/) });
    // A duplicate is HTTP 409 with the existing activity, not an error.
    reply = { status: 409, body: { detailedImportResult: { successes: [], failures: [{ internalId: 900, messages: [{ code: 202, content: 'Duplicate Activity.' }] }] } } };
    expect(await client.uploadActivityFile('a.gpx', data)).toEqual({ status: 'duplicate', activityId: 900, message: 'Duplicate Activity.' });
    reply = { status: 409, body: {} };
    expect(await client.uploadActivityFile('a.tcx', data)).toEqual({ status: 'duplicate', message: 'Duplicate Activity.' });
    reply = { status: 202, body: { detailedImportResult: { uploadId: 6, successes: [], failures: [] } } };
    expect(await client.uploadActivityFile('a.fit', data)).toEqual({ status: 'processing' });
    reply = { status: 200, body: { detailedImportResult: { successes: [], failures: [{ internalId: null, messages: [{ code: 400, content: 'Unrecognized file' }] }] } } };
    expect(await client.uploadActivityFile('a.fit', data)).toEqual({ status: 'failed', message: 'Unrecognized file' });
    // Other errors still throw.
    reply = { status: 400, body: { message: 'Bad file' } };
    await expect(client.uploadActivityFile('a.fit', data)).rejects.toMatchObject({ kind: 'network', status: 400 });
    await expect(client.uploadActivityFile('a.kml', data)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(seen).toHaveLength(6);
  });

  it('adds weigh-ins, blood pressure and water at a local time with its instant', async () => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const record = async ({ request }: { request: Request }) => {
      calls.push({ method: request.method, path: new URL(request.url).pathname, body: await request.json() });
      return HttpResponse.json({ calendarDate: '2026-11-17', valueInML: 1500 });
    };
    server.use(
      http.post(`${API}/weight-service/user-weight`, record),
      http.post(`${API}/bloodpressure-service/bloodpressure`, record),
      http.put(`${API}/usersummary-service/usersummary/hydration/log`, record),
    );
    const { client } = makeClient();
    const at = { local: '2026-11-17T07:30:00', utc: new Date('2026-11-17T06:30:00Z') };
    await client.addWeighIn(72.4, at);
    await client.addBloodPressure({ systolic: 120, diastolic: 80, pulse: 62, at });
    await client.addBloodPressure({ systolic: 118, diastolic: 76, notes: 'after coffee', at });
    expect(await client.addHydration(500, at)).toMatchObject({ valueInML: 1500 });
    expect(calls).toEqual([
      { method: 'POST', path: '/weight-service/user-weight', body: { dateTimestamp: '2026-11-17T07:30:00.000', gmtTimestamp: '2026-11-17T06:30:00.000', unitKey: 'kg', sourceType: 'MANUAL', value: 72.4 } },
      {
        method: 'POST',
        path: '/bloodpressure-service/bloodpressure',
        body: { measurementTimestampLocal: '2026-11-17T07:30:00.00', measurementTimestampGMT: '2026-11-17T06:30:00.00', systolic: 120, diastolic: 80, pulse: 62, sourceType: 'MANUAL', notes: '' },
      },
      expect.objectContaining({ body: expect.not.objectContaining({ pulse: expect.anything() }) }),
      { method: 'PUT', path: '/usersummary-service/usersummary/hydration/log', body: { calendarDate: '2026-11-17', timestampLocal: '2026-11-17T07:30:00.000', valueInML: 500 } },
    ]);
    expect((calls[2]!.body as { notes: string }).notes).toBe('after coffee');
    await expect(client.addBloodPressure({ systolic: 80, diastolic: 120, at })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(client.addHydration(0, at)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(calls).toHaveLength(4);
  });

  it('puts gear on an activity and takes it off', async () => {
    const calls: string[] = [];
    server.use(
      http.put(`${API}/gear-service/gear/:action/:uuid/activity/:id`, ({ params }) => {
        calls.push(`${String(params.action)} ${String(params.uuid)} ${String(params.id)}`);
        return HttpResponse.json({ uuid: params.uuid });
      }),
    );
    const { client } = makeClient();
    await client.linkGear('fd9c450c67ba25e422229c359e4b315a', 42);
    await client.unlinkGear('fd9c450c67ba25e422229c359e4b315a', 42);
    expect(calls).toEqual(['link fd9c450c67ba25e422229c359e4b315a 42', 'unlink fd9c450c67ba25e422229c359e4b315a 42']);
    await expect(client.linkGear('../activity', 42)).rejects.toThrow('invalid gear uuid');
  });

  it('overwrites a workout with PUT carrying its id', async () => {
    let put: { id?: unknown; body?: unknown } = {};
    server.use(
      http.put(`${API}/workout-service/workout/:id`, async ({ params, request }) => {
        put = { id: params.id, body: await request.json() };
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await makeClient().client.updateWorkout(6515728609, { workoutName: 'Tempo', workoutId: 1 });
    expect(put).toEqual({ id: '6515728609', body: { workoutName: 'Tempo', workoutId: 6515728609 } });
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
