import { NextRequest } from 'next/server';
import { getCorrelationId } from '@/lib/correlation';
import { readBoundedText } from '@/lib/account-security';

export const runtime = 'nodejs';

const MAX_REPORT_BYTES = 8 * 1024;

/**
 * POST /api/v1/csp-report
 *
 * Browsers POST `application/csp-report` (legacy shape) or
 * `application/reports+json` (Reporting API) here. Reports are untrusted input:
 * this endpoint bounds the body, extracts only the fields the policy review
 * needs, and writes one structured line per report to the process log. It never
 * stores arbitrary report JSON and never echoes it back.
 */
export async function POST(req: NextRequest) {
  const correlationId = getCorrelationId(req.headers.get('x-correlation-id'));
  let text: string;
  try {
    text = await readBoundedText(req, MAX_REPORT_BYTES);
  } catch {
    return new Response(null, { status: 413 });
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    for (const entry of entries.slice(0, 10)) {
      const record = entry as {
        'csp-report'?: Record<string, unknown>;
        body?: Record<string, unknown>;
        type?: unknown;
      };
      const report = record['csp-report'] ?? record.body ?? record;
      const field = (name: string) => {
        const value = (report as Record<string, unknown>)[name];
        return typeof value === 'string' ? value.slice(0, 200) : undefined;
      };
      console.warn(JSON.stringify({
        level: 'warn',
        message: 'csp violation reported',
        correlationId,
        documentUri: field('document-uri') ?? field('documentURL'),
        directive: field('effective-directive') ?? field('effectiveDirective'),
        blockedUri: field('blocked-uri') ?? field('blockedURL'),
        sourceFile: field('source-file') ?? field('sourceFile'),
        line: field('line-number') ?? field('lineNumber'),
      }));
    }
  } catch {
    return new Response(null, { status: 400 });
  }
  return new Response(null, { status: 204 });
}
