import { db } from '@/lib/db';
import { jsonResponse } from '@/lib/api/helpers';
import { cacheStats, cacheInvalidate } from '@/lib/cache';
import { circuitStatus } from '@/lib/http';
import { firmsConfigured } from '@/lib/adapters/firms';
import { CROP_CATALOGUE_VERSION, CROP_CATALOGUE } from '@/lib/crops/catalogue';
import { RULE_VERSION } from '@/lib/crops/rotation-engine';
import { schedulerStatus, startScheduler } from '@/lib/scheduler';
import { digestChannelStatus } from '@/lib/fires/digest-channel';

/**
 * GET  /api/v1/system/status — settings & diagnostics
 * POST /api/v1/system/status — actions (cache invalidate)
 */
export async function GET() {
  // startScheduler is idempotent; calling it here guarantees a started timer
  // even if instrumentation bootstrapping was skipped in this environment.
  startScheduler();
  const scheduler = await schedulerStatus();
  const failedJobs = await db.processingJob.findMany({
    where: { status: 'failed' },
    orderBy: { startedAt: 'desc' },
    take: 20,
  });
  const jobCounts = await db.processingJob.groupBy({
    by: ['status'],
    _count: { _all: true },
  });
  const observationCount = await db.environmentalObservation.count();
  const fireCount = await db.fireObservation.count();
  const farmCount = await db.farm.count();
  const watchlistCount = await db.fireWatchlist.count();
  const watchEventCount = await db.fireWatchEvent.count();

  return jsonResponse({
    service: 'terrafield-atlas',
    engines: {
      trendEngine: 'trend-engine/2026.11-r1',
      rotationEngine: RULE_VERSION,
      cropCatalogue: `${CROP_CATALOGUE_VERSION} (${CROP_CATALOGUE.length} crops, FAO-cited)`,
    },
    database: {
      observations: observationCount,
      fireDetections: fireCount,
      farms: farmCount,
      fireWatchlists: watchlistCount,
      fireWatchEvents: watchEventCount,
      jobCounts: jobCounts.map((j) => ({ status: j.status, count: j._count._all })),
      failedJobs: failedJobs.map((j) => ({
        id: j.id, type: j.type, error: j.error, startedAt: j.startedAt,
      })),
    },
    cache: cacheStats(),
    circuitBreakers: circuitStatus(),
    scheduler,
    digestChannel: digestChannelStatus(),
    providers: {
      NASA_POWER: { status: 'operational (public, no auth)' },
      GIBS: { status: 'operational (public, no auth)' },
      SOILGRIDS: { status: 'operational with intermittent slowness' },
      FIRMS: {
        status: firmsConfigured() ? 'MAP_KEY configured; host unreachable from this sandbox' : 'MAP_KEY not configured; host unreachable from this sandbox',
        note: 'Fire features are served from the GIBS VIIRS 375 m stream instead; nothing is fabricated.',
      },
      EARTHDATA_APPEARS: {
        status: 'not configured',
        note: 'MOD13Q1/SMAP science files (QA flags, quantitative values) require Earthdata credentials; adapters for those sources return explicit not-configured states.',
      },
    },
    reliability: {
      retryPolicy: 'exponential backoff with full jitter, max 3 attempts, transient-only (429/5xx/network)',
      circuitBreaker: 'per-provider, opens after 4 consecutive failures for 60 s',
      idempotentIngestion: 'natural-key upserts on (lat, lon, variable, date); fire detections on (lat, lon, date, time, uid)',
    },
    methodology: {
      trend:
        'Monthly aggregation of complete months (≥20 valid days); Seasonal Mann-Kendall (Hirsch-Slack 1984) with tie-corrected variance; Theil-Sen seasonal slope with Sen-rank 95% CI; Hamed-Rao (1998) lag-1 variance inflation when deseasonalized autocorrelation exceeds ±2/√n; Benjamini-Hochberg FDR across variables; ≥ 8 full years required before any significance claim.',
      rotation:
        'Deterministic multi-criteria weighted scoring (weights = farmer priorities, normalized); criteria: family sequence, legume N, water (FAO I&D 33 ranges vs POWER climatology), thermal feasibility, nutrient balance, diversity, soil pH/texture, staple presence, economics-not-assessed. Missing inputs remove criteria and reduce confidence; never zero.',
    },
  });
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get('action') === 'invalidate-cache') {
    const removed = cacheInvalidate('');
    return jsonResponse({ action: 'invalidate-cache', entriesRemoved: removed });
  }
  return jsonResponse({ error: { code: 'UNKNOWN_ACTION', message: 'supported action: ?action=invalidate-cache' } }, { status: 400 });
}
