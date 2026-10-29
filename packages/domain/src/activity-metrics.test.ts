import { describe, expect, it } from 'vitest';
import { gapPace, hrSource, motionTime, redactActivityRaw, respiration, runningDynamics, stamina, trainingEffectText } from './activity-metrics.js';

// Shapes and values as recorded from runs with an HRM-Pro strap; personal fields made up.
const summaryDTO = {
  averageHR: 149,
  averageRunCadence: 165.15625,
  groundContactTime: 276.29998779296875,
  groundContactBalanceLeft: 49.47999954223633,
  verticalOscillation: 8.6,
  verticalRatio: 8.869999885559082,
  strideLength: 96.90999755859376,
  avgGradeAdjustedSpeed: 2.6760001182556152,
  avgRespirationRate: 34.75,
  minRespirationRate: 11.529999732971191,
  maxRespirationRate: 54.540000915527344,
  beginPotentialStamina: 100,
  endPotentialStamina: 87,
  minAvailableStamina: 87,
  trainingEffectLabel: 'AEROBIC_BASE',
  aerobicTrainingEffectMessage: 'IMPROVING_AEROBIC_BASE_8',
  anaerobicTrainingEffectMessage: 'NO_ANAEROBIC_BENEFIT_0',
  startLatitude: 51.01,
  startLongitude: 17.14,
  endLatitude: 51.02,
  endLongitude: 17.15,
};

describe('activity metrics', () => {
  it('maps running dynamics, dropping metrics Garmin reports as 0', () => {
    expect(runningDynamics(summaryDTO)).toEqual({
      cadence_spm: 165,
      gct_ms: 276,
      gct_balance_left_pct: 49.5,
      vertical_oscillation_cm: 8.6,
      vertical_ratio_pct: 8.9,
      stride_m: 0.97,
    });
    // Watch without a strap: no balance.
    expect(runningDynamics({ averageRunCadence: 170, groundContactTime: 250, groundContactBalanceLeft: 0, strideLength: 100 })).toEqual({ cadence_spm: 170, gct_ms: 250, stride_m: 1 });
    // A ride has none of them.
    expect(runningDynamics({ averageHR: 130, averageBikeCadence: 85 })).toBeUndefined();
  });

  it('maps respiration, stamina, the Training Effect text and the grade adjusted pace', () => {
    expect(respiration(summaryDTO)).toEqual({ avg_brpm: 34.8, min_brpm: 11.5, max_brpm: 54.5 });
    expect(respiration({ avgRespirationRate: 0 })).toBeUndefined();
    expect(stamina(summaryDTO)).toEqual({ start_pct: 100, end_pct: 87, min_available_pct: 87 });
    expect(stamina({})).toBeUndefined();
    expect(trainingEffectText(summaryDTO)).toEqual({ label: 'aerobic_base', aerobic_message: 'improving_aerobic_base', anaerobic_message: 'no_anaerobic_benefit' });
    expect(gapPace(summaryDTO)).toBe('6:14 /km');
    expect(gapPace({ avgGradeAdjustedSpeed: 0 })).toBeUndefined();
  });

  it('sums run, walk and stand time from the split summaries', () => {
    const splits = [
      { splitType: 'PACE_PRO_SPLIT', duration: 44577 },
      { splitType: 'RWD_RUN', duration: 2700 },
      { splitType: 'RWD_WALK', duration: 600 },
      { splitType: 'RWD_STAND', duration: 300 },
    ];
    expect(motionTime(splits)).toEqual({ run: '45:00', run_pct: 75, walk: '10:00', walk_pct: 17, stand: '5:00', stand_pct: 8 });
    expect(motionTime([{ splitType: 'INTERVAL_ACTIVE', duration: 2392 }])).toBeUndefined();
    expect(motionTime(undefined)).toBeUndefined();
  });

  it('tells an external heart rate sensor from the watch', () => {
    const strap = { sensors: [{ manufacturer: 'GARMIN', serialNumber: 1, sourceType: 'ANTPLUS', antplusDeviceType: 'RUN' }, { manufacturer: 'GARMIN', serialNumber: 1, sourceType: 'ANTPLUS', antplusDeviceType: 'HEART_RATE', batteryStatus: 'OK' }] };
    expect(hrSource(strap, true)).toEqual({ hr_source: 'external_sensor', hr_sensor: { manufacturer: 'garmin', connection: 'ant+', battery_status: 'ok' } });
    const ble = { sensors: [{ serialNumber: 2, sourceType: 'BLUETOOTH_LOW_ENERGY', bleDeviceType: 'HEART_RATE', batteryStatus: 'OK', batteryLevel: 45 }] };
    expect(hrSource(ble, true)).toEqual({ hr_source: 'external_sensor', hr_sensor: { connection: 'ble', battery_pct: 45, battery_status: 'ok' } });
    expect(hrSource({ sensors: [] }, true)).toEqual({ hr_source: 'watch_optical' });
    expect(hrSource({}, true)).toEqual({});
    expect(hrSource({ sensors: [] }, false)).toEqual({});
  });

  it('redacts personal data, device serials, GPS and the time zone from the raw activity', () => {
    const raw = {
      activityId: 1,
      activityName: 'Run',
      userProfileId: 123,
      timeZoneUnitDTO: { unitKey: 'Europe/Paris' },
      summaryDTO,
      metadataDTO: {
        lapCount: 6,
        userInfoDto: { userProfilePk: 123, displayname: 'x', fullname: 'Jan Kowalski', profileImageUrlLarge: 'https://example.com/a.png' },
        activityImages: [{ url: 'https://example.com/b.jpg' }],
        agentApplicationInstallationId: 'abc',
        deviceMetaDataDTO: { deviceId: 4242424, deviceTypePk: 36 },
        sensors: [{ serialNumber: 1743323, bleDeviceType: 'HEART_RATE', batteryLevel: 45 }],
      },
    };
    const out = redactActivityRaw(raw);
    const text = JSON.stringify(out);
    for (const secret of ['Kowalski', 'example.com', '1743323', '4242424', '"userProfileId"', 'Europe/Paris', 'Latitude', 'Longitude', 'abc']) expect(text).not.toContain(secret);
    expect(out).toMatchObject({
      activityId: 1,
      activityName: 'Run',
      summaryDTO: { averageHR: 149, groundContactTime: summaryDTO.groundContactTime },
      metadataDTO: { lapCount: 6, deviceMetaDataDTO: { deviceTypePk: 36 }, sensors: [{ bleDeviceType: 'HEART_RATE', batteryLevel: 45 }] },
    });
    // The cached response is left as it was.
    expect(raw.metadataDTO.userInfoDto.fullname).toBe('Jan Kowalski');
  });
});
