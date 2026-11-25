import { expect, test } from 'bun:test';
import { farmPinCollection, selectedFarmFocus, type FarmMapRecord } from '@/lib/map/farm-pins';

const farms: FarmMapRecord[] = [
  { id: 'farm-a', name: 'North field', centroidLat: 10.25, centroidLon: -3.5 },
  { id: 'farm-b', name: 'South field', centroidLat: -12, centroidLon: 144 },
];

test('farm pin GeoJSON uses longitude-latitude order and retains names', () => {
  const collection = farmPinCollection(farms);
  expect(collection.features.map((feature) => [feature.properties.farmId, feature.properties.name, feature.geometry.coordinates])).toEqual([
    ['farm-a', 'North field', [-3.5, 10.25]],
    ['farm-b', 'South field', [144, -12]],
  ]);
});

test('invalid farm coordinates are omitted from map features and selection focus', () => {
  const invalid = { id: 'bad', name: 'Bad pin', centroidLat: 91, centroidLon: 0 };
  expect(farmPinCollection([...farms, invalid]).features).toHaveLength(2);
  expect(selectedFarmFocus([...farms, invalid], 'bad')).toBeNull();
  expect(selectedFarmFocus(farms, 'missing')).toBeNull();
});

test('selected farm focus resolves to its stored centroid', () => {
  expect(selectedFarmFocus(farms, 'farm-b')).toEqual({ lat: -12, lon: 144, label: 'South field' });
  expect(selectedFarmFocus(farms, null)).toBeNull();
});