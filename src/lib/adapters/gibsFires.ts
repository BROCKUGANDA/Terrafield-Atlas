import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { gunzipSync } from 'zlib';
import { resilientFetch, ProviderUnavailableError } from '@/lib/http';
import { cacheGet, cacheSet, stableHash } from '@/lib/cache';
import { db } from '@/lib/db';

/**
 * GIBS VIIRS Thermal Anomalies fire-detection adapter (server-side MVT decode).
 *
 * Provider: NASA EOSDIS GIBS — VIIRS_SNPP_Thermal_Anomalies_375m_All
 * Underlying data: VIIRS 375 m active-fire detections (the same detection
 * stream FIRMS distributes), NRT + standard processing via GIBS vector tiles.
 * Endpoint (verified): EPSG:4326 / best / {Layer} / default / {date} / 500m / {7} / {row} / {col}.mvt
 * Auth: none. Coverage: 2015-01-01 → present with isolated gap days (verified
 * against the GIBS Domains service; e.g. 2024-07-25 is absent, 2024-07-24 present).
 * Tiles with zero features / unavailable dates return HTTP 404 — this is an
 * expected, honest "no data for this date" signal, NOT an error to retry.
 *
 * Feature attributes observed live this session:
 *  LATITUDE, LONGITUDE, BRIGHT_TI4 (K), BRIGHT_TI5 (K), SCAN, TRACK,
 *  ACQ_DATE (YYYY-MM-DD), ACQ_TIME (HH:MM UTC), SATELLITE, CONFIDENCE
 *  ('l'|'n'|'h'), VERSION, DAYNIGHT ('D'|'N'), UID, FRP (MW)
 */

export const FIRE_SENSOR_LAYER = 'VIIRS_SNPP_Thermal_Anomalies_375m_All';

export interface FireDetection {
  obsDate: string;
  acqTime: string;
  latitude: number;
  longitude: number;
  confidence: 'low' | 'nominal' | 'high';
  satellite: string;
  dayNight: 'D' | 'N';
  brightTi4: number | null;
  brightTi5: number | null;
  frp: number | null;
  uid: string | null;
}

function normalizeConfidence(raw: unknown): 'low' | 'nominal' | 'high' {
  const c = String(raw ?? '').toLowerCase();
  if (c === 'l' || c === 'low') return 'low';
  if (c === 'h' || c === 'high') return 'high';
  return 'nominal';
}

/** EPSG:4326 500m level-7 grid: 160 cols × 80 rows, 2.25° tiles. */
const TILE_DEG = 2.25;

export interface BBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export function tilesForBbox(bbox: BBox): { row: number; col: number }[] {
  const colMin = Math.floor((bbox.west + 180) / TILE_DEG);
  const colMax = Math.floor((bbox.east + 180) / TILE_DEG);
  const rowMin = Math.floor((90 - bbox.north) / TILE_DEG);
  const rowMax = Math.floor((90 - bbox.south) / TILE_DEG);
  const tiles: { row: number; col: number }[] = [];
  for (let row = Math.max(0, rowMin); row <= Math.min(79, rowMax); row++) {
    for (let col = Math.max(0, colMin); col <= Math.min(159, colMax); col++) {
      tiles.push({ row, col });
    }
  }
  return tiles;
}

export interface FireTileResult {
  date: string;
  detections: FireDetection[];
  tiles: number;
  tilesWithData: number;
  dataAvailable: boolean;
}

/**
 * Fetch + decode all fire-detection MVT tiles for a bbox on one date.
 * A 404 on every tile means "no vector archive for that date" — returned
 * honestly as dataAvailable=false rather than as detections.
 */
export async function fetchFiresForDate(
  date: string,
  bbox: BBox,
  correlationId?: string,
): Promise<FireTileResult> {
  const bboxKey = `${bbox.west.toFixed(2)},${bbox.south.toFixed(2)},${bbox.east.toFixed(2)},${bbox.north.toFixed(2)}`;
  const cacheKey = `GIBS:fires:${stableHash(`${date}|${bboxKey}`)}`;
  const cached = cacheGet<FireTileResult>(cacheKey);
  if (cached) return cached;

  const tiles = tilesForBbox(bbox);
  if (tiles.length > 12) throw new Error('fire area query too large: max 12 tiles (~27° × 27°) per date');

  const detections: FireDetection[] = [];
  let tilesWithData = 0;
  let tiles404 = 0;

  for (const t of tiles) {
    const url =
      `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/${FIRE_SENSOR_LAYER}` +
      `/default/${date}/500m/7/${t.row}/${t.col}.mvt`;
    let outcome;
    try {
      outcome = await resilientFetch(url, {
        provider: 'GIBS',
        datasetId: FIRE_SENSOR_LAYER,
        operation: 'mvt-tile',
        maxAttempts: 2,
        timeoutMs: 25_000,
        correlationId,
      });
    } catch (err) {
      if (err instanceof ProviderUnavailableError) {
        tiles404++;
        continue;
      }
      throw err;
    }
    if (!outcome.ok) {
      tiles404++;
      continue;
    }
    let buf: Buffer;
    try {
      buf = gunzipSync(Buffer.from(outcome.body));
    } catch {
      buf = Buffer.from(outcome.body);
    }
    try {
      const tile = new VectorTile(new PbfReader(buf));
      let tileHasFeatures = false;
      for (const layerName of Object.keys(tile.layers)) {
        const layer = tile.layers[layerName];
        for (let i = 0; i < layer.length; i++) {
          const f = layer.feature(i);
          const p = f.properties as Record<string, unknown>;
          const lat = Number(p.LATITUDE);
          const lon = Number(p.LONGITUDE);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
          // bbox filter (defensive: tile may extend beyond the farm region)
          if (lat < bbox.south || lat > bbox.north || lon < bbox.west || lon > bbox.east) continue;
          detections.push({
            obsDate: String(p.ACQ_DATE ?? date),
            acqTime: String(p.ACQ_TIME ?? ''),
            latitude: lat,
            longitude: lon,
            confidence: normalizeConfidence(p.CONFIDENCE),
            satellite: String(p.SATELLITE ?? 'N'),
            dayNight: p.DAYNIGHT === 'N' ? 'N' : 'D',
            brightTi4: Number.isFinite(Number(p.BRIGHT_TI4)) ? Number(p.BRIGHT_TI4) : null,
            brightTi5: Number.isFinite(Number(p.BRIGHT_TI5)) ? Number(p.BRIGHT_TI5) : null,
            frp: Number.isFinite(Number(p.FRP)) ? Number(p.FRP) : null,
            uid: p.UID !== undefined && p.UID !== null ? String(p.UID) : null,
          });
          tileHasFeatures = true;
        }
      }
      if (tileHasFeatures) tilesWithData++;
    } catch (err) {
      // decode failure of one tile never fails the whole date
      console.error(`[gibs-fires] tile decode failed row=${t.row} col=${t.col}:`, err);
    }
  }

  const result: FireTileResult = {
    date,
    detections,
    tiles: tiles.length,
    tilesWithData,
    dataAvailable: !(tilesWithData === 0 && tiles404 === tiles.length),
  };
  cacheSet(cacheKey, result, 12 * 60 * 60 * 1000);
  return result;
}

/** Upsert real detections into the persistent store (idempotent on SQLite). */
export async function persistFireDetections(
  regionKey: string,
  detections: FireDetection[],
): Promise<number> {
  if (detections.length === 0) return 0;
  // chunk to keep SQLite within variable limits
  const chunkSize = 200;
  let written = 0;
  for (let i = 0; i < detections.length; i += chunkSize) {
    const chunk = detections.slice(i, i + chunkSize);
    const dates = [...new Set(chunk.map((d) => d.obsDate))];
    const existing = await db.fireObservation.findMany({
      where: {
        regionKey,
        obsDate: { gte: new Date(`${dates[0]}T00:00:00Z`), lte: new Date(`${dates[dates.length - 1]}T23:59:59Z`) },
      },
      select: { latitude: true, longitude: true, obsDate: true, acqTime: true, uid: true },
    });
    const existingKeys = new Set(
      existing.map((e) => `${e.latitude}|${e.longitude}|${e.obsDate.toISOString().slice(0, 10)}|${e.acqTime}|${e.uid ?? ''}`),
    );
    const fresh = chunk
      .map((d) => ({
        regionKey,
        obsDate: new Date(`${d.obsDate}T12:00:00Z`),
        latitude: d.latitude,
        longitude: d.longitude,
        confidence: d.confidence,
        satellite: d.satellite,
        sensor: 'VIIRS_SNPP',
        dayNight: d.dayNight,
        acqTime: d.acqTime,
        brightTi4: d.brightTi4,
        brightTi5: d.brightTi5,
        frp: d.frp,
        uid: d.uid,
        sourceProvider: 'NASA_GIBS_VIIRS_375m',
      }))
      .filter((r) => !existingKeys.has(`${r.latitude}|${r.longitude}|${r.obsDate.toISOString().slice(0, 10)}|${r.acqTime}|${r.uid ?? ''}`));
    if (fresh.length === 0) continue;
    // dedupe within batch as well (unique constraint safety)
    const batchSeen = new Set<string>();
    const deduped = fresh.filter((r) => {
      const k = `${r.latitude}|${r.longitude}|${r.obsDate.toISOString().slice(0, 10)}|${r.acqTime}|${r.uid ?? ''}`;
      if (batchSeen.has(k)) return false;
      batchSeen.add(k);
      return true;
    });
    if (deduped.length === 0) continue;
    const res = await db.fireObservation.createMany({ data: deduped });
    written += res.count;
  }
  return written;
}

export const FIRE_ARCHIVE_START = '2015-01-01';
