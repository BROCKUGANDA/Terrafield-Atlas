import { z } from 'zod';
import { db } from '@/lib/db';
import { apiHandler, clientKey, jsonResponse, parseBody, rateLimit, rateLimitResponse } from '@/lib/api/helpers';
import { evaluateRotation } from '@/lib/crops/rotation-engine';
import { CROP_CATALOGUE, CROP_CATALOGUE_VERSION, cropByKey } from '@/lib/crops/catalogue';
import { rainfallMonthlyStats, thermalMonthlyStats } from '@/lib/ingest/power';
import type { Priorities, SoilInformation } from '@/lib/crops/rotation-engine';

/**
 * POST /api/v1/rotation/scenarios — evaluate + persist a named scenario
 * GET  /api/v1/rotation/scenarios?farmId= — list stored scenarios
 *
 * The engine is deterministic: same inputs + rule version → same outputs.
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
  cropKeys: z.array(z.string()).min(1).max(8),
  priorities: prioritiesSchema.default({}),
  persist: z.boolean().default(true),
});

export async function loadFarmContext(farmId: string): Promise<{
  lat: number;
  lon: number;
  soil: SoilInformation | null;
  rainfall: Awaited<ReturnType<typeof rainfallMonthlyStats>>;
  thermal: Awaited<ReturnType<typeof thermalMonthlyStats>>;
  soilSourceDetail: string | null;
} | null> {
  const farm = await db.farm.findUnique({ where: { id: farmId } });
  if (!farm) return null;
  const { centroidLat, centroidLon } = farm;

  const soilTests = await db.soilTest.findMany({
    where: { farmId },
    orderBy: [{ source: 'asc' }, { measuredAt: 'desc' }], // 'farmer' < 'laboratory' < 'soilgrids'
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
    rainfallMonthlyStats(centroidLat, centroidLon),
    thermalMonthlyStats(centroidLat, centroidLon),
  ]);

  return {
    lat: centroidLat,
    lon: centroidLon,
    soil,
    rainfall,
    thermal,
    soilSourceDetail: chosen?.sourceDetail ?? null,
  };
}

export const POST = apiHandler(async (req, { correlationId }) => {
  const rl = rateLimit(clientKey(req, 'rotation:scenarios'), { capacity: 20, refillPerMinute: 10 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);
  const parsed = await parseBody(req, bodySchema);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;

  const ctx = await loadFarmContext(body.farmId);
  if (!ctx) {
    return jsonResponse({ error: { code: 'NOT_FOUND', message: `farm ${body.farmId} not found`, correlationId } }, { status: 404, correlationId });
  }
  for (const key of body.cropKeys) {
    if (!cropByKey(key)) {
      return jsonResponse({ error: { code: 'UNKNOWN_CROP', message: `crop '${key}' is not in catalogue version ${CROP_CATALOGUE_VERSION}`, correlationId } }, { status: 400, correlationId });
    }
  }

  const priorities: Priorities = body.priorities;

  const result = evaluateRotation(
    body.cropKeys,
    body.name,
    { rainfall: ctx.rainfall, thermal: ctx.thermal },
    ctx.soil,
    priorities,
  );

  if (body.persist) {
    const scenario = await db.rotationScenario.create({
      data: {
        farmId: body.farmId,
        name: body.name,
        cropKeys: JSON.stringify(body.cropKeys),
        ruleVersion: result.ruleVersion,
        weights: JSON.stringify(priorities),
        scoresJson: JSON.stringify(result),
        overallScore: result.overallScore,
        confidence: result.confidence,
        incompatibleJson: JSON.stringify(result.incompatible),
      },
    });
    await db.auditEvent.create({
      data: { actor: 'demo-user', action: 'scenario.create', targetId: scenario.id, detail: `${body.name}: ${body.cropKeys.join('→')}` },
    });
    return jsonResponse({ scenarioId: scenario.id, result }, { status: 201, correlationId });
  }
  return jsonResponse({ result }, { correlationId });
});

export const GET = apiHandler(async (req, { correlationId }) => {
  const url = new URL(req.url);
  const farmId = url.searchParams.get('farmId') ?? undefined;
  const scenarios = await db.rotationScenario.findMany({
    where: farmId ? { farmId } : undefined,
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return jsonResponse(
    {
      scenarios: scenarios.map((s) => ({
        id: s.id,
        farmId: s.farmId,
        name: s.name,
        cropKeys: JSON.parse(s.cropKeys) as string[],
        ruleVersion: s.ruleVersion,
        overallScore: s.overallScore,
        confidence: s.confidence,
        incompatible: JSON.parse(s.incompatibleJson ?? '[]'),
        createdAt: s.createdAt,
        result: JSON.parse(s.scoresJson),
      })),
    },
    { correlationId },
  );
});
