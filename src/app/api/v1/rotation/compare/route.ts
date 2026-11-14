import { z } from 'zod';
import { db } from '@/lib/db';
import { apiHandler, clientKey, jsonResponse, parseBody, rateLimit, rateLimitResponse } from '@/lib/api/helpers';
import { evaluateRotation } from '@/lib/crops/rotation-engine';
import { cropByKey } from '@/lib/crops/catalogue';
import { rainfallMonthlyStats, thermalMonthlyStats } from '@/lib/ingest/power';
import type { Priorities, SoilInformation } from '@/lib/crops/rotation-engine';

/**
 * POST /api/v1/rotation/compare
 * Evaluates MULTIPLE alternative sequences in one call with identical farm
 * context and farmer priorities — the comparison view of the planner.
 * Deterministic: identical inputs → identical ranked output.
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
  scenarios: z
    .array(z.object({ name: z.string().min(1).max(120), cropKeys: z.array(z.string()).min(1).max(8) }))
    .min(2)
    .max(5),
  priorities: prioritiesSchema.default({}),
});

export const POST = apiHandler(async (req, { correlationId }) => {
  const rl = rateLimit(clientKey(req, 'rotation:compare'), { capacity: 15, refillPerMinute: 8 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);
  const parsed = await parseBody(req, bodySchema);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;

  const farm = await db.farm.findUnique({ where: { id: body.farmId } });
  if (!farm) {
    return jsonResponse({ error: { code: 'NOT_FOUND', message: `farm ${body.farmId} not found`, correlationId } }, { status: 404, correlationId });
  }
  for (const s of body.scenarios) {
    for (const key of s.cropKeys) {
      if (!cropByKey(key)) {
        return jsonResponse({ error: { code: 'UNKNOWN_CROP', message: `crop '${key}' is not in the catalogue`, correlationId } }, { status: 400, correlationId });
      }
    }
  }

  const soilTests = await db.soilTest.findMany({
    where: { farmId: body.farmId },
    orderBy: [{ source: 'asc' }, { measuredAt: 'desc' }],
  });
  const measured = soilTests.find((t) => t.source === 'laboratory') ?? soilTests.find((t) => t.source === 'farmer');
  const modeled = soilTests.find((t) => t.source === 'soilgrids');
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
    rainfallMonthlyStats(farm.centroidLat, farm.centroidLon),
    thermalMonthlyStats(farm.centroidLat, farm.centroidLon),
  ]);

  const priorities: Priorities = body.priorities;
  const results = body.scenarios.map((s) =>
    evaluateRotation(s.cropKeys, s.name, { rainfall, thermal }, soil, priorities),
  );

  const ranked = [...results].sort((a, b) => b.overallScore - a.overallScore);

  const job = await db.processingJob.create({
    data: {
      type: 'rotation',
      status: 'succeeded',
      params: JSON.stringify({ farmId: body.farmId, scenarios: body.scenarios.map((s) => s.name), priorities }),
      progressNote: `${results.length} alternatives evaluated with rule set ${ranked[0]?.ruleVersion}`,
      correlationId,
      finishedAt: new Date(),
    },
  });

  return jsonResponse(
    {
      jobId: job.id,
      farmId: body.farmId,
      environmentAvailable: { rainfall: !!rainfall, thermal: !!thermal },
      soilAvailable: { present: !!soil, source: soil?.source ?? null },
      ranking: ranked.map((r, i) => ({
        rank: i + 1,
        scenarioName: r.scenarioName,
        overallScore: r.overallScore,
        confidence: r.confidence,
        incompatibleCount: r.incompatible.length,
      })),
      results,
    },
    { correlationId },
  );
});
