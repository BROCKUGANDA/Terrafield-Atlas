import { db } from '@/lib/db';
import { fetchFiresForDate, persistFireDetections } from '@/lib/adapters/gibsFires';
import { regionKeyFor, type BoundingBox } from '@/lib/geo';
import type { WatchDay } from '@/lib/fires/watchlist-engine';

/**
 * Server-side archive-coverage bookkeeping for the GIBS VIIRS fire stream.
 *
 * FireCoverageDay is the honest ledger of "which (region, date) pairs have we
 * actually asked GIBS about": evaluations skip days already covered, re-ask
 * when a watchlist needs a WIDER bbox than previously checked, and record
 * provider archive gaps (dataAvailable=false) without ever zero-filling.
 *
 * All rows written here derive from real GIBS tile decodes — nothing synthetic.
 */

const EPS = 1e-9;

function bboxContains(outer: { west: number; south: number; east: number; north: number }, inner: { west: number; south: number; east: number; north: number }): boolean {
  return (
    outer.west <= inner.west + EPS &&
    outer.south <= inner.south + EPS &&
    outer.east >= inner.east - EPS &&
    outer.north >= inner.north - EPS
  );
}

function bboxUnion(a: BoundingBox, b: BoundingBox): BoundingBox {
  return {
    west: Math.min(a.west, b.west),
    south: Math.min(a.south, b.south),
    east: Math.max(a.east, b.east),
    north: Math.max(a.north, b.north),
  };
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Record (or widen) the coverage row for (regionKey, date). */
async function recordCoverage(
  regionKey: string,
  date: string,
  bbox: BoundingBox,
  dataAvailable: boolean,
  detectionCount: number,
): Promise<void> {
  const obsDate = new Date(`${date}T12:00:00Z`);
  const existing = await db.fireCoverageDay.findUnique({ where: { regionKey_obsDate: { regionKey, obsDate } } });
  const merged = existing
    ? bboxUnion(
        { west: existing.bboxWest, south: existing.bboxSouth, east: existing.bboxEast, north: existing.bboxNorth },
        bbox,
      )
    : bbox;
  await db.fireCoverageDay.upsert({
    where: { regionKey_obsDate: { regionKey, obsDate } },
    create: {
      regionKey,
      obsDate,
      dataAvailable,
      detectionCount,
      bboxWest: merged.west,
      bboxSouth: merged.south,
      bboxEast: merged.east,
      bboxNorth: merged.north,
      sourceProvider: 'NASA_GIBS_VIIRS_375m',
    },
    update: {
      dataAvailable,
      detectionCount,
      bboxWest: merged.west,
      bboxSouth: merged.south,
      bboxEast: merged.east,
      bboxNorth: merged.north,
      checkedAt: new Date(),
    },
  });
}

/** Used by the plain /fires ingestion route so both features share coverage. */
export async function recordIngestCoverage(
  lat: number,
  lon: number,
  date: string,
  bbox: BoundingBox,
  dataAvailable: boolean,
  detectionCount: number,
): Promise<void> {
  await recordCoverage(regionKeyFor(lat, lon), date, bbox, dataAvailable, detectionCount);
}

export interface EnsuredDay extends WatchDay {
  /** detections newly decoded from GIBS this call (0 unless fetched). */
  fetched: boolean;
  rowsWritten: number;
}

/**
 * Ensure the (region, date) archive coverage exists and covers `bbox`.
 * Returns the honest day flags. Days never checked OR previously checked with
 * a narrower bbox are fetched live from GIBS (idempotent persistence).
 */
export async function ensureCoverageForDate(
  regionKey: string,
  date: string,
  bbox: BoundingBox,
  correlationId?: string,
): Promise<EnsuredDay> {
  const obsDate = new Date(`${date}T12:00:00Z`);
  const existing = await db.fireCoverageDay.findUnique({ where: { regionKey_obsDate: { regionKey, obsDate } } });
  if (existing) {
    const existingBbox = { west: existing.bboxWest, south: existing.bboxSouth, east: existing.bboxEast, north: existing.bboxNorth };
    if (bboxContains(existingBbox, bbox)) {
      // Also honour legacy stored rows (ingested before coverage ledger existed).
      return { date, checked: true, dataAvailable: existing.dataAvailable, fetched: false, rowsWritten: 0 };
    }
  }

  const merged = existing
    ? bboxUnion({ west: existing.bboxWest, south: existing.bboxSouth, east: existing.bboxEast, north: existing.bboxNorth }, bbox)
    : bbox;
  const res = await fetchFiresForDate(date, merged, correlationId);
  const rowsWritten = await persistFireDetections(regionKey, res.detections);
  await recordCoverage(regionKey, date, merged, res.dataAvailable, res.detections.length);
  return {
    date,
    checked: true,
    dataAvailable: res.dataAvailable,
    fetched: true,
    rowsWritten,
  };
}

/** Stored real detections for (regionKey, bbox, window) — any confidence class. */
export async function storedDetections(
  regionKey: string,
  bbox: BoundingBox,
  fromIso: string,
  toIso: string,
): Promise<{ date: string; confidence: string; frp: number | null }[]> {
  const rows = await db.fireObservation.findMany({
    where: {
      regionKey,
      obsDate: { gte: new Date(`${fromIso}T00:00:00Z`), lte: new Date(`${toIso}T23:59:59Z`) },
      latitude: { gte: bbox.south, lte: bbox.north },
      longitude: { gte: bbox.west, lte: bbox.east },
    },
    select: { obsDate: true, confidence: true, frp: true },
    orderBy: { obsDate: 'asc' },
  });
  return rows.map((r) => ({ date: isoDay(r.obsDate), confidence: r.confidence, frp: r.frp ?? null }));
}
