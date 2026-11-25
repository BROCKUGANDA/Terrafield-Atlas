import { z } from 'zod';
import { apiHandler, clientKey, jsonResponse, rateLimit, rateLimitResponse } from '@/lib/api/helpers';
import { fetchFirmsAreaCsv } from '@/lib/adapters/firms';
import { regionBboxAround } from '@/lib/geo';
import { cacheGet, cacheSet } from '@/lib/cache';

const query = z.object({ lat: z.string().trim().min(1).transform(Number).pipe(z.number().min(-90).max(90)), lon: z.string().trim().min(1).transform(Number).pipe(z.number().min(-180).max(180)) });

export const GET = apiHandler(async (request, { correlationId }) => {
  const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return jsonResponse({ error: { code: 'VALIDATION_ERROR', message: 'Valid lat and lon are required', correlationId } }, { status: 400 });
  const { lat, lon } = parsed.data;
  const key = `firms-recent:${lat.toFixed(2)},${lon.toFixed(2)}`;
  const cached = await cacheGet<Record<string, unknown>>(key);
  if (cached) return jsonResponse(cached);
  const limit = await rateLimit(clientKey(request, 'firms-recent'), { capacity: 6, refillPerMinute: 2 });
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSec, correlationId);
  const bbox = regionBboxAround(lat, lon);
  const result = await fetchFirmsAreaCsv(bbox, 'VIIRS_SNPP_NRT', 1, correlationId);
  const response = {
    ...result, bbox, retrievedAt: new Date().toISOString(), window: 'Provider most recent 24-hour product; observations are not instantaneous',
    note: `${result.note} This recent feed is separate from the historical GIBS ingestion and is not mixed into its archive-coverage statistics.`,
  };
  if (result.served !== 'none') await cacheSet(key, response, 60_000);
  return jsonResponse(response, { status: result.served === 'none' ? 502 : 200 });
});