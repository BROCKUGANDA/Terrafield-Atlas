import { db } from '@/lib/db';
import { jsonResponse } from '@/lib/api/helpers';
import { cacheStats, cacheInvalidate } from '@/lib/cache';
import { circuitStatus } from '@/lib/http';
import { firmsConfigured } from '@/lib/adapters/firms';
import { CROP_CATALOGUE_VERSION, CROP_CATALOGUE } from '@/lib/crops/catalogue';
import { RULE_VERSION } from '@/lib/crops/rotation-engine';
import { schedulerStatus, startScheduler } from '@/lib/scheduler';
import { digestChannelStatus } from '@/lib/fires/digest-channel';
import { sourceSigns } from '@/lib/source-health';
import { experimentMetrics } from '@/lib/experiments';

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
  // LIVE provider signs: real reachability probes (60 s cache) instead of
  // static strings — the chips in the console read from this.
  const signs = await sourceSigns();

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
    experiments: await experimentMetrics(),
    providers: {
      NASA_POWER: {
        status: signs.signs.find((s) => s.key === 'NASA_POWER')?.state === 'live' ? 'live' : 'unreachable',
        latencyMs: signs.signs.find((s) => s.key === 'NASA_POWER')?.latencyMs ?? null,
        note: 'Public API, no auth. State = live reachability probe (60 s cache), not a claim of infinite uptime.',
      },
      GIBS: {
        status: signs.signs.find((s) => s.key === 'GIBS')?.state === 'live' ? 'live' : 'unreachable',
        latencyMs: signs.signs.find((s) => s.key === 'GIBS')?.latencyMs ?? null,
        note: 'WMTS raster + vector tiles, no auth. Serves the VIIRS 375 m thermal-anomaly stream (fire detections).',
      },
      SOILGRIDS: {
        status: signs.signs.find((s) => s.key === 'SOILGRIDS')?.state === 'live' ? 'live' : 'unreachable',
        latencyMs: signs.signs.find((s) => s.key === 'SOILGRIDS')?.latencyMs ?? null,
        note: 'ISRIC REST API, no auth; intermittently slow under load — circuit breaker applies.',
      },
      FIRMS_API: {
        status: signs.signs.find((s) => s.key === 'FIRMS_API')?.state ?? 'unreachable',
        latencyMs: signs.signs.find((s) => s.key === 'FIRMS_API')?.latencyMs ?? null,
        note: firmsConfigured()
          ? 'MAP_KEY configured. Host probed directly; wherever egress policy blocks it, the detection stream keeps flowing via GIBS (see FIRMS_STREAM).'
          : 'No MAP_KEY configured (set FIRMS_MAP_KEY to arm the direct CSV API). Host probed directly; the FIRMS detection stream keeps flowing via GIBS either way.',
      },
      FIRMS_STREAM: {
        status: signs.signs.find((s) => s.key === 'FIRMS_STREAM')?.state ?? 'unreachable',
        latencyMs: signs.signs.find((s) => s.key === 'FIRMS_STREAM')?.latencyMs ?? null,
        note: 'The VIIRS 375 m NRT detection stream FIRMS distributes, read through NASA GIBS vector tiles — the path fire features actually serve from. Probe requests one real tile; HTTP 404 on a gap day still proves the stream host answers.',
      },
      EONET: {
        status: signs.signs.find((s) => s.key === 'EONET')?.state ?? 'unreachable',
        latencyMs: signs.signs.find((s) => s.key === 'EONET')?.latencyMs ?? null,
        note: 'NASA Earth Observatory Natural Event Tracker v3 — live open wildfire events (event-level context, not per-pixel detections).',
      },
      EARTHDATA_APPEARS: {
        status: 'not configured',
        note: 'MOD13Q1/SMAP science files (QA flags, quantitative values) require Earthdata credentials; adapters for those sources return explicit not-configured states.',
      },
    },
    sourceSigns: { checkedAt: signs.checkedAt, probeMs: signs.probeMs, summary: signs.summary },
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
