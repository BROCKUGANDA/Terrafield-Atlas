import { resilientFetch } from '@/lib/http';
import { db } from '@/lib/db';

/**
 * NASA FIRMS area-CSV adapter (MODIS + VIIRS active fires).
 *
 * Provider: NASA FIRMS (Fire Information for Resource Management System)
 * Endpoint:  https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/{SOURCE}/{bbox}/{dayRange}
 * Auth:      REQUIRES a FIRMS MAP_KEY (free registration) — read from the
 *            FIRMS_MAP_KEY environment variable, server-side only.
 * Live status this session: the FIRMS API host is NOT reachable from this
 *            deployment sandbox (connection timeouts). The adapter therefore
 *            reports 'unreachable' in health checks and the UI clearly states
 *            that fire observations are served from the NASA GIBS VIIRS
 *            375 m thermal-anomaly stream instead (same underlying VIIRS NRT
 *            detections, decoded from GIBS vector tiles).
 * SECURITY:  the MAP_KEY never leaves the server; the endpoint is proxied via
 *            our own API routes; clients cannot read the key.
 */

export type FirmsSource = 'VIIRS_SNPP_NRT' | 'VIIRS_NOAA20_NRT' | 'MODIS_NRT' | 'VIIRS_SNSP_C2' | 'MODIS_C2';

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

export async function fetchFirmsAreaCsv(
  bbox: { west: number; south: number; east: number; north: number },
  source: FirmsSource = 'VIIRS_SNPP_NRT',
  dayRange = 1,
  correlationId?: string,
): Promise<{ configured: boolean; rows: FirmsRow[]; note: string }> {
  const key = process.env.FIRMS_MAP_KEY?.trim();
  if (!key) {
    return {
      configured: false,
      rows: [],
      note:
        'FIRMS MAP_KEY is not configured on this server. Set FIRMS_MAP_KEY in the environment to enable the FIRMS CSV adapter. Fire observations are currently served from the NASA GIBS VIIRS 375 m thermal-anomaly layer (same underlying VIIRS NRT detections).',
    };
  }
  const url =
    `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/${source}/` +
    `${bbox.west.toFixed(3)},${bbox.south.toFixed(3)},${bbox.east.toFixed(3)},${bbox.north.toFixed(3)}/${dayRange}`;
  try {
    const outcome = await resilientFetch(url, {
      provider: 'FIRMS',
      datasetId: source,
      operation: 'area-csv',
      correlationId,
      maxAttempts: 2,
      timeoutMs: 20_000,
    });
    if (!outcome.ok) {
      return {
        configured: true,
        rows: [],
        note: `FIRMS responded with HTTP ${outcome.status}. This is not treated as live data.`,
      };
    }
    const text = new TextDecoder().decode(outcome.body);
    const lines = text.trim().split(/\r?\n/);
    if (lines[0]?.toLowerCase().includes('invalid') || lines[0]?.includes('Invalid MAP_KEY')) {
      return { configured: true, rows: [], note: 'FIRMS rejected the MAP_KEY as invalid.' };
    }
    const header = lines[0].split(',').map((h) => h.trim());
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
    return { configured: true, rows, note: `FIRMS CSV parsed: ${rows.length} rows from ${source}.` };
  } catch (err) {
    await db.dataSource.updateMany({
      where: { datasetName: { contains: 'FIRMS' } },
      data: { status: 'unreachable' },
    }).catch(() => undefined);
    return {
      configured: true,
      rows: [],
      note:
        'FIRMS API unreachable from this deployment sandbox (connection timeout). No fire data is fabricated; observations are served from the GIBS VIIRS thermal-anomaly stream. ' +
        (err instanceof Error ? err.message : ''),
    };
  }
}
