import { expect, mock, test } from 'bun:test';
import { ensureSeeded } from '@/lib/seeds';
import { CROP_CATALOGUE, CROP_CATALOGUE_VERSION } from '@/lib/crops/catalogue';

test('seeding repairs partial catalogues using atomic per-crop upserts', async () => {
  type Database = NonNullable<Parameters<typeof ensureSeeded>[0]>;
  const upsert = mock(async (_args: Parameters<Database['cropCharacteristic']['upsert']>[0]) => ({}));
  const updateSources = mock(async (_args: Parameters<Database['dataSource']['updateMany']>[0]) => ({ count: 1 }));
  const database = {
    dataSource: { count: async () => 1, updateMany: updateSources },
    cropCharacteristic: { count: async () => 1, upsert },
  } as unknown as Database;
  await Promise.all([ensureSeeded(database), ensureSeeded(database)]);
  await ensureSeeded(database);
  expect(updateSources).toHaveBeenCalled();
  for (const [args] of updateSources.mock.calls) {
    expect(args.where?.productVersion).toBeNull();
    expect(args.data).toBeObject();
  }
  expect(upsert).toHaveBeenCalledTimes(CROP_CATALOGUE.length);
  for (const [args] of upsert.mock.calls) {
    const key = args.where.catalogueVersion_cropKey;
    if (!key) throw new Error('Missing composite catalogue key');
    expect(key.catalogueVersion).toBe(CROP_CATALOGUE_VERSION);
    expect(args.update).toEqual({});
    expect(args.create.cropKey).toBe(key.cropKey);
  }
});