#!/usr/bin/env bash
# Live exercise of BOTH signed digest exits in ONE call (the sandbox reaps
# per-tool-call process groups; setsid + one-shot verification avoids it):
#   1. ensure the v1-verification webhook receiver is listening (setsid)
#   2. ensure the SMTP sink is listening (setsid)
#   3. re-nudge the Zambia demo list → real 60 s scheduler tick claims it
#   4. wait for the run → dump receiver + sink JSONL proof, exit counters,
#      audit ledger rows and webhook provenance rows
set -u
cd /home/z/my-project

port_listening() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3>&- 3<&-; return 0; } || return 1; }
SECRET="$(grep '^DIGEST_WEBHOOK_SECRET=' .env | head -1 | cut -d= -f2-)"
PREV="$(grep '^DIGEST_WEBHOOK_SECRET_PREVIOUS=' .env | head -1 | cut -d= -f2-)"

if port_listening 4317; then echo "== receiver already listening"; else
  setsid nohup env RECEIVER_SECRET="$SECRET" RECEIVER_SECRET_PREVIOUS="$PREV" \
    node scripts/webhook-receiver.mjs 4317 download/hackathon/exits/webhook-deliveries.jsonl 7200000 \
    >> download/hackathon/exits/webhook-receiver.log 2>&1 &
  disown || true
  sleep 1
  echo "== receiver started (setsid)"
fi
if port_listening 2525; then echo "== sink already listening"; else
  setsid nohup node scripts/smtp-sink.mjs 2525 download/hackathon/exits/smtp-deliveries.jsonl 7200000 \
    >> download/hackathon/exits/smtp-sink.log 2>&1 &
  disown || true
  sleep 1
  echo "== sink started (setsid)"
fi

echo "== sanity: direct signed v1 POST"
RECEIVER_SECRET="$SECRET" node scripts/test-signed-post.mjs

echo "== nudge Zambia list due NOW"
bun scripts/nudge-next-run.ts cmwg1ese00000tweulyfrvcsy 360

echo "== waiting for the real scheduler tick (≤60 s) + delivery…"
sleep 80

echo "== WEBHOOK RECEIVER PROOF (newest 3)"
tail -3 download/hackathon/exits/webhook-deliveries.jsonl | python3 -c "
import json,sys
for line in sys.stdin:
    if not line.strip(): continue
    e=json.loads(line)
    print(e['receivedAt'], '| scheme', e['schemeVerified'], '| valid', e['signatureValid'],
          '| sigAge', e['sigAgeSec'], 's | replayRefused', e['replayRefused'], '| bytes', e['rawBytes'])
    print('   corr', (e['summary'] or {}).get('correlationId'), '| trigger', (e['summary'] or {}).get('trigger'),
          '| list', (e['summary'] or {}).get('watchlistName'))
"
echo "== SMTP SINK PROOF (newest 2)"
tail -2 download/hackathon/exits/smtp-deliveries.jsonl | python3 -c "
import json,sys
for line in sys.stdin:
    if not line.strip(): continue
    e=json.loads(line)
    print(e['receivedAt'], '| from', e['smtp']['from'], '| to', e['smtp']['to'], '| bytes', e['smtp']['dataBytes'])
    print('   subject:', e['headers']['subject'])
    print('   msgId:', e['headers']['messageId'])
    print('   body0:', (e['bodyPreview'] or '').splitlines()[0][:90] if e['bodyPreview'] else '')
"
echo "== EXIT COUNTERS (system/status)"
curl -s http://localhost:3000/api/v1/system/status --max-time 60 | python3 -c "
import json,sys
d=json.load(sys.stdin)
w=d['digestChannel']['exits']['webhook']; e=d['digestChannel']['exits']['email']
s=d['scheduler']; lt=s['lastTick']
print('scheduler lastTick:', lt['tickAt'], 'ran', lt['ran'], '/', lt['dueCount'])
for r in lt['runs']: print('   run:', r['name'], 'ok' if r['ok'] else 'FAILED', 'next', r.get('claimedNextAt'))
print('webhook: delivered', w['delivered'], '/ failed', w['failed'], '/ attempts', w['attempts'], '| lastDeliveredAt', w['lastDeliveredAt'], '| lastError', w['lastError'])
print('email: sent', e['sent'], '/ failed', e['failed'], '| lastSentAt', e['lastSentAt'])
"
echo "== AUDIT + PROVENANCE (durable rows)"
bun -e "
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
(async () => {
  const audits = await db.auditEvent.findMany({ where: { actor: { in: ['system:digest-webhook','system:digest-email'] } }, orderBy: { createdAt: 'desc' }, take: 4 });
  console.log('-- digest exit audit rows (newest 4):');
  for (const a of audits) console.log('  ', a.createdAt.toISOString(), a.action, (a.detail||'').slice(0,120));
  const prov = await db.apiRequestLog.findMany({ where: { provider: 'DIGEST_WEBHOOK' }, orderBy: { retrievedAt: 'desc' }, take: 3 });
  console.log('-- provenance rows provider=DIGEST_WEBHOOK (newest 3):');
  for (const p of prov) console.log('  ', p.retrievedAt.toISOString(), p.operation, 'status', p.status, 'ok', p.ok, (p.errorDetail??'').slice(0,60));
  await db.\$disconnect();
})();
"
echo "== DONE"
