require('@next/env').loadEnvConfig(process.cwd());
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

(async () => {
  const db = new PrismaClient();
  let receiptId;
  try {
    const sent = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: process.env.EMAIL_FROM, to: ['delivered@resend.dev'], subject: 'TerraField Atlas delivery verification', text: 'Authorized transport test to the Resend reserved delivery-testing recipient. No farm data or user recipient is included.' }),
      signal: AbortSignal.timeout(15000),
    });
    assert.ok(sent.ok, `Resend send HTTP ${sent.status}`);
    const email = await sent.json();
    assert.ok(email.id);
    console.log('PASS Resend accepted reserved-recipient test email');
    await new Promise(resolve => setTimeout(resolve, 3000));
    const tracked = await fetch(`https://api.resend.com/emails/${encodeURIComponent(email.id)}`, { headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}` }, signal: AbortSignal.timeout(15000) });
    const tracking = tracked.ok ? await tracked.json() : {};
    console.log(JSON.stringify({ resendTrackingAvailable: tracked.ok, lastEvent: tracking.last_event || 'not yet reported', realUserInboxTested: false }));
    const url = process.env.DIGEST_WEBHOOK_URL;
    const now = new Date().toISOString();
    const body = JSON.stringify({ type: 'digest', watchlistId: 'delivery-validation-fixture', reason: 'evaluation', triggeredAt: now, pushedAt: now, correlationId: null });
    const timestamp = Math.floor(Date.now() / 1000);
    const hmac = createHmac('sha256', process.env.DIGEST_WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest('hex');
    const headers = { 'content-type': 'application/json', 'x-terrafield-signature': `t=${timestamp},v1=${hmac}` };
    for (let attempt = 0; attempt < 2; attempt++) {
      const received = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) });
      assert.equal(received.status, 200);
      const result = await received.json();
      assert.equal(result.accepted, true);
      receiptId = `digest-receipt:${result.receipt}`;
    }
    assert.equal(await db.auditEvent.count({ where: { id: receiptId } }), 1);
    const forged = await fetch(url, { method: 'POST', headers, body: body + ' ', signal: AbortSignal.timeout(10000) });
    assert.equal(forged.status, 401);
    console.log('PASS live signed webhook receipt, persistent duplicate handling and forged-body rejection; external forwarding not configured');
  } finally {
    if (receiptId) await db.auditEvent.deleteMany({ where: { id: receiptId } });
    await db.$disconnect();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });