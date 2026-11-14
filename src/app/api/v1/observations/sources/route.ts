import { db } from '@/lib/db';
import { GIBS_LAYERS } from '@/lib/adapters/gibsLayers';
import { jsonResponse } from '@/lib/api/helpers';

/**
 * GET /api/v1/observations/sources
 * The data-source register: every external dataset the platform touches,
 * with provider, product id, endpoint, coverage, resolution, units, auth,
 * rate limits, license, attribution, limitations and status.
 * Plus the GIBS map-layer registry used by the Geospatial Explorer.
 */
export async function GET() {
  const sources = await db.dataSource.findMany({
    orderBy: { datasetName: 'asc' },
  });
  return jsonResponse({
    sources,
    mapLayers: GIBS_LAYERS.map((l) => ({
      id: l.id,
      name: l.name,
      group: l.group,
      format: l.format,
      resolution: l.resolution,
      temporalCoverage: l.temporalCoverage,
      cadence: l.cadence,
      description: l.description,
      productSource: l.productSource,
      limitations: l.limitations,
      tileMatrixSet: l.tileMatrixSet,
    })),
    note:
      'The register is first-class provenance: every observation and analysis in this platform is traceable to one of these sources and its retrieval timestamp.',
  });
}
