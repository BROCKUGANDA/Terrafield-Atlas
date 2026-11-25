import { z } from 'zod';
import { db } from '@/lib/db';
import {
  apiHandler, clientKey, decodeCursor, encodeCursor, errorResponse, isoDateSchema,
  jsonResponse, paginationSchema, parseBody, rateLimit, rateLimitResponse,
  withIdempotency, writeMutationEffects,
} from '@/lib/api/helpers';

/**
 * GET  /api/v1/farms/{farmId}/soil-tests
 * POST /api/v1/farms/{farmId}/soil-tests — farmer or laboratory soil measurement
 */

const postSchema = z.object({
  measuredAt: z.string().datetime().or(isoDateSchema),
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
  const query = paginationSchema(100, 50).parse(Object.fromEntries(new URL(req.url).searchParams.entries()));
  const tests = await db.soilTest.findMany({
    where: { farmId },
    orderBy: [{ source: 'asc' }, { measuredAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: decodeCursor(query.cursor) }, skip: 1 } : {}),
  });
  const page = tests.slice(0, query.limit);
  const nextCursor = tests.length > query.limit ? encodeCursor(page[page.length - 1].id) : null;
  return jsonResponse({ soilTests: page, nextCursor }, { correlationId });
});

export const POST = apiHandler<FarmCtx>((req, { correlationId, params }) => withIdempotency(req, `/api/v1/farms/${req.nextUrl.pathname.split('/')[4]}/soil-tests`, async (req, { userId }) => {
  const { farmId } = await params;
  const rl = await rateLimit(clientKey(req, 'soil-tests:create'), { capacity: 20, refillPerMinute: 10 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);
  const farm = await db.farm.findUnique({ where: { id: farmId } });
  if (!farm) return errorResponse(404, 'NOT_FOUND', `farm ${farmId} not found`, correlationId);
  const parsed = await parseBody(req, postSchema);
  if (!parsed.ok) return parsed.res;
  const b = parsed.data;

  const frac = (b.sandPct ?? 0) + (b.siltPct ?? 0) + (b.clayPct ?? 0);
  if (frac > 100) {
    return errorResponse(400, 'VALIDATION_ERROR', 'sand + silt + clay percentages exceed 100%', correlationId);
  }

  return {
    commit: async (tx) => {
      const test = await tx.soilTest.create({
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
      await writeMutationEffects(tx, {
        actor: `account:${userId}`,
        action: 'soil-test.create',
        targetId: test.id,
        detail: `source=${b.source}`,
        aggregateType: 'SoilTest',
        aggregateId: test.id,
        eventType: 'soil-test.created',
        payload: { soilTestId: test.id, farmId, ownerId: userId },
      });
      return jsonResponse({ soilTest: test }, { status: 201, correlationId });
    },
  };
}));
