import { db } from '@/lib/db';
import { ensureSeeded } from '@/lib/seeds';

async function main(): Promise<void> {
  await ensureSeeded();
  if (await db.farm.count() === 0) {
    await db.farm.create({
      data: {
        name: 'TerraField public demo',
        centroidLat: -0.28,
        centroidLon: 36.07,
        country: 'Kenya',
        region: 'Nakuru County',
        notes: 'Public read-only seed record. Create a verified account to add private farms.',
      },
    });
  }
  if (await db.fireWatchlist.count() === 0) {
    await db.fireWatchlist.create({
      data: {
        name: 'Nakuru public fire watch',
        label: 'Nakuru County — Rift Valley highlands',
        lat: -0.28,
        lon: 36.07,
        radiusKm: 25,
        lookbackDays: 7,
        detectionThreshold: 5,
        notes: 'Public read-only seed watchlist.',
      },
    });
  }
  console.log('[seed] production baseline is ready');
}

main()
  .catch((error) => {
    console.error('[seed] failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
