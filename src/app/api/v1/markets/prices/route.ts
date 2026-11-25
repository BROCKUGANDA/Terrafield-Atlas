import { z } from 'zod';
import {
  apiHandler, clientKey, errorResponse, isoDateSchema, jsonResponse,
  rateLimit, rateLimitResponse,
} from '@/lib/api/helpers';
import { queryMarketPrices } from '@/lib/markets';

/**
 * GET /api/v1/markets/prices
 *
 * Read-only HDX/WFP Uganda market prices. Returns coverage (available
 * commodities/markets), the monthly median/min/max series for the selected
 * commodity + optional market, and provenance for the stored feed.
 *
 * No provider call happens here: a read either serves stored observations or
 * reports that none are stored. The ingest route is the only writer.
 */

const querySchema = z.object({
  commodityId: z.string().trim().min(1).max(64).optional(),
  marketId: z.string().trim().min(1).max(64).optional(),
  unit: z.string().trim().min(1).max(32).optional(),
  currency: z.string().trim().min(1).max(8).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
}).refine((value) => !value.from || !value.to || value.from <= value.to, {
  message: 'from must be on or before to',
  path: ['from'],
});

export const GET = apiHandler(async (req, { correlationId }) => {
  const rl = await rateLimit(clientKey(req, 'markets:prices'), { capacity: 120, refillPerMinute: 120 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);

  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams.entries()));
  if (!parsed.success) {
    return errorResponse(400, 'VALIDATION_ERROR', 'query parameters failed validation', correlationId, parsed.error.issues);
  }

  const result = await queryMarketPrices(parsed.data);
  return jsonResponse(result, { correlationId });
});
