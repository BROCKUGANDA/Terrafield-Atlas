import {
  apiHandler, errorResponse, jsonResponse, rateLimit, rateLimitResponse,
} from '@/lib/api/helpers';
import { requireVerifiedWriter } from '@/lib/account-access';
import { requirePermission, resolveTenantContext } from '@/lib/tenancy';
import { MarketFeedError } from '@/lib/adapters/marketPrices';
import { ProviderUnavailableError } from '@/lib/http';
import { ingestMarketPrices } from '@/lib/markets';

/**
 * POST /api/v1/markets/ingest
 *
 * Downloads the latest HDX/WFP Uganda food-price CSV and stores it with a
 * natural-key upsert. Runs synchronously under a 60 s deadline: a slow provider
 * returns 503 instead of holding the request open, and the MarketIngestion row
 * records the failure. No price is ever synthesized when the feed fails.
 */

const INGEST_DEADLINE_MS = 60_000;

class MarketIngestDeadlineError extends Error {
  constructor() {
    super('market ingestion deadline exceeded');
    this.name = 'MarketIngestDeadlineError';
  }
}

export const maxDuration = 60;

export const POST = apiHandler(async (req, { correlationId }) => {
  const userId = await requireVerifiedWriter(req);
  const rl = await rateLimit(`${userId}:markets:ingest`, { capacity: 2, refillPerMinute: 1 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);

  const context = await resolveTenantContext(req);
  requirePermission(context, 'analysis.run');

  const controller = new AbortController();
  let timedOut = false;
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    deadline.reject(new MarketIngestDeadlineError());
  }, INGEST_DEADLINE_MS);

  try {
    const result = await Promise.race([
      ingestMarketPrices({ signal: controller.signal, correlationId }),
      deadline.promise,
    ]);
    return jsonResponse({
      ingestion: result.ingestion,
      counts: result.counts,
      dataset: result.dataset,
      resource: result.resource,
      window: result.window,
      retrievedAt: result.retrievedAt,
      note: 'Stored from the latest HDX/WFP Uganda CSV resource. Existing natural-key rows were left unchanged; zero accepted rows means the provider returned no eligible observations.',
    }, { correlationId });
  } catch (error) {
    if (timedOut || error instanceof MarketIngestDeadlineError) {
      return errorResponse(503, 'MARKET_INGEST_TIMEOUT',
        `market ingestion exceeded the ${INGEST_DEADLINE_MS / 1000}s deadline; no partial rows were published — verify the ingestion ledger before retrying`,
        correlationId);
    }
    if (error instanceof MarketFeedError) {
      return errorResponse(502, 'MARKET_FEED_FAILED', error.message, correlationId);
    }
    if (error instanceof ProviderUnavailableError) {
      return errorResponse(503, 'MARKET_FEED_UNAVAILABLE', error.message, correlationId);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
});
