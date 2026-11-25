import { z } from 'zod';
import { apiHandler, jsonResponse, parseBody, withIdempotency } from '@/lib/api/helpers';
import { ONCHAIN_MAX_AMOUNT_MINOR, ONCHAIN_MIN_AMOUNT_MINOR, createOnchainIntent, enforceOnchainRateLimit } from '@/lib/onchain';
import { requirePermission, resolveTenantContext } from '@/lib/tenancy';

/**
 * POST /api/v1/billing/onchain/intents
 *
 * Create a 30-minute voluntary support intent. A support payment never changes
 * entitlements; the intent only fixes chain, token, treasury, amount, and memo.
 */
const createSchema = z.object({
  amountMinor: z.number().int().min(ONCHAIN_MIN_AMOUNT_MINOR).max(ONCHAIN_MAX_AMOUNT_MINOR),
  invoiceId: z.string().trim().min(1).max(200).optional(),
});

export const POST = apiHandler((req, { correlationId }) => withIdempotency(req, '/api/v1/billing/onchain/intents', async (req) => {
  const context = await resolveTenantContext(req);
  requirePermission(context, 'billing.manage');
  const parsed = await parseBody(req, createSchema);
  if (!parsed.ok) return parsed.res;
  await enforceOnchainRateLimit(context, 'intent');
  const intent = await createOnchainIntent(context, parsed.data);
  return jsonResponse({ intent }, { status: 201, correlationId });
}));
