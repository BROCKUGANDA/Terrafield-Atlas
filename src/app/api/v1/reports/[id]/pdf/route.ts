import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, errorResponse } from '@/lib/api/helpers';
import { canReadResource, resolveTenantContext } from '@/lib/tenancy';
import { createReportPdf, type PdfReportInput } from '@/lib/pdf/report';

type ReportCtx = { params: Promise<{ id: string }> };

export const runtime = 'nodejs';

export const GET = apiHandler<ReportCtx>(async (req, { correlationId, params }) => {
  const { id } = await params;
  const context = await resolveTenantContext(req);
  const record = await db.reportRecord.findUnique({ where: { id } });
  if (!record || !context.userId || !canReadResource(context, record)) return errorResponse(404, 'NOT_FOUND', 'report not found', correlationId);
  let report: PdfReportInput;
  try { report = JSON.parse(record.contentJson) as PdfReportInput; } catch {
    return errorResponse(500, 'REPORT_PAYLOAD_INVALID', 'stored report payload is invalid', correlationId);
  }
  try {
    const pdf = await createReportPdf(report);
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="terrafield-report-${id}.pdf"`,
        'Content-Length': String(pdf.byteLength),
        'Cache-Control': 'private, no-store',
        'X-Correlation-Id': correlationId,
      },
    });
  } catch {
    return errorResponse(500, 'PDF_GENERATION_FAILED', 'report PDF could not be generated', correlationId);
  }
});
