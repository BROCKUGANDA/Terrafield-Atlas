import { db } from '@/lib/db';
import { GIBS_LAYERS } from '@/lib/adapters/gibsLayers';
import { apiHandler, jsonResponse } from '@/lib/api/helpers';

/**
 * GET /api/v1/observations/sources
 * The data-source register: every external dataset the platform touches,
 * with provider, product id, endpoint, coverage, resolution, units, auth,
 * rate limits, license, attribution, limitations and status.
 * Plus the GIBS map-layer registry used by the Geospatial Explorer.
 */
export const GET = apiHandler(async (_req, { correlationId }) => {
  const sources = await db.dataSource.findMany({
    orderBy: { datasetName: 'asc' },
    take: 500,
  });
  return jsonResponse({
    sources,
    mapLayers: GIBS_LAYERS.map((layer) => ({
      id: layer.id,
      name: layer.name,
      group: layer.group,
      format: layer.format,
      resolution: layer.resolution,
      temporalCoverage: layer.temporalCoverage,
      cadence: layer.cadence,
      description: layer.description,
      productSource: layer.productSource,
      limitations: layer.limitations,
      tileMatrixSet: layer.tileMatrixSet,
    })),
    note: 'The register is first-class provenance: every observation and analysis is traceable to a source and retrieval timestamp.',
    correlationId,
  }, { correlationId });
});
