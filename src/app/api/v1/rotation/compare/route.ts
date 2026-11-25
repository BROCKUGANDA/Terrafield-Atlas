import { z } from 'zod';
import { db } from '@/lib/db';
import {
  apiHandler, clientKey, dedupedBoundedArray, errorResponse, jsonResponse,
  parseBody, rateLimit, rateLimitResponse, withIdempotency, writeMutationEffects,
} from '@/lib/api/helpers';
import { evaluateRotation } from '@/lib/crops/rotation-engine';
import { cropByKey } from '@/lib/crops/catalogue';
import { rainfallMonthlyStats, thermalMonthlyStats } from '@/lib/ingest/power';
import type { Priorities, SoilInformation } from '@/lib/crops/rotation-engine';

/**
 * POST /api/v1/rotation/compare
 * Evaluates alternative sequences with identical farm context and priorities.
 * Provider/climatology work happens before the serializable persistence transaction.
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
  scenarios: z.array(z.object({
    name: z.string().min(1).max(120),
    cropKeys: dedupedBoundedArray(z.string(), 8, 1),
  })).min(2).max(5),
  priorities: prioritiesSchema.prefault({}),
});

export const POST = apiHandler((req, { correlationId }) => withIdempotency(req, '/api/v1/rotation/compare', async (req, { userId }) => {
  const rl = await rateLimit(clientKey(req, 'rotation:compare'), { capacity: 15, refillPerMinute: 8 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);
  const parsed = await parseBody(req, bodySchema);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;

  const names = body.scenarios.map((scenario) => scenario.name);
  if (new Set(names).size !== names.length) {
    return errorResponse(400, 'DUPLICATE_SCENARIO_NAME', 'scenario names must be unique within one comparison', correlationId);
  }

  const farm = await db.farm.findUnique({ where: { id: body.farmId } });
  if (!farm) return errorResponse(404, 'NOT_FOUND', `farm ${body.farmId} not found`, correlationId);
  for (const scenario of body.scenarios) {
    for (const key of scenario.cropKeys) {
      if (!cropByKey(key)) {
        return errorResponse(400, 'UNKNOWN_CROP', `crop '${key}' is not in the catalogue`, correlationId);
      }
    }
  }

  const soilTests = await db.soilTest.findMany({
    where: { farmId: body.farmId },
    orderBy: [{ source: 'asc' }, { measuredAt: 'desc' }, { id: 'desc' }],
    take: 200,
  });
  const measured = soilTests.find((test) => test.source === 'laboratory') ?? soilTests.find((test) => test.source === 'farmer');
  const modeled = soilTests.find((test) => test.source === 'soilgrids');
  const chosen = measured ?? modeled ?? null;
  const soil: SoilInformation | null = chosen
    ? {
        ph: chosen.ph,
        texture: chosen.texture,
        source: chosen.source as SoilInformation['source'],
        organicCarbonPct: chosen.organicCarbonPct,
      }
    : null;

  const [rainfall, thermal] = await Promise.all([
    rainfallMonthlyStats(farm.centroidLat, farm.centroidLon, farm.ownerId ? farm.id : undefined),
    thermalMonthlyStats(farm.centroidLat, farm.centroidLon, farm.ownerId ? farm.id : undefined),
  ]);

  const priorities: Priorities = body.priorities;
  const results = body.scenarios.map((scenario) =>
    evaluateRotation(scenario.cropKeys, scenario.name, { rainfall, thermal }, soil, priorities),
  );
  const ranked = [...results].sort((a, b) => b.overallScore - a.overallScore);

  return {
    commit: async (tx) => {
      const persistedScenarioIds: string[] = [];
      for (const scenario of body.scenarios) {
        const result = results.find((item) => item.scenarioName === scenario.name)!;
        const data = {
          cropKeys: JSON.stringify(scenario.cropKeys),
          ruleVersion: result.ruleVersion,
          weights: JSON.stringify(priorities),
          scoresJson: JSON.stringify(result),
          overallScore: result.overallScore,
          confidence: result.confidence,
          incompatibleJson: JSON.stringify(result.incompatible),
        };
        const stored = await tx.rotationScenario.upsert({
          where: { farmId_name: { farmId: body.farmId, name: scenario.name } },
          create: { farmId: body.farmId, name: scenario.name, ...data },
          update: data,
        });
        persistedScenarioIds.push(stored.id);
      }
      await writeMutationEffects(tx, {
        actor: `account:${userId}`,
        action: 'scenario.compare',
        targetId: body.farmId,
        detail: `${results.length} alternatives compared (${persistedScenarioIds.length} persisted): ${names.join(' | ')}`,
        aggregateType: 'Farm',
        aggregateId: body.farmId,
        eventType: 'scenario.compared',
        payload: { farmId: body.farmId, ownerId: userId, scenarioIds: persistedScenarioIds },
      });
      const job = await tx.processingJob.create({
        data: {
          type: 'rotation',
          ownerId: farm.ownerId,
          status: 'succeeded',
          params: JSON.stringify({ farmId: body.farmId, scenarios: names, priorities }),
          progressNote: `${results.length} alternatives evaluated with rule set ${ranked[0]?.ruleVersion}`,
          resultRef: JSON.stringify({ scenarioIds: persistedScenarioIds }),
          correlationId,
          finishedAt: new Date(),
        },
      });
      return jsonResponse({
        jobId: job.id,
        farmId: body.farmId,
        environmentAvailable: { rainfall: !!rainfall, thermal: !!thermal },
        soilAvailable: { present: !!soil, source: soil?.source ?? null },
        ranking: ranked.map((result, index) => ({
          rank: index + 1,
          scenarioName: result.scenarioName,
          overallScore: result.overallScore,
          confidence: result.confidence,
          incompatibleCount: result.incompatible.length,
        })),
        results,
      }, { correlationId });
    },
  };
}));
