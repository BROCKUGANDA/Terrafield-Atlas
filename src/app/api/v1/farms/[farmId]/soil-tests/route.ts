import { z } from 'zod';
import { db } from '@/lib/db';
import { apiHandler, clientKey, jsonResponse, parseBody, rateLimit, rateLimitResponse } from '@/lib/api/helpers';

/**
 * GET  /api/v1/farms/{farmId}/soil-tests
 * POST /api/v1/farms/{farmId}/soil-tests — farmer or laboratory soil measurement
 *
 * Farmer/lab values are stored verbatim with their source label. They are
 * never mixed silently with modeled SoilGrids values (separate route).
 */

const postSchema = z.object({
  measuredAt: z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  source: z.enum(['farmer', 'laboratory']),
  sourceDetail: z.string().max(160).optional(),
  depthCm: z.number().min(0).max(300).optional(),
  texture: z.string().max(40).optional(),
  sandPct: z.number().min(0).max(100).optional(),
  siltPct: z.number().min(0).max(100).optional(),
  clayPct: z.number().min(0).max(100).optional(),
  ph: z.number().min(0).max(14).optional(),
  organicCarbonPct: z.number().min(0).max(90).optional(),
  nitrogenMgKg: z.number().min(0).max(20_000).optional(),
  phosphorusMgKg: z.number().min(0).max(20_000).optional(),
  potassiumCmolKg: z.number().min(0).max(500).optional(),
  notes: z.string().max(1000).optional(),
});

type FarmCtx = { params: Promise<{ farmId: string }> };

export const GET = apiHandler<FarmCtx>(async (req, { correlationId, params }) => {
  const { farmId } = await params;
  const tests = await db.soilTest.findMany({
    where: { farmId },
    orderBy: [{ source: 'asc' }, { measuredAt: 'desc' }],
    take: 100,
  });
  return jsonResponse({ soilTests: tests }, { correlationId });
});

export const POST = apiHandler<FarmCtx>(async (req, { correlationId, params }) => {
  const { farmId } = await params;
  const rl = rateLimit(clientKey(req, 'soil-tests:create'), { capacity: 20, refillPerMinute: 10 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);
  const farm = await db.farm.findUnique({ where: { id: farmId } });
  if (!farm) {
    return jsonResponse({ error: { code: 'NOT_FOUND', message: `farm ${farmId} not found`, correlationId } }, { status: 404, correlationId });
  }
  const parsed = await parseBody(req, postSchema);
  if (!parsed.ok) return parsed.res;
  const b = parsed.data;

  // fraction sanity: sand+silt+clay must not exceed 100%
  const frac = (b.sandPct ?? 0) + (b.siltPct ?? 0) + (b.clayPct ?? 0);
  if (frac > 100) {
    return jsonResponse(
      { error: { code: 'VALIDATION_ERROR', message: 'sand + silt + clay percentages exceed 100%', correlationId } },
      { status: 400, correlationId },
    );
  }

  const test = await db.soilTest.create({
    data: {
      farmId,
      measuredAt: new Date(b.measuredAt),
      source: b.source,
      sourceDetail: b.sourceDetail ?? null,
      depthCm: b.depthCm ?? null,
      texture: b.texture ?? null,
      sandPct: b.sandPct ?? null,
      siltPct: b.siltPct ?? null,
      clayPct: b.clayPct ?? null,
      ph: b.ph ?? null,
      organicCarbonPct: b.organicCarbonPct ?? null,
      nitrogenMgKg: b.nitrogenMgKg ?? null,
      phosphorusMgKg: b.phosphorusMgKg ?? null,
      potassiumCmolKg: b.potassiumCmolKg ?? null,
      notes: b.notes ?? null,
    },
  });
  await db.auditEvent.create({
    data: { actor: 'demo-user', action: 'soil-test.create', targetId: farmId, detail: `source=${b.source}` },
  });
  return jsonResponse({ soilTest: test }, { status: 201, correlationId });
});
