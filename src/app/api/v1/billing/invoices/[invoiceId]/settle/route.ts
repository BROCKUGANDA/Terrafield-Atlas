import { z } from 'zod';
import { apiHandler, errorResponse, jsonResponse, parseBody, withIdempotency } from '@/lib/api/helpers';
import { BILLING_PAYMENT_NOTE, settleInvoice } from '@/lib/billing/invoices';
import { requirePermission, resolveTenantContext } from '@/lib/tenancy';

type InvoiceCtx = { params: Promise<{ invoiceId: string }> };

/** POST /api/v1/billing/invoices/:invoiceId/settle — record a manual settlement */
const settleSchema = z.object({
  amountMinor: z.number().int().nonnegative().optional(),
  method: z.enum(['manual_bank', 'manual_cash', 'provider']),
  reference: z.string().trim().min(1).max(200).optional(),
});

export const POST = apiHandler<InvoiceCtx>(async (req, { correlationId, params }) => {
  const { invoiceId } = await params;
  return withIdempotency(req, req.nextUrl.pathname, async (req) => {
    const context = await resolveTenantContext(req);
    requirePermission(context, 'billing.manage');
    const parsed = await parseBody(req, settleSchema);
    if (!parsed.ok) return parsed.res;
    // A tenant manager cannot attest their own bank transfer. Customer-visible
    // settlement is the verified onchain path; manual methods are an operator
    // record after an off-platform payment.
    if (!context.isPlatformAdmin) {
      return errorResponse(403, 'MANUAL_SETTLEMENT_ADMIN_ONLY', 'manual settlement is recorded by a platform administrator', correlationId);
    }
    const result = await settleInvoice(context, invoiceId, parsed.data);
    return jsonResponse({ ...result, paymentNote: BILLING_PAYMENT_NOTE }, { correlationId });
  });
});
