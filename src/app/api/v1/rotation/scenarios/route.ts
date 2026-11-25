import { z } from 'zod';
import { db } from '@/lib/db';
import {
  apiHandler, clientKey, dedupedBoundedArray, decodeCursor, encodeCursor, errorResponse,
  jsonResponse, paginationSchema, parseBody, rateLimit, rateLimitResponse,
  withIdempotency, writeMutationEffects,
} from '@/lib/api/helpers';
import { evaluateRotation } from '@/lib/crops/rotation-engine';
import { CROP_CATALOGUE_VERSION, cropByKey } from '@/lib/crops/catalogue';
import { rainfallMonthlyStats, thermalMonthlyStats } from '@/lib/ingest/power';
import type { Priorities, SoilInformation } from '@/lib/crops/rotation-engine';
import { accountUserId } from '@/lib/auth';
import { visibleOwner } from '@/lib/account-access';

/**
 * POST /api/v1/rotation/scenarios — evaluate + persist a named scenario
 * GET  /api/v1/rotation/scenarios?farmId= — list stored scenarios
 */

const prioritiesSchema = z.object({
  soilHealth: z.number().min(0).max(1).default(0.2),
  waterEfficiency: z.number().min(0).max(1).default(0.2),
  seasonalAdaptability: z.number().min(0).max(1).default(0.15),
  nutrientManagement: z.number().min(0).max(1).default(0.15),
  cropDiversity: z.number().min(0).max(1).default(0.15),
  economics: z.number().min(0).max(1).default(0.05),
  foodSecurity: z.number().min(0).max(1).default(0.1),
});

const bodySchema = z.object({
  farmId: z.string(),
  name: z.string().min(1).max(120),
  cropKeys: dedupedBoundedArray(z.string(), 8, 1),
  priorities: prioritiesSchema.prefault({}),
  persist: z.boolean().default(true),
});

async function loadFarmContext(farmId: string): Promise<{
  lat: number;
  lon: number;
  soil: SoilInformation | null;
  rainfall: Awaited<ReturnType<typeof rainfallMonthlyStats>>;
  thermal: Awaited<ReturnType<typeof thermalMonthlyStats>>;
} | null> {
  const farm = await db.farm.findUnique({ where: { id: farmId } });
  if (!farm) return null;
  const soilTests = await db.soilTest.findMany({
    where: { farmId },
    orderBy: [{ source: 'asc' }, { measuredAt: 'desc' }, { id: 'desc' }],
    take: 200,
  });
  const measured = soilTests.find((test) => test.source === 'laboratory') ?? soilTests.find((test) => test.source === 'farmer');
  const modeled = soilTests.find((test) => test.source === 'soilgrids');
  const chosen = measured ?? modeled ?? null;
  const soil: SoilInformation | null = chosen
    ? { ph: chosen.ph, texture: chosen.texture, source: chosen.source as SoilInformation['source'], organicCarbonPct: chosen.organicCarbonPct }
    : null;
  const [rainfall, thermal] = await Promise.all([
    rainfallMonthlyStats(farm.centroidLat, farm.centroidLon, farm.ownerId ? farmId : undefined),
    thermalMonthlyStats(farm.centroidLat, farm.centroidLon, farm.ownerId ? farmId : undefined),
  ]);
  return { lat: farm.centroidLat, lon: farm.centroidLon, soil, rainfall, thermal };
}

export const POST = apiHandler((req, { correlationId }) => withIdempotency(req, '/api/v1/rotation/scenarios', async (req, { userId }) => {
  const rl = await rateLimit(clientKey(req, 'rotation:scenarios'), { capacity: 20, refillPerMinute: 10 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);
  const parsed = await parseBody(req, bodySchema);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;

  const context = await loadFarmContext(body.farmId);
  if (!context) return errorResponse(404, 'NOT_FOUND', `farm ${body.farmId} not found`, correlationId);
  for (const key of body.cropKeys) {
    if (!cropByKey(key)) return errorResponse(400, 'UNKNOWN_CROP', `crop '${key}' is not in catalogue version ${CROP_CATALOGUE_VERSION}`, correlationId);
  }

  const priorities: Priorities = body.priorities;
  const result = evaluateRotation(body.cropKeys, body.name, { rainfall: context.rainfall, thermal: context.thermal }, context.soil, priorities);
  if (!body.persist) return jsonResponse({ result }, { correlationId });

  return {
    commit: async (tx) => {
      const scenario = await tx.rotationScenario.create({ data: {
        farmId: body.farmId,
        name: body.name,
        cropKeys: JSON.stringify(body.cropKeys),
        ruleVersion: result.ruleVersion,
        weights: JSON.stringify(priorities),
        scoresJson: JSON.stringify(result),
        overallScore: result.overallScore,
        confidence: result.confidence,
        incompatibleJson: JSON.stringify(result.incompatible),
      } });
      await writeMutationEffects(tx, {
        actor: `account:${userId}`,
        action: 'scenario.create',
        targetId: scenario.id,
        detail: `${body.name}: ${body.cropKeys.join('→')}`,
        aggregateType: 'RotationScenario',
        aggregateId: scenario.id,
        eventType: 'scenario.created',
        payload: { scenarioId: scenario.id, farmId: body.farmId, ownerId: userId },
      });
      return jsonResponse({ scenarioId: scenario.id, result }, { status: 201, correlationId });
    },
  };
}));

export const GET = apiHandler(async (req, { correlationId }) => {
  const url = new URL(req.url);
  const farmId = url.searchParams.get('farmId') ?? undefined;
  const query = paginationSchema(100, 50).parse(Object.fromEntries(url.searchParams.entries()));
  const scenarios = await db.rotationScenario.findMany({
    where: { ...(farmId ? { farmId } : {}), farm: visibleOwner(await accountUserId(req)) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: decodeCursor(query.cursor) }, skip: 1 } : {}),
  });
  const page = scenarios.slice(0, query.limit);
  const nextCursor = scenarios.length > query.limit ? encodeCursor(page[page.length - 1].id) : null;
  return jsonResponse({
    scenarios: page.map((scenario) => ({
      id: scenario.id,
      farmId: scenario.farmId,
      name: scenario.name,
      cropKeys: JSON.parse(scenario.cropKeys) as string[],
      ruleVersion: scenario.ruleVersion,
      overallScore: scenario.overallScore,
      confidence: scenario.confidence,
      incompatible: JSON.parse(scenario.incompatibleJson ?? '[]'),
      createdAt: scenario.createdAt,
      result: JSON.parse(scenario.scoresJson),
    })),
    nextCursor,
  }, { correlationId });
});
