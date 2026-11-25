import { apiHandler, jsonResponse } from '@/lib/api/helpers';
import { getOnchainIntent } from '@/lib/onchain';
import { requirePermission, resolveTenantContext } from '@/lib/tenancy';

type IntentCtx = { params: Promise<{ id: string }> };

/**
 * GET /api/v1/billing/onchain/intents/:id
 *
 * Read one intent within the caller's organization or personal scope.
 */
export const GET = apiHandler<IntentCtx>(async (req, { correlationId, params }) => {
  const { id } = await params;
  const context = await resolveTenantContext(req);
  requirePermission(context, 'billing.manage');
  const intent = await getOnchainIntent(context, id);
  return jsonResponse({ intent }, { correlationId });
});
