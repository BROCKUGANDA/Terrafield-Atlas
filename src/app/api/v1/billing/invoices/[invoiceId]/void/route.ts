import { z } from 'zod';
import { apiHandler, jsonResponse, parseBody, withIdempotency } from '@/lib/api/helpers';
import { voidInvoice } from '@/lib/billing/invoices';
import { requirePermission, resolveTenantContext } from '@/lib/tenancy';

type InvoiceCtx = { params: Promise<{ invoiceId: string }> };

/** POST /api/v1/billing/invoices/:invoiceId/void — void an unpaid invoice */
const voidSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export const POST = apiHandler<InvoiceCtx>(async (req, { correlationId, params }) => {
  const { invoiceId } = await params;
  return withIdempotency(req, req.nextUrl.pathname, async (req) => {
    const context = await resolveTenantContext(req);
    requirePermission(context, 'billing.manage');
    const parsed = await parseBody(req, voidSchema);
    if (!parsed.ok) return parsed.res;
    const invoice = await voidInvoice(context, invoiceId, parsed.data);
    return jsonResponse({ invoice }, { correlationId });
  });
});
