import { z } from 'zod';
import { apiHandler, clientKey, isoDateSchema, jsonResponse, rateLimit, rateLimitResponse } from '@/lib/api/helpers';
import { searchStac, stacGeometrySchema } from '@/lib/adapters/stac';
import { requireFeature } from '@/lib/feature-flags';

const querySchema = z.object({
  geometry: z.string().max(20_000).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  collections: z.string().max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  checkAssets: z.enum(['0', '1']).optional(),
}).refine((value) => !value.from || !value.to || value.from <= value.to);

export const GET = apiHandler(async (req, { correlationId }) => {
  await requireFeature('stac.enabled');
  const rl = await rateLimit(clientKey(req, 'stac:search'), { capacity: 30, refillPerMinute: 10 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams.entries()));
  if (!parsed.success) return jsonResponse({ error: { code: 'VALIDATION_ERROR', message: 'invalid STAC search parameters', details: parsed.error.issues, correlationId } }, { status: 400, correlationId });
  let geometry: z.infer<typeof stacGeometrySchema> | undefined;
  if (parsed.data.geometry) {
    try {
      const raw: unknown = JSON.parse(parsed.data.geometry);
      const geo = stacGeometrySchema.safeParse(raw);
      if (!geo.success) throw new Error('invalid geometry');
      geometry = geo.data;
    } catch {
      return jsonResponse({ error: { code: 'INVALID_GEOMETRY', message: 'geometry must be a bounded Polygon or MultiPolygon GeoJSON object', correlationId } }, { status: 400, correlationId });
    }
  }
  try {
    const result = await searchStac({
      geometry,
      from: parsed.data.from,
      to: parsed.data.to,
      collections: parsed.data.collections?.split(',').map((value) => value.trim()).filter(Boolean),
      limit: parsed.data.limit,
      checkAssets: parsed.data.checkAssets === '1',
      correlationId,
    });
    return jsonResponse(result, { correlationId });
  } catch (error) {
    return jsonResponse({ error: { code: 'STAC_UNAVAILABLE', message: error instanceof Error ? error.message : 'STAC search failed', correlationId } }, { status: 502, correlationId });
  }
});
