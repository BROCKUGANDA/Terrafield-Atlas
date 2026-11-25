import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, errorResponse } from '@/lib/api/helpers';
import { canReadResource, resolveTenantContext } from '@/lib/tenancy';

type ReportCtx = { params: Promise<{ id: string }> };

function csvCell(value: unknown): string {
  const raw = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  // Neutralize spreadsheet formula injection before quoting.
  const text = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export const GET = apiHandler<ReportCtx>(async (req, { correlationId, params }) => {
  const { id } = await params;
  const context = await resolveTenantContext(req);
  const record = await db.reportRecord.findUnique({ where: { id } });
  if (!record || !context.userId || !canReadResource(context, record)) return errorResponse(404, 'NOT_FOUND', 'report not found', correlationId);
  const report = JSON.parse(record.contentJson) as {
    farm: Record<string, unknown>;
    environmentalRecord: Record<string, unknown>;
    trendAnalyses: Record<string, unknown>[];
    soilInformation: Record<string, unknown>;
    rotationScenarios: Record<string, unknown>[];
    limitations: string[];
    generatedAt: string;
  };
  const rows: unknown[][] = [['section', 'item', 'value', 'unit_or_period']];
  for (const [key, value] of Object.entries(report.farm)) rows.push(['farm', key, value, '']);
  for (const [key, value] of Object.entries(report.environmentalRecord)) rows.push(['environment', key, value, '']);
  for (const trend of report.trendAnalyses) rows.push(['trend', trend.variable, JSON.stringify(trend), trend.unit]);
  for (const [key, value] of Object.entries(report.soilInformation)) rows.push(['soil', key, value, '']);
  for (const scenario of report.rotationScenarios) rows.push(['rotation', scenario.name, JSON.stringify(scenario), scenario.ruleVersion]);
  for (const limitation of report.limitations) rows.push(['limitation', 'note', limitation, '']);
  rows.push(['provenance', 'generatedAt', report.generatedAt, '']);
  const csv = rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="terrafield-report-${id}.csv"`,
      'Cache-Control': 'private, no-store',
      'X-Correlation-Id': correlationId,
    },
  });
});
