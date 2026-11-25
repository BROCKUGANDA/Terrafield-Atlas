import { db } from '@/lib/db';
import { fetchSoilGridsPoint } from '@/lib/adapters/soilgrids';
import {
  apiHandler, clientKey, errorResponse, jsonResponse, rateLimit, rateLimitResponse,
  withIdempotency, writeMutationEffects,
} from '@/lib/api/helpers';
import { withPrivateProvider } from '@/lib/ingest/provider-context';

/**
 * POST /api/v1/farms/{farmId}/soil-tests/soilgrids
 * Fetches a supplementary modeled profile outside the persistence transaction.
 */

type FarmCtx = { params: Promise<{ farmId: string }> };

export const POST = apiHandler<FarmCtx>((req, { correlationId, params }) => withIdempotency(req, `/api/v1/farms/${req.nextUrl.pathname.split('/')[4]}/soil-tests/soilgrids`, async (req, { userId }) => {
  const { farmId } = await params;
  const rl = await rateLimit(clientKey(req, 'soilgrids'), { capacity: 6, refillPerMinute: 3 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);

  const farm = await db.farm.findUnique({ where: { id: farmId } });
  if (!farm) return errorResponse(404, 'NOT_FOUND', `farm ${farmId} not found`, correlationId);

  let profile: Awaited<ReturnType<typeof fetchSoilGridsPoint>>;
  try {
    const fetchProfile = () => fetchSoilGridsPoint(farm.centroidLat, farm.centroidLon, correlationId);
    profile = await (farm.ownerId ? withPrivateProvider(fetchProfile, farm.organizationId) : fetchProfile());
  } catch (err) {
    const message = farm.ownerId ? 'private provider request failed' : err instanceof Error ? err.message : String(err);
    return errorResponse(502, 'PROVIDER_UNAVAILABLE',
      'SoilGrids could not be reached. No values were fabricated — enter a farmer or laboratory soil test instead.',
      correlationId, { providerMessage: message });
  }

  const ph = profile.properties.find((property) => property.property === 'phh2o');
  const soc = profile.properties.find((property) => property.property === 'soc');
  const sand = profile.properties.find((property) => property.property === 'sand');
  const clay = profile.properties.find((property) => property.property === 'clay');
  const nitrogen = profile.properties.find((property) => property.property === 'nitrogen');
  const texture = textureFromFractions(sand?.value, clay?.value);

  return {
    commit: async (tx) => {
      const test = await tx.soilTest.create({ data: {
        farmId,
        measuredAt: new Date(),
        source: 'soilgrids',
        sourceDetail: `SoilGrids v2.0 modeled estimate (250 m grid), retrieved ${profile.retrievedAt} — NOT an in-field measurement`,
        depthCm: 5,
        texture,
        sandPct: sand ? Number(sand.value.toFixed(1)) : null,
        clayPct: clay ? Number(clay.value.toFixed(1)) : null,
        ph: ph ? Number(ph.value.toFixed(1)) : null,
        organicCarbonPct: soc ? Number((soc.value / 10).toFixed(2)) : null,
        nitrogenMgKg: nitrogen ? Number((nitrogen.value * 1000).toFixed(1)) : null,
        notes: 'Modeled supplementary profile. Properties actually returned: ' +
          profile.properties.map((property) => `${property.property}=${property.value.toFixed(2)} (${property.unit})`).join(', ') +
          '. A laboratory test is recommended before final agronomic decisions.',
      } });
      await writeMutationEffects(tx, {
        actor: `account:${userId}`,
        action: 'soil-test.soilgrids',
        targetId: test.id,
        detail: `farm=${farmId}`,
        aggregateType: 'SoilTest',
        aggregateId: test.id,
        eventType: 'soil-test.soilgrids-created',
        payload: { soilTestId: test.id, farmId, ownerId: userId },
      });
      return jsonResponse({ soilTest: test, retrieved: profile.properties }, { status: 201, correlationId });
    },
  };
}));

function textureFromFractions(sandPct: number | undefined, clayPct: number | undefined): string | null {
  if (sandPct === undefined || clayPct === undefined) return null;
  if (clayPct >= 40) return 'clay';
  if (clayPct >= 27) return sandPct <= 45 ? 'clay loam' : 'clay';
  if (sandPct >= 70) return 'sand';
  if (sandPct >= 52) return 'sandy loam';
  if (sandPct <= 20 && clayPct <= 20) return 'silt loam';
  return 'loam';
}
