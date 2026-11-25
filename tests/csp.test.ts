import { describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';
import { POST as cspReport } from '@/app/api/v1/csp-report/route';

describe('CSP enforcement', () => {
  test('every document response carries an enforced policy with a report sink', () => {
    const response = middleware();
    const policy = response.headers.get('content-security-policy');
    expect(policy).not.toBeNull();
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("worker-src 'self' blob:");
    expect(policy).toContain('report-uri /api/v1/csp-report');
    // Static pages cannot carry a per-request nonce; inline scripts stay
    // allowed and that residual risk is documented in LIMITATIONS.
    expect(policy).toContain("script-src 'self' 'unsafe-inline'");
    expect(response.headers.get('content-security-policy-report-only')).toBeNull();
  });

  test('violation reports are bounded, validated and never echoed', async () => {
    const report = new NextRequest('https://terrafield.example.test/api/v1/csp-report', {
      method: 'POST',
      headers: { 'content-type': 'application/csp-report' },
      body: JSON.stringify({ 'csp-report': { 'document-uri': 'https://terrafield.example.test/', 'effective-directive': 'script-src' } }),
    });
    const response = await cspReport(report);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');

    const malformed = new NextRequest('https://terrafield.example.test/api/v1/csp-report', { method: 'POST', body: 'not json' });
    expect((await cspReport(malformed)).status).toBe(400);

    const oversized = new NextRequest('https://terrafield.example.test/api/v1/csp-report', { method: 'POST', body: 'x'.repeat(9 * 1024) });
    expect((await cspReport(oversized)).status).toBe(413);
  });
});
