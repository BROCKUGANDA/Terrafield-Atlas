import { expect, test } from 'bun:test';
import { dailyGibsTileUrl, latestDailyGibsDate } from '@/lib/map/gibs-availability';
import type { MapLayerInfo } from '@/lib/api-client';

const layer = {
  id: 'MODIS_Terra_CorrectedReflectance_TrueColor',
  format: 'image/jpeg',
  tileMatrixSet: 'GoogleMapsCompatible_Level9',
} as MapLayerInfo;

test('daily GIBS probe addresses the correct row and column for the farm coordinate', () => {
  expect(dailyGibsTileUrl(layer, '2026-11-17', -0.28, 36.07)).toBe(
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/2026-11-17/GoogleMapsCompatible_Level9/9/256/307.jpg',
  );
  expect(dailyGibsTileUrl(layer, '2026-11-17', 91, 36.07)).toBeNull();
});

test('latest daily imagery probe stops at the first usable recent date', async () => {
  const checked: string[] = [];
  const date = await latestDailyGibsDate(layer, '2026-11-17', -0.28, 36.07, undefined, async (url) => {
    checked.push(url);
    return url.includes('/2026-11-16/');
  });
  expect(date).toBe('2026-11-16');
  expect(checked).toHaveLength(2);
  expect(checked[0]).toContain('/2026-11-17/');
  expect(checked[1]).toContain('/2026-11-16/');
});

test('no-data search is bounded and returns no invented date', async () => {
  const checked: string[] = [];
  const date = await latestDailyGibsDate(layer, '2026-11-17', -0.28, 36.07, undefined, async (url) => {
    checked.push(url);
    return false;
  }, 2);
  expect(date).toBeNull();
  expect(checked).toHaveLength(3);
});