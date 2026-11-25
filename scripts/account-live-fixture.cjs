require('@next/env').loadEnvConfig(process.cwd());
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
const email = 'delivered@resend.dev';
const fixtureName = 'TerraField live account validation fixture';
const origin = 'https://terrafieldatlas.us';
const jsonHeaders = { origin, 'content-type': 'application/json' };

async function cleanup() {
  const user = await db.accountUser.findUnique({ where: { email } });
  if (!user || user.name !== fixtureName) return;
  const farms = await db.farm.findMany({ where: { ownerId: user.id }, select: { id: true } });
  const watches = await db.fireWatchlist.findMany({ where: { ownerId: user.id }, select: { id: true } });
  await db.auditEvent.deleteMany({ where: { OR: [{ targetId: { in: [...farms, ...watches].map(record => record.id) } }, { actor: `account:${user.id}` }] } });
  await db.processingJob.deleteMany({ where: { ownerId: user.id } });
  await db.trendAnalysis.deleteMany({ where: { ownerId: user.id } });
  await db.environmentalObservation.deleteMany({ where: { ownerId: user.id } });
  await db.farm.deleteMany({ where: { ownerId: user.id } });
  await db.fireWatchlist.deleteMany({ where: { ownerId: user.id } });
  await db.accountUser.delete({ where: { id: user.id } });
}
(async () => {
  try {
    if (process.argv[2] === 'cleanup') { await cleanup(); return; }
    assert.equal(await db.accountUser.count({ where: { email } }), 0, 'Reserved test account already exists; refusing to alter it');
    const started = Date.now();
    const password = randomBytes(24).toString('base64url');
    const registration = await fetch(`${origin}/api/v1/account/register`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ email, password, name: fixtureName }) });
    assert.equal(registration.status, 202, 'Live registration failed');
    let token;
    for (let attempt = 0; attempt < 10 && !token; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1200));
      const listing = await fetch('https://api.resend.com/emails', { headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}` } });
      assert.equal(listing.status, 200);
      const candidates = (await listing.json()).data || [];
      const match = candidates.find(item => item.subject === 'Verify your TerraField Atlas account' && item.to?.includes(email) && Date.parse(item.created_at) >= started - 1000);
      if (!match) continue;
      const detail = await fetch(`https://api.resend.com/emails/${encodeURIComponent(match.id)}`, { headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}` } });
      const message = await detail.json();
      token = /verifyAccount=([A-Za-z0-9_-]+)/.exec(message.text || '')?.[1];
    }
    assert.ok(token, 'Verification email could not be retrieved from the reserved test recipient');
    const verified = await fetch(`${origin}/api/v1/account/verify`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ token }) });
    assert.equal(verified.status, 200);
    const replay = await fetch(`${origin}/api/v1/account/verify`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ token }) });
    assert.equal(replay.status, 400);
    // Consumed only by the browser runner's captured subprocess output; never log this credential object.
    process.stdout.write(JSON.stringify({ email, password }));
  } catch (error) {
    await cleanup();
    console.error(error.message);
    process.exitCode = 1;
  } finally { await db.$disconnect(); }
})();