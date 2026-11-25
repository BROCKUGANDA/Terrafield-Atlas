import { resilientFetch, ProviderUnavailableError } from '@/lib/http';
import { cacheGet, cacheSet, canonicalKey } from '@/lib/cache';
import { redisRuntime } from '@/lib/redis';
import { isPrivateProvider } from '@/lib/ingest/provider-context';

/**
 * ISRIC SoilGrids v2.0 point adapter — SUPPLEMENTARY soil information only.
 *
 * Provider: ISRIC — World Soil Information (SoilGrids system)
 * Endpoint:  https://rest.isric.org/soilgrids/v2.0/properties/query
 * Auth:      none. Status this session: operational but intermittently slow
 *            (some point queries > 40 s); the adapter degrades gracefully.
 * Units:     mapped values use d_factor conversions which we apply here:
 *              phh2o  d_factor 10, mapped pH*10        → pH = v / 10
 *              soc    d_factor 10, mapped dg/kg        → g/kg = v / 10
 *              sand   d_factor 10, mapped g/kg         → % = v / 10
 *              clay   d_factor 10, mapped g/kg         → % = v / 10
 *              nitrogen d_factor 100, mapped cg/kg     → g/kg = v / 100
 * Coverage:  global (250 m modeled grid, updated 2020/2023 releases)
 * LIMITS:    modeled predictions (regression kriging), NOT in-field measurements.
 *            Never substitutes a laboratory soil test; always labeled with source
 *            'soilgrids' and lower confidence in downstream scoring.
 */

export interface SoilGridsProperty {
  property: 'phh2o' | 'soc' | 'sand' | 'clay' | 'nitrogen';
  depth: string; // e.g. '0-5cm'
  value: number; // converted, user-facing units
  unit: string;
  rawValue: number;
  mappedUnits: string;
}

export interface SoilGridsResult {
  lat: number;
  lon: number;
  properties: SoilGridsProperty[];
  retrievedAt: string;
}

interface RawLayer {
  name: string;
  unit_measure: { d_factor: number; mapped_units: string; target_units: string };
  depths: { label: string; values?: { mean?: number | null } }[];
}

const TARGET: Record<SoilGridsProperty['property'], string> = {
  phh2o: 'pH (−log H⁺)',
  soc: 'g/kg organic carbon',
  sand: '% sand',
  clay: '% clay',
  nitrogen: 'g/kg total N',
};

export async function fetchSoilGridsPoint(
  lat: number,
  lon: number,
  correlationId?: string,
): Promise<SoilGridsResult> {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new Error('invalid latitude');
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw new Error('invalid longitude');

  const requestLat = Number(lat.toFixed(4));
  const requestLon = Number(lon.toFixed(4));
  const cacheKey = `SOILGRIDS:point:v3:${canonicalKey({ lat: requestLat, lon: requestLon })}`;
  const refresh = () => refreshSoilGrids(requestLat, requestLon, cacheKey, correlationId);
  return isPrivateProvider() ? refresh() : redisRuntime().singleFlight(`refresh:${cacheKey}`, refresh, { ttlMs: 60_000, lockMs: 60_000 });
}

async function refreshSoilGrids(lat: number, lon: number, cacheKey: string, correlationId?: string): Promise<SoilGridsResult> {
  const cached = await cacheGet<SoilGridsResult>(cacheKey);
  if (cached) return cached;

  const url =
    `https://rest.isric.org/soilgrids/v2.0/properties/query?lon=${lon.toFixed(4)}&lat=${lat.toFixed(4)}` +
    `&property=phh2o&property=soc&property=sand&property=clay&property=nitrogen` +
    `&value=mean&depth=0-5cm`;

  const outcome = await resilientFetch(url, {
    provider: 'SOILGRIDS',
    datasetId: 'SoilGrids v2.0 (ISRIC)',
    operation: 'point-query',
    correlationId,
    maxAttempts: 2,
    timeoutMs: 30_000,
  });
  if (!outcome.ok) throw new ProviderUnavailableError('SOILGRIDS', outcome.errorDetail ?? `HTTP ${outcome.status}`);

  const parsed = JSON.parse(new TextDecoder().decode(outcome.body)) as {
    coordinates?: { lat?: unknown; lon?: unknown };
    properties?: { layers?: RawLayer[] };
  };
  const responseLat = Number(parsed.coordinates?.lat);
  const responseLon = Number(parsed.coordinates?.lon);
  if (parsed.coordinates && (!Number.isFinite(responseLat) || !Number.isFinite(responseLon) ||
      Math.abs(responseLat - lat) > 0.001 || Math.abs(responseLon - lon) > 0.001)) {
    throw new Error('SoilGrids response coordinates do not match the requested point');
  }
  const layers = parsed.properties?.layers ?? [];

  const properties: SoilGridsProperty[] = [];
  for (const layer of layers) {
    const depthBlock = layer.depths?.[0];
    const val = depthBlock?.values?.mean;
    const factor = layer.unit_measure?.d_factor;
    if (!(layer.name in TARGET) || typeof val !== 'number' || !Number.isFinite(val) || !Number.isFinite(factor) || factor <= 0) continue;
    const conv = val / factor;
    properties.push({
      property: layer.name as SoilGridsProperty['property'],
      depth: depthBlock?.label ?? '0-5cm',
      value: conv,
      unit: TARGET[layer.name as SoilGridsProperty['property']] ?? layer.unit_measure?.target_units ?? '',
      rawValue: val,
      mappedUnits: layer.unit_measure?.mapped_units ?? '',
    });
  }

  if (!properties.length) throw new Error('SoilGrids returned no usable soil properties for this location');
  const result: SoilGridsResult = {
    lat,
    lon,
    properties,
    retrievedAt: new Date().toISOString(),
  };
  await cacheSet(cacheKey, result, 24 * 60 * 60 * 1000);
  return result;
}
