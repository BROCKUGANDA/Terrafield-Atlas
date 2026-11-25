import { z } from 'zod';
import { apiHandler, jsonResponse, parseBody, withIdempotency } from '@/lib/api/helpers';
import { enforceOnchainRateLimit, verifyOnchainIntent } from '@/lib/onchain';
import { requirePermission, resolveTenantContext } from '@/lib/tenancy';

type IntentCtx = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/billing/onchain/intents/:id/verify
 *
 * Verify a public-chain transaction against the intent. Verification requires
 * a successful receipt, the exact configured chain/token/recipient/amount, and
 * the configured confirmation depth. The unique txHash/intent constraints make
 * concurrent verification yield exactly one recorded payment.
 */
const verifySchema = z.object({
  txHash: z.string().trim().regex(/^0x[0-9a-fA-F]{64}$/, 'txHash must be a 0x-prefixed 32-byte hash'),
});

export const POST = apiHandler<IntentCtx>(async (req, { correlationId, params }) => {
  const { id } = await params;
  return withIdempotency(req, req.nextUrl.pathname, async (req) => {
    const context = await resolveTenantContext(req);
    requirePermission(context, 'billing.manage');
    const parsed = await parseBody(req, verifySchema);
    if (!parsed.ok) return parsed.res;
    await enforceOnchainRateLimit(context, 'verify');
    const result = await verifyOnchainIntent(context, id, parsed.data.txHash);
    return jsonResponse(result, { correlationId });
  });
});
