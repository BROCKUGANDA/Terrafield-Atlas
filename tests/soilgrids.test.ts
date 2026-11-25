import { afterEach, expect, test } from 'bun:test';
import { fetchSoilGridsPoint } from '@/lib/adapters/soilgrids';
import { createFetchMock } from './fetch-mock';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const layer = (name: string, mean: number | null, factor: number) => ({
  name, unit_measure: { d_factor: factor, mapped_units: 'mapped', target_units: 'target' },
  depths: [{ label: '0-5cm', values: { mean } }],
});

test('reads SoilGrids v2 mean object and provider conversion factors, preserving zero', async () => {
  globalThis.fetch = createFetchMock(async () => Response.json({ properties: { layers: [
    layer('phh2o', 65, 10), layer('nitrogen', 150, 100), layer('sand', 0, 10), layer('clay', null, 10),
  ] } }));
  const result = await fetchSoilGridsPoint(-0.287654, 36.076543);
  expect(result.properties.map((p) => [p.property, p.value])).toEqual([['phh2o', 6.5], ['nitrogen', 1.5], ['sand', 0]]);
});

test('empty profiles are no-data errors, not successful empty soil tests', async () => {
  globalThis.fetch = createFetchMock(async () => Response.json({ properties: { layers: [layer('soc', null, 10)] } }));
  await expect(fetchSoilGridsPoint(-1.123456, 35.123456)).rejects.toThrow('no usable');
});