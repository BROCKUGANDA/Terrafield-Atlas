import { describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';
import { POST as cspReport } from '@/app/api/v1/csp-report/route';

describe('CSP report-only rollout', () => {
  test('every document response carries a nonce and a report-only policy', () => {
    const response = middleware(new NextRequest('https://terrafield.example.test/'));
    const policy = response.headers.get('content-security-policy-report-only');
    expect(policy).not.toBeNull();
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain('report-uri /api/v1/csp-report');
    const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(policy!)?.[1];
    expect(nonce?.length).toBeGreaterThanOrEqual(20);
    // Enforcing mode stays off until the violation ledger is clean.
    expect(response.headers.get('content-security-policy')).toBeNull();
  });

  test('the nonce differs per request', () => {
    const first = middleware(new NextRequest('https://terrafield.example.test/')).headers.get('content-security-policy-report-only');
    const second = middleware(new NextRequest('https://terrafield.example.test/')).headers.get('content-security-policy-report-only');
    expect(first).not.toBe(second);
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
