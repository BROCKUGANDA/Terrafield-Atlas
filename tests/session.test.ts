import { expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { GET, POST, DELETE } from '@/app/api/v1/session/route';

const origin = 'https://terrafieldatlas.us';
const request = (method: string, cookie?: string, source = origin) => new NextRequest(`${origin}/api/v1/session`, {
  method, headers: { origin: source, ...(cookie ? { cookie } : {}) },
});

test('anonymous sessions are signed, HttpOnly, expiring, non-cacheable and not authentication', async () => {
  const res = await POST(request('POST'));
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toContain('no-store');
  const cookie = res.headers.get('set-cookie')!;
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toContain('SameSite=strict');
  const data = await res.json();
  expect(data.authenticated).toBe(false);
  expect(data.expiresAt).toBeGreaterThan(Date.now());
  expect(data.expiresAt).toBeLessThanOrEqual(Date.now() + 8 * 60 * 60 * 1000);
  expect((await (await GET(request('GET', cookie))).json()).expiresAt).toBe(data.expiresAt);
  const renewed = await POST(request('POST', cookie));
  expect((await renewed.json()).expiresAt).toBe(data.expiresAt);
});

test('tampered and absent cookies are rejected; cross-origin mutations are forbidden', async () => {
  const res = await POST(request('POST'));
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  const tampered = `${cookie.slice(0, -1)}${cookie.endsWith('0') ? '1' : '0'}`;
  expect((await (await GET(request('GET', tampered))).json()).expiresAt).toBeNull();
  expect((await (await GET(request('GET'))).json()).expiresAt).toBeNull();
  expect((await POST(request('POST', cookie, 'https://evil.example'))).status).toBe(403);
  expect((await DELETE(request('DELETE', cookie, 'https://evil.example'))).status).toBe(403);
  const ended = await DELETE(request('DELETE', cookie));
  expect(ended.headers.get('set-cookie')).toContain('Max-Age=0');
});

test('public HTTPS origin works behind an internal HTTP reverse proxy', async () => {
  const req = new NextRequest('http://localhost:3000/api/v1/session', { method: 'POST', headers: { origin } });
  expect((await POST(req)).status).toBe(200);
});