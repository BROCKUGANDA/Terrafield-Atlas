import { db } from '@/lib/db';
import { fetchSoilGridsPoint } from '@/lib/adapters/soilgrids';
import { apiHandler, clientKey, jsonResponse, rateLimit, rateLimitResponse } from '@/lib/api/helpers';

/**
 * POST /api/v1/farms/{farmId}/soil-tests/soilgrids
 * Fetches the SUPPLEMENTARY SoilGrids v2.0 modeled profile for the farm
 * centroid and stores it as a soil test labeled source='soilgrids'.
 *
 * Honesty rules:
 * - stored with source 'soilgrids' and sourceDetail noting it is a modeled
 *   250 m grid estimate, clearly distinguishable from farmer/lab tests
 * - the rotation engine reduces confidence when only this profile is present
 * - on provider failure the route returns a structured degraded response —
 *   it NEVER substitutes fabricated values
 */

type FarmCtx = { params: Promise<{ farmId: string }> };

export const POST = apiHandler<FarmCtx>(async (req, { correlationId, params }) => {
  const { farmId } = await params;
  const rl = rateLimit(clientKey(req, 'soilgrids'), { capacity: 6, refillPerMinute: 3 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);

  const farm = await db.farm.findUnique({ where: { id: farmId } });
  if (!farm) {
    return jsonResponse({ error: { code: 'NOT_FOUND', message: `farm ${farmId} not found`, correlationId } }, { status: 404, correlationId });
  }

  try {
    const profile = await fetchSoilGridsPoint(farm.centroidLat, farm.centroidLon, correlationId);
    const ph = profile.properties.find((p) => p.property === 'phh2o');
    const soc = profile.properties.find((p) => p.property === 'soc');
    const sand = profile.properties.find((p) => p.property === 'sand');
    const clay = profile.properties.find((p) => p.property === 'clay');
    const nitrogen = profile.properties.find((p) => p.property === 'nitrogen');

    const texture = textureFromFractions(sand?.value, clay?.value);

    const test = await db.soilTest.create({
      data: {
        farmId,
        measuredAt: new Date(),
        source: 'soilgrids',
        sourceDetail: `SoilGrids v2.0 modeled estimate (250 m grid), retrieved ${profile.retrievedAt} — NOT an in-field measurement`,
        depthCm: 5,
        texture,
        sandPct: sand ? Number(sand.value.toFixed(1)) : null,
        clayPct: clay ? Number(clay.value.toFixed(1)) : null,
        ph: ph ? Number(ph.value.toFixed(1)) : null,
        organicCarbonPct: soc ? Number((soc.value / 10).toFixed(2)) : null, // g/kg → %
        nitrogenMgKg: nitrogen ? Number((nitrogen.value * 10).toFixed(1)) : null, // g/kg → mg/kg
        notes:
          'Modeled supplementary profile. Properties actually returned: ' +
          profile.properties.map((p) => `${p.property}=${p.value.toFixed(2)} (${p.unit})`).join(', ') +
          '. A laboratory test is recommended before final agronomic decisions.',
      },
    });
    return jsonResponse({ soilTest: test, retrieved: profile.properties }, { status: 201, correlationId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse(
      {
        error: {
          code: 'PROVIDER_UNAVAILABLE',
          message:
            'SoilGrids could not be reached (the service is intermittently slow or unreachable from this deployment). No values were fabricated — enter a farmer or laboratory soil test instead.',
          providerMessage: msg,
          correlationId,
        },
      },
      { status: 502, correlationId },
    );
  }
});

function textureFromFractions(sandPct: number | undefined, clayPct: number | undefined): string | null {
  if (sandPct === undefined || clayPct === undefined) return null;
  const sand = sandPct;
  const clay = clayPct;
  if (clay >= 40) return 'clay';
  if (clay >= 27) return sand <= 45 ? 'clay loam' : 'clay';
  if (sand >= 70) return 'sand';
  if (sand >= 52) return 'sandy loam';
  if (sand <= 20 && clay <= 20) return 'silt loam';
  return 'loam';
}
