import { REGION_PRESETS } from '@/lib/regions';
import { jsonResponse } from '@/lib/api/helpers';

/**
 * GET /api/v1/regions
 * Curated demo region presets (real agricultural regions, real coordinates).
 * Explicitly labeled as curated presets, not an administrative dataset.
 */
export async function GET() {
  return jsonResponse({
    kind: 'curated-demo-presets',
    note:
      'A curated list of real agricultural regions provided for demonstration. This is not an administrative-boundary dataset; boundaries are drawn by the user on the map.',
    regions: REGION_PRESETS,
  });
}
