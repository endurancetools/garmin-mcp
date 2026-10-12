import { http, HttpResponse, type HttpHandler } from 'msw';
import { setupServer } from 'msw/node';
import { fixture } from './fixtures.js';

export const API = 'https://connectapi.garmin.com';

/** Default routes: every client method answered from fixtures/. */
export const fixtureHandlers: HttpHandler[] = [
  http.get(`${API}/userprofile-service/socialProfile`, () => HttpResponse.json(fixture('social-profile'))),
  http.get(`${API}/userprofile-service/userprofile/user-settings`, () => HttpResponse.json(fixture('user-settings'))),
  http.get(`${API}/biometric-service/heartRateZones`, () => HttpResponse.json(fixture('heart-rate-zones'))),
  http.get(`${API}/biometric-service/powerZones/sports/all`, () => HttpResponse.json(fixture('power-zones'))),
  http.get(`${API}/activitylist-service/activities/search/activities`, ({ request }) => {
    const params = new URL(request.url).searchParams;
    const start = Number(params.get('start') ?? 0);
    const limit = Number(params.get('limit') ?? 20);
    return HttpResponse.json((fixture('activities') as unknown[]).slice(start, start + limit));
  }),
  http.get(`${API}/activity-service/activity/activityTypes`, () => HttpResponse.json(fixture('activity-types'))),
  http.get(`${API}/activity-service/activity/:id/splits`, () => HttpResponse.json(fixture('activity-splits'))),
  http.get(`${API}/activity-service/activity/:id/hrTimeInZones`, () => HttpResponse.json(fixture('activity-hr-zones'))),
  http.get(`${API}/activity-service/activity/:id/powerTimeInZones`, () => HttpResponse.json(fixture('activity-power-zones'))),
  http.get(`${API}/activity-service/activity/:id/weather`, () => HttpResponse.json(fixture('activity-weather'))),
  http.get(`${API}/activity-service/activity/:id/exerciseSets`, () => HttpResponse.json(fixture('activity-exercise-sets'))),
  http.get(`${API}/activity-service/activity/:id/details`, () => HttpResponse.json(fixture('activity-details'))),
  http.get(`${API}/activity-service/activity/:id`, () => HttpResponse.json(fixture('activity'))),
  http.put(`${API}/activity-service/activity/:id`, () => new HttpResponse(null, { status: 204 })),
  http.get(`${API}/usersummary-service/usersummary/daily/:name`, () => HttpResponse.json(fixture('daily-summary'))),
  http.get(`${API}/wellness-service/wellness/dailySummaryChart/:name`, () => HttpResponse.json(fixture('steps-chart'))),
  http.get(`${API}/wellness-service/wellness/dailyHeartRate/:name`, () => HttpResponse.json(fixture('heart-rate-day'))),
  http.get(`${API}/wellness-service/wellness/dailyStress/:date`, () => HttpResponse.json(fixture('stress-day'))),
  http.get(`${API}/wellness-service/wellness/bodyBattery/reports/daily`, () => HttpResponse.json(fixture('body-battery'))),
  http.get(`${API}/wellness-service/wellness/daily/respiration/:date`, () => HttpResponse.json(fixture('respiration-day'))),
  http.get(`${API}/wellness-service/wellness/daily/spo2/:date`, () => HttpResponse.json(fixture('spo2-day'))),
  http.get(`${API}/wellness-service/wellness/daily/im/:date`, () => HttpResponse.json(fixture('intensity-minutes-day'))),
  http.get(`${API}/wellness-service/wellness/dailySleepData/:name`, () => HttpResponse.json(fixture('sleep'))),
  http.get(`${API}/hrv-service/hrv/:date`, () => HttpResponse.json(fixture('hrv'))),
  http.get(`${API}/metrics-service/metrics/trainingstatus/aggregated/:date`, () =>
    HttpResponse.json(fixture('training-status')),
  ),
  http.get(`${API}/metrics-service/metrics/trainingreadiness/:date`, () => HttpResponse.json(fixture('training-readiness'))),
  http.get(`${API}/metrics-service/metrics/maxmet/daily/:from/:to`, () => HttpResponse.json(fixture('max-metrics'))),
  http.get(`${API}/metrics-service/metrics/racepredictions/latest/:name`, () =>
    HttpResponse.json(fixture('race-predictions')),
  ),
  http.get(`${API}/fitnessage-service/fitnessage/:date`, () => HttpResponse.json(fixture('fitness-age'))),
  http.get(`${API}/workout-service/workouts`, () => HttpResponse.json(fixture('workouts'))),
  http.get(`${API}/workout-service/workout/:id`, () => HttpResponse.json(fixture('workout'))),
  http.post(`${API}/workout-service/workout`, () => HttpResponse.json(fixture('workout'))),
  http.post(`${API}/workout-service/schedule/:id`, () => HttpResponse.json(fixture('workout-schedule'))),
  http.get(`${API}/calendar-service/year/:y/month/:m`, () => HttpResponse.json(fixture('calendar-month'))),
  http.get(`${API}/gear-service/gear/filterGear`, () => HttpResponse.json(fixture('gear'))),
  http.get(`${API}/gear-service/gear/stats/:uuid`, () => HttpResponse.json(fixture('gear-stats'))),
  http.get(`${API}/activitylist-service/activities/:uuid/gear`, () => HttpResponse.json(fixture('activities'))),
  http.get(`${API}/weight-service/weight/range/:from/:to`, () => HttpResponse.json(fixture('weigh-ins'))),
  http.get(`${API}/device-service/deviceregistration/devices`, () => HttpResponse.json(fixture('devices'))),
  http.get(`${API}/device-service/deviceservice/mylastused`, () => HttpResponse.json(fixture('device-last-used'))),
  http.get(`${API}/device-service/deviceservice/device-info/settings/:id`, () => HttpResponse.json(fixture('device-settings'))),
  http.get(`${API}/download-service/files/activity/:id`, () =>
    new HttpResponse(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
      headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="20000000002.zip"' },
    }),
  ),
];

export function createServer() {
  return setupServer(...fixtureHandlers);
}

export function fakeTokens(token = 'test-token') {
  let invalidations = 0;
  return {
    provider: {
      getAccessToken: () => Promise.resolve(token),
      invalidate: () => {
        invalidations++;
        return Promise.resolve();
      },
    },
    get invalidations() {
      return invalidations;
    },
  };
}
