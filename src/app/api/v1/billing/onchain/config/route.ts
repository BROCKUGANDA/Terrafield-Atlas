import { apiHandler, jsonResponse } from '@/lib/api/helpers';
import { publicOnchainConfig, readOnchainConfig } from '@/lib/onchain';

/**
 * GET /api/v1/billing/onchain/config
 *
 * Public capability + recipient configuration for the support card. Returns
 * 200 with `enabled: false` when the deployment has not configured onchain
 * support; the RPC URL is never included.
 */
export const GET = apiHandler(async (_req, { correlationId }) => {
  return jsonResponse(publicOnchainConfig(readOnchainConfig()), { correlationId });
});
