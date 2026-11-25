import { z } from 'zod';
import { AccountAccessError } from '@/lib/access-error';
import { apiHandler, jsonResponse, parseBody, withIdempotency } from '@/lib/api/helpers';
import { BILLING_PAYMENT_NOTE, ensureInvoiceForPeriod, listInvoices } from '@/lib/billing/invoices';
import { requirePermission, resolveTenantContext } from '@/lib/tenancy';

/**
 * GET  /api/v1/billing/invoices — list invoices for the active organization or personal account
 * POST /api/v1/billing/invoices — issue the current subscription period's invoice (idempotent)
 */

const listQuerySchema = z.object({
  status: z.enum(['open', 'paid', 'void']).optional(),
});
const createSchema = z.object({});

export const GET = apiHandler(async (req, { correlationId }) => {
  const context = await resolveTenantContext(req);
  if (!context.userId) throw new AccountAccessError(401, 'AUTH_REQUIRED', 'a verified account is required for billing');
  requirePermission(context, 'billing.manage');
  const parsed = listQuerySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams.entries()));
  if (!parsed.success) {
    throw new AccountAccessError(400, 'VALIDATION_ERROR', 'status must be one of open, paid, void');
  }
  const invoices = await listInvoices(context, { status: parsed.data.status });
  return jsonResponse({ invoices, count: invoices.length, paymentNote: BILLING_PAYMENT_NOTE }, { correlationId });
});

export const POST = apiHandler((req, { correlationId }) => withIdempotency(req, '/api/v1/billing/invoices', async (req) => {
  const context = await resolveTenantContext(req);
  requirePermission(context, 'billing.manage');
  const parsed = await parseBody(req, createSchema);
  if (!parsed.ok) return parsed.res;
  const result = await ensureInvoiceForPeriod(context);
  return jsonResponse(
    { invoice: result.invoice, created: result.created, paymentNote: BILLING_PAYMENT_NOTE },
    { status: result.created ? 201 : 200, correlationId },
  );
}));
