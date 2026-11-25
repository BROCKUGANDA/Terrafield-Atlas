import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encode } from 'next-auth/jwt';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { ensureSeeded } from '@/lib/seeds';
import { POST as createFarm } from '@/app/api/v1/farms/route';
import { GET as getFarm, PATCH as updateFarm } from '@/app/api/v1/farms/[farmId]/route';
import { POST as soilTest } from '@/app/api/v1/farms/[farmId]/soil-tests/route';
import { POST as scenario } from '@/app/api/v1/rotation/scenarios/route';
import { POST as report } from '@/app/api/v1/reports/route';

process.env.NEXTAUTH_SECRET = randomBytes(48).toString('hex');
process.env.NEXTAUTH_URL = 'http://localhost';
let cookie = '';
let userId: string | undefined;
const request = (path: string, method: string, body?: unknown) => new NextRequest(`http://localhost${path}`, {
  method, headers: { 'content-type': 'application/json', origin: 'http://localhost', cookie, ...(method === 'GET' ? {} : { 'idempotency-key': `workflow-${crypto.randomUUID()}` }) }, body: body === undefined ? undefined : JSON.stringify(body),
});
let farmId: string | undefined;
let scenarioId: string | undefined;
try {
  const user = await db.accountUser.create({ data: { email: `workflow-${Date.now()}@example.test`, emailVerified: new Date() } });
  userId = user.id;
  cookie = `next-auth.session-token=${await encode({ token: { sub: user.id }, secret: process.env.NEXTAUTH_SECRET })}`;
  await Promise.all(Array.from({ length: 8 }, () => ensureSeeded()));
  console.log('PASS concurrent catalogue initialization');
  const created = await createFarm(request('/api/v1/farms', 'POST', {
    name: `Validation fixture ${Date.now()}`, centroidLat: -0.28, centroidLon: 36.07,
    notes: 'Automated integration fixture, removed after validation.',
  }), { params: Promise.resolve({}) });
  assert.equal(created.status, 201);
  farmId = (await created.json()).farm.id;
  assert.ok(farmId);
  const ctx = { params: Promise.resolve({ farmId }) };
  assert.equal((await getFarm(request(`/api/v1/farms/${farmId}`, 'GET'), ctx)).status, 200);
  assert.equal((await updateFarm(request(`/api/v1/farms/${farmId}`, 'PATCH', { cropHistory: [{ season: '2025', crop: 'maize' }] }), ctx)).status, 200);
  const soilPath = `/api/v1/farms/${farmId}/soil-tests`;
  assert.equal((await soilTest(request(soilPath, 'POST', { measuredAt: '2026-11-18', source: 'laboratory', ph: 6.5, nitrogenMgKg: 0 }), ctx)).status, 201);
  assert.equal((await soilTest(request(soilPath, 'POST', { measuredAt: '2026-11-18', source: 'laboratory', sandPct: 90, clayPct: 90 }), ctx)).status, 400);
  console.log('PASS farm create/read/update, measured soil persistence and invalid fractions');
  const result = await scenario(request('/api/v1/rotation/scenarios', 'POST', { farmId, name: 'Validation maize-bean', cropKeys: ['maize', 'common_bean'] }), { params: Promise.resolve({}) });
  assert.equal(result.status, 201, await result.clone().text());
  scenarioId = (await result.json()).scenarioId;
  assert.ok(scenarioId);
  const compiled = await report(request('/api/v1/reports', 'POST', { farmId }), { params: Promise.resolve({}) });
  assert.equal(compiled.status, 200, await compiled.clone().text());
  const data = await compiled.json();
  assert.equal(data.soilInformation.measured.ph, 6.5);
  assert.equal(data.soilInformation.measured.nitrogenMgKg, 0);
  assert.equal(data.rotationScenarios.length, 1);
  assert.ok(data.methodology.honestyRules.length);
  console.log('PASS rotation defaults/persistence and evidence-based report composition');
} finally {
  if (farmId) {
    await db.auditEvent.deleteMany({ where: { targetId: { in: [farmId, ...(scenarioId ? [scenarioId] : [])] } } });
    await db.farm.delete({ where: { id: farmId } });
  }
  if (userId) await db.accountUser.delete({ where: { id: userId } });
  await db.$disconnect();
}