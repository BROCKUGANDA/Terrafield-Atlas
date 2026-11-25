#!/usr/bin/env node
// One-shot signed POST against the local webhook receiver — proves the
// timestamped v1 verification (t=,v1=, ±300 s) end-to-end before the app run.
import { createHmac } from 'node:crypto';

const secret = process.env.RECEIVER_SECRET;
if (!secret) { console.error('RECEIVER_SECRET required'); process.exit(1); }
const body = JSON.stringify({
  type: 'digest',
  reason: 'evaluation',
  trigger: 'manual',
  watchlistId: 'sanity-check',
  watchlistName: 'v1 signature sanity probe',
  correlationId: 'sanity-v1-probe',
  digest: { hours: 6, digest: ['sanity: receiver v1 verification'] },
});
const t = Math.floor(Date.now() / 1000);
const v1 = createHmac('sha256', secret).update(`${t}.${body}`, 'utf8').digest('hex');
const res = await fetch('http://127.0.0.1:4317/digest', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-terrafield-topic': 'watchlist.digest',
    'x-terrafield-signature': `t=${t},v1=${v1}`,
  },
  body,
});
console.log('status:', res.status, '| ack:', res.headers.get('x-terrafield-receiver-ack'));
