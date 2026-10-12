import { describe, expect, it } from 'vitest';
import { buildProgram } from './commands.js';
import { table } from './io.js';
import { anonymize, RECORDABLE } from './record.js';

const NO_SHIFT = { lat: 0, lon: 0 };

describe('anonymize', () => {
  it('scrubs personal fields but keeps data ids and shapes', () => {
    const out = anonymize({
      displayName: 'jan.kowalski',
      fullName: 'Jan Kowalski',
      profileId: 123456,
      activityId: 99,
      note: 'mail me at jan@example.org',
      polyline: [{ lat: 52.2297, lon: 21.0122 }],
      nested: { ownerId: 5, garminGUID: 'abc' },
    }, NO_SHIFT);
    expect(out).toEqual({
      displayName: 'anon-displayName',
      fullName: 'anon-fullName',
      profileId: 90001,
      activityId: 99,
      note: 'mail me at anon@example.com',
      polyline: [{ lat: 0.2297, lon: 0.0122 }],
      nested: { ownerId: 90001, garminGUID: 'anon-garminGUID' },
    });
  });

  it('matches personal keys regardless of case and hides profile links', () => {
    const out = anonymize({
      metadataDTO: { userInfoDto: { userProfilePk: 123456, displayname: 'jan.kowalski', fullname: 'Jan Kowalski' } },
      userProfileFullName: 'Jan Kowalski',
      bio: 'Biegam w Lasku Bielańskim',
      facebookUrl: 'https://facebook.com/jan',
      userDailySummaryId: 123456,
    });
    expect(out).toEqual({
      metadataDTO: { userInfoDto: { userProfilePk: 90001, displayname: 'anon-displayname', fullname: 'anon-fullname' } },
      userProfileFullName: 'anon-userProfileFullName',
      bio: 'anon-bio',
      facebookUrl: 'anon-facebookUrl',
      userDailySummaryId: 90001,
    });
  });

  it('hides free text the owner typed, which names places and races', () => {
    const out = anonymize({
      activityId: 7,
      activityName: 'Siechnice - BC1 5km',
      workoutName: 'LONG 26 km',
      description: 'Nd 20.09 RANO',
      calendarItems: [{ id: 1, title: 'UltraKotlina 50 2026 59/425' }],
      settings: [{ name: 'pl' }],
    });
    expect(out).toEqual({
      activityId: 7,
      activityName: 'anon-activityName',
      workoutName: 'anon-workoutName',
      description: 'anon-description',
      calendarItems: [{ id: 1, title: 'anon-title' }],
      settings: [{ name: 'pl' }],
    });
  });

  it('shifts every coordinate, including positional detail columns, and hides profile photos', () => {
    const shift = { lat: 0.5, lon: 0.25 };
    const out = anonymize(
      {
        metricDescriptors: [
          { metricsIndex: 0, key: 'directHeartRate' },
          { metricsIndex: 1, key: 'directLatitude' },
          { metricsIndex: 2, key: 'directLongitude' },
        ],
        activityDetailMetrics: [{ metrics: [150, 51.0123, 17.0456] }, { metrics: [151, null, null] }],
        geoPolylineDTO: { minLat: 51.0123, maxLon: 17.9, polyline: [{ lat: 51.0123, lon: 17.0456 }] },
        ownerProfileImageUrlSmall: 'https://s3.amazonaws.com/garmin-connect-prod/profile_images/x-prth.png',
        imageUrl: 'https://s3.amazonaws.com/garmin-connect-prod/profile_images/y-71.png',
      },
      shift,
    );
    expect(out).toEqual({
      metricDescriptors: [
        { metricsIndex: 0, key: 'directHeartRate' },
        { metricsIndex: 1, key: 'directLatitude' },
        { metricsIndex: 2, key: 'directLongitude' },
      ],
      activityDetailMetrics: [{ metrics: [150, 0.5123, 0.2956] }, { metrics: [151, null, null] }],
      geoPolylineDTO: { minLat: 0.5123, maxLon: 0.15, polyline: [{ lat: 0.5123, lon: 0.2956 }] },
      ownerProfileImageUrlSmall: 'anon-ownerProfileImageUrlSmall',
      imageUrl: 'anon-imageUrl',
    });
  });

  it('hides the weather station, which would reveal the location', () => {
    const out = anonymize({ temp: 59, weatherStationDTO: { id: 'EPWA', name: 'Warsaw Chopin', latitude: 52.1657, timezone: null } }, NO_SHIFT);
    expect(out).toEqual({
      temp: 59,
      weatherStationDTO: { id: 'anon-weatherStation', name: 'anon-weatherStation', latitude: 0.1657, timezone: null },
    });
  });

  it('hides device serial numbers, addresses and names but keeps device ids and settings', () => {
    const out = anonymize({
      deviceId: 3333,
      serialNumber: '3XY123456',
      wifiMacAddress: 'AA:BB:CC:DD:EE:FF',
      customDeviceName: "Jan's watch",
      timeFormat: 'time_twenty_four_hr',
      wifiNetworks: [{ ssid: 'Kowalscy-5G', classId: 3 }],
      alarms: [{ alarmId: 501, alarmTime: 375, alarmMessage: 'Trening z Anią' }],
    });
    expect(out).toEqual({
      deviceId: 3333,
      serialNumber: 'anon-serialNumber',
      wifiMacAddress: 'anon-wifiMacAddress',
      customDeviceName: 'anon-customDeviceName',
      timeFormat: 'time_twenty_four_hr',
      wifiNetworks: [{ ssid: 'anon-ssid', classId: 3 }],
      alarms: [{ alarmId: 501, alarmTime: 375, alarmMessage: 'anon-alarmMessage' }],
    });
  });

  it('keeps calendar item ids distinct but hides the profile id', () => {
    const out = anonymize({
      year: 2026,
      month: 9,
      calendarItems: [
        { id: 9900001, itemType: 'workout', date: '2026-10-10', workoutId: 700001 },
        { id: 30000003, itemType: 'event', date: '2026-10-25', location: 'Warszawa' },
      ],
    }) as { calendarItems: { id: number; location?: string }[] };
    expect(out.calendarItems.map((i) => i.id)).toEqual([9900001, 30000003]);
    expect(out.calendarItems[1]?.location).toBe('anon-location');
    expect(anonymize({ id: 123456, profileId: 123456, displayName: 'jan' })).toEqual({
      id: 90001,
      profileId: 90001,
      displayName: 'anon-displayName',
    });
  });

  it('covers every client fixture name', () => {
    expect(Object.keys(RECORDABLE)).toContain('training-status');
    expect(Object.keys(RECORDABLE)).toHaveLength(38);
  });
});

describe('cli', () => {
  it('registers the CLI commands', () => {
    const names = buildProgram().commands.map((c) => c.name());
    expect(names).toEqual(['login', 'import-tokens', 'logout', 'status', 'sync', 'activities', 'health', 'doctor', 'serve', 'record']);
  });

  it('renders tables', () => {
    expect(table([{ a: 1, b: 'x' }, { a: 22 }])).toBe('a   b\n--  -\n1   x\n22');
  });
});
