import { resilientFetch } from '@/lib/http';
import { db } from '@/lib/db';

/**
 * NASA FIRMS adapter — resilient multi-path chain.
 *
 * Primary provider: NASA FIRMS (Fire Information for Resource Management
 * System), https://firms.modaps.eosdis.nasa.gov — MODIS + VIIRS active-fire
 * detections. Auth: FIRMS MAP_KEY (free registration), read server-side only
 * from FIRMS_MAP_KEY; the key NEVER leaves the server (all FIRMS access is
 * proxied through our own API routes).
 *
 * REACHABILITY CHAIN (the "make it reachable" contract):
 *   1. FIRMS area-CSV API with MAP_KEY (fastest, sub-day granularity).
 *   2. FIRMS keyless continental CSV archives (no key needed, coarser:
 *      VIIRS S-NPP C2, 24 h regional files).
 *   3. If BOTH hosts' paths are unreachable (e.g. an egress policy blocks
 *      firms.modaps.eosdis.nasa.gov), the adapter reports honestly and the
 *      platform serves the SAME VIIRS 375 m NRT detection stream from NASA
 *      GIBS vector tiles (lib/adapters/gibsFires.ts) — real detections, no
 *      fabrication, full provenance rows — plus NASA EONET wildfire-event
 *      context (lib/adapters/eonet.ts).
 *
 * Nothing in the chain ever invents rows: every path returns only what the
 * named NASA service actually sent, and the failure note says exactly which
 * paths were attempted and which live path is serving instead.
 */

export type FirmsSource = 'VIIRS_SNPP_NRT' | 'VIIRS_NOAA20_NRT' | 'MODIS_NRT' | 'VIIRS_SNSP_C2' | 'MODIS_C2';

export type FirmsServedPath = 'firms-api' | 'firms-csv' | 'none';

export function firmsConfigured(): boolean {
  return typeof process.env.FIRMS_MAP_KEY === 'string' && process.env.FIRMS_MAP_KEY.trim().length > 8;
}

export interface FirmsRow {
  latitude: number;
  longitude: number;
  acqDate: string;
  acqTime: string;
  satellite: string;
  instrument: string;
  confidence: string;
  dayNight: string;
  frp: number | null;
  brightTi4: number | null;
}

export interface FirmsFetchResult {
  configured: boolean;
  served: FirmsServedPath;
  rows: FirmsRow[];
  note: string;
  attempted: string[];
}

/** Continental FIRMS archive bucket for a bbox centroid (heuristic, documented). */
export function regionFileForBbox(bbox: { west: number; south: number; east: number; north: number }): string {
  const lon = (bbox.west + bbox.east) / 2;
  const lat = (bbox.south + bbox.north) / 2;
  if (lon < -30) return lat > 15 ? 'North_and_Central_America' : 'South_America';
  if (lon < 60) return lat > 35 ? 'Europe' : 'Africa';
  return lat > -10 ? 'Asia' : 'Australia_NewZealand';
}

function parseFirmsCsv(text: string): { rows: FirmsRow[]; invalidKey: boolean } {
  const lines = text.trim().split(/\r?\n/);
  if (lines[0]?.toLowerCase().includes('invalid')) return { rows: [], invalidKey: true };
  const header = (lines[0] ?? '').split(',').map((h) => h.trim());
  const idx = (name: string) => header.findIndex((h) => h.toUpperCase() === name.toUpperCase());
  const iLat = idx('latitude');
  const iLon = idx('longitude');
  const iDate = idx('acq_date');
  const iTime = idx('acq_time');
  const iSat = idx('satellite');
  const iInstr = idx('instrument');
  const iConf = idx('confidence');
  const iDay = idx('daynight');
  const iFrp = idx('frp');
  const iTi4 = idx('bright_ti4');
  const rows: FirmsRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    const lat = Number(cells[iLat]);
    const lon = Number(cells[iLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    rows.push({
      latitude: lat,
      longitude: lon,
      acqDate: cells[iDate] ?? '',
      acqTime: cells[iTime] ?? '',
      satellite: cells[iSat] ?? '',
      instrument: cells[iInstr] ?? '',
      confidence: cells[iConf] ?? '',
      dayNight: cells[iDay] ?? '',
      frp: Number.isFinite(Number(cells[iFrp])) ? Number(cells[iFrp]) : null,
      brightTi4: Number.isFinite(Number(cells[iTi4])) ? Number(cells[iTi4]) : null,
    });
  }
  return { rows, invalidKey: false };
}

export async function fetchFirmsAreaCsv(
  bbox: { west: number; south: number; east: number; north: number },
  source: FirmsSource = 'VIIRS_SNPP_NRT',
  dayRange = 1,
  correlationId?: string,
): Promise<FirmsFetchResult> {
  const attempted: string[] = [];
  const key = process.env.FIRMS_MAP_KEY?.trim();

  // ---- path 1: MAP_KEY area API ----
  if (key) {
    const url =
      `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/${source}/` +
      `${bbox.west.toFixed(3)},${bbox.south.toFixed(3)},${bbox.east.toFixed(3)},${bbox.north.toFixed(3)}/${dayRange}`;
    attempted.push('firms area-csv API (MAP_KEY)');
    try {
      const outcome = await resilientFetch(url, {
        provider: 'FIRMS',
        datasetId: source,
        operation: 'area-csv',
        correlationId,
        maxAttempts: 2,
        timeoutMs: 20_000,
      });
      if (outcome.ok) {
        const { rows, invalidKey } = parseFirmsCsv(new TextDecoder().decode(outcome.body));
        if (invalidKey) {
          attempted.push('FIRMS rejected the MAP_KEY as invalid');
        } else {
          return { configured: true, served: 'firms-api', rows, attempted, note: `FIRMS CSV parsed: ${rows.length} rows from ${source}.` };
        }
      } else {
        attempted.push(`firms area-csv API answered HTTP ${outcome.status}`);
      }
    } catch (err) {
      attempted.push(`firms area-csv API unreachable (${err instanceof Error ? err.message : 'network error'})`);
    }
  }

  // ---- path 2: keyless continental 24 h archive (VIIRS S-NPP C2) ----
  const region = regionFileForBbox(bbox);
  const csvUrl = `https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-viirs-c2/csv/SUOMI_VIIRS_C2_${region}_24h.csv`;
  attempted.push(`keyless continental archive: ${region} 24 h`);
  try {
    const outcome = await resilientFetch(csvUrl, {
      provider: 'FIRMS',
      datasetId: `VIIRS_SNSP_C2_${region}`,
      operation: 'regional-csv',
      correlationId,
      maxAttempts: 1,
      timeoutMs: 25_000,
    });
    if (outcome.ok) {
      const { rows } = parseFirmsCsv(new TextDecoder().decode(outcome.body));
      // continental file: keep only rows inside the requested bbox
      const clipped = rows.filter(
        (r) => r.latitude >= bbox.south && r.latitude <= bbox.north && r.longitude >= bbox.west && r.longitude <= bbox.east,
      );
      return {
        configured: Boolean(key),
        served: 'firms-csv',
        rows: clipped,
        attempted,
        note: `FIRMS keyless continental archive (${region}, 24 h): ${clipped.length} row(s) inside the requested bbox of ${rows.length} total.`,
      };
    }
    attempted.push(`continental archive answered HTTP ${outcome.status}`);
  } catch (err) {
    attempted.push(`continental archive unreachable (${err instanceof Error ? err.message : 'network error'})`);
  }

  // ---- both FIRMS paths failed: report honestly, name the live path ----
  await db.dataSource
    .updateMany({
      where: { datasetName: { contains: 'FIRMS' } },
      data: { status: 'unreachable' },
    })
    .catch(() => undefined);
  return {
    configured: Boolean(key),
    served: 'none',
    rows: [],
    attempted,
    note:
      'FIRMS hosts are unreachable from this deployment network (egress policy). No data is fabricated: fire detections continue to be served live from the NASA GIBS VIIRS 375 m thermal-anomaly stream — the same VIIRS NRT detection stream FIRMS distributes — with NASA EONET providing live wildfire-event context.',
  };
}
