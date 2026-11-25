import { describe, test, vi } from 'vitest';
import { parseFirmsCsv } from '@/lib/adapters/firms';
import {
  evaluateWatchlist,
  windowFor,
  type WatchDay,
  type WatchDetection,
} from '@/lib/fires/watchlist-engine';
import { firmsCsv, seededRandom } from './fixtures';

// parseFirmsCsv is pure, but its module also imports the database and HTTP
// clients. Stub them so the benchmark needs no Prisma client, Postgres or Redis.
vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/http', () => ({ resilientFetch: () => { throw new Error('no network in benchmarks'); } }));

const CSV_1K = firmsCsv(1_000, 10, 20);
const CSV_20K = firmsCsv(20_000, 10, 21);

function watchInput(lookbackDays: number, detectionCount: number, seed: number) {
  const rand = seededRandom(seed);
  const { start, end, days: dates } = windowFor('2026-08-31', lookbackDays);
  // A few archive gaps, so the coverage branches are exercised too.
  const days: WatchDay[] = dates.map((date, i) => ({ date, checked: true, dataAvailable: i % 13 !== 5 }));
  const confidences = ['low', 'nominal', 'high'];
  const detections: WatchDetection[] = Array.from({ length: detectionCount }, () => ({
    date: dates[Math.floor(rand() * dates.length)],
    confidence: confidences[Math.floor(rand() * 3)],
    frp: rand() < 0.05 ? null : Number((rand() * 50).toFixed(1)),
  }));
  return { windowStart: start, windowEnd: end, days, detections, lookbackDays };
}

const WATCH_7D = watchInput(7, 500, 30);
const WATCH_30D = watchInput(30, 20_000, 31);

describe('fires', () => {
  test('parseFirmsCsv', async ({ bench }) => {
    await bench.compare(
      bench('1,000 VIIRS detections', () => {
        parseFirmsCsv(CSV_1K);
      }),
      bench('20,000 VIIRS detections', () => {
        parseFirmsCsv(CSV_20K);
      }),
    );
  });

  // Runs for every regional watchlist on each scheduler tick.
  test('evaluateWatchlist', async ({ bench }) => {
    await bench.compare(
      bench('7-day window, 500 detections', () => {
        evaluateWatchlist({ ...WATCH_7D, minConfidence: 'nominal', detectionThreshold: 10 });
      }),
      bench('30-day window, 20,000 detections', () => {
        evaluateWatchlist({ ...WATCH_30D, minConfidence: 'high', detectionThreshold: 50 });
      }),
    );
  });
});
