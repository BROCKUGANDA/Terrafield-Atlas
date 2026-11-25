#!/usr/bin/env bash
# Webhook digest exit — full e2e check in ONE shell invocation.
# (The sandbox reaps background processes between tool calls, so receiver +
# dev server + nudge + verification all happen within this script's lifetime.)
#
# Self-contained: arms DIGEST_WEBHOOK_URL/SECRET in .env for the run and
# restores the previous .env on exit (success OR failure). Requires the demo
# Zambia watchlist id below to exist (the seeded demo list).
set -u
cd /home/z/my-project

WATCHLIST_ID="${1:-cmwg1ese00000tweulyfrvcsy}"
LOG=/tmp/webhook-receiver.jsonl
RECV_OUT=/tmp/receiver-stdout.log
ENV_BACKUP=/tmp/env-backup-webhook-e2e
rm -f "$LOG" "$RECV_OUT"

cp .env "$ENV_BACKUP"
trap 'cp "$ENV_BACKUP" .env; kill $RECV_PID $DEV_PID 2>/dev/null; sleep 2; kill -9 $RECV_PID $DEV_PID 2>/dev/null' EXIT
printf 'DIGEST_WEBHOOK_URL=http://127.0.0.1:4317/digest\nDIGEST_WEBHOOK_SECRET=e2e-demo-secret\n' >> .env

# 1) real receiver on 127.0.0.1:4317 with the matching HMAC secret
RECEIVER_SECRET=e2e-demo-secret node scripts/webhook-receiver.mjs 4317 "$LOG" 900000 >"$RECV_OUT" 2>&1 &
RECV_PID=$!

# 2) dev server (env now carries DIGEST_WEBHOOK_URL/SECRET)
bun run dev > /tmp/dev-e2e.log 2>&1 &
DEV_PID=$!

# 3) wait for HTTP readiness
for i in $(seq 1 45); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/v1/health 2>/dev/null || true)
  [ "$code" = "200" ] && break
  sleep 2
done
echo "== health: $code"
if [ "$code" != "200" ]; then tail -20 /tmp/dev-e2e.log; exit 1; fi

# 4) confirm the exits are surfaced BEFORE anything fires
curl -s http://localhost:3000/api/v1/system/status | python3 -c "
import json,sys
d=json.load(sys.stdin)
w=d['digestChannel']['exits']['webhook']; e=d['digestChannel']['exits']['email']
print('== pre-fire: webhook', w['state'], '→', w['host'], '| secret', w['secretPresent'], '| delivered', w['delivered'])
print('== pre-fire: email', e['state'], '| missing', e['missing'])
"

# 5) arm the watchlist due NOW (the real scheduler claims it on the next 60 s tick)
bun scripts/nudge-next-run.ts "$WATCHLIST_ID" 360

# 6) wait for the tick + push + webhook POST (+ any retry) to land
sleep 80

# 7) receiver log — the POST(s) that actually arrived
echo "== receiver log:"
cat "$LOG"

# 8) server-side facts after the run
curl -s http://localhost:3000/api/v1/system/status | python3 -c "
import json,sys
d=json.load(sys.stdin)
s=d['scheduler']; w=d['digestChannel']['exits']['webhook']; e=d['digestChannel']['exits']['email']
lt=s['lastTick']
print('== scheduler last tick:', lt['tickAt'], 'ran', lt['ran'], '/', lt['dueCount'])
for r in lt['runs']: print('   run:', r['name'], 'ok' if r['ok'] else 'FAILED', r.get('status'), 'next', r.get('claimedNextAt'))
print('== webhook exit post-fire: delivered', w['delivered'], '| failed', w['failed'], '| attempts', w['attempts'], '| lastDeliveredAt', w['lastDeliveredAt'], '| lastError', w['lastError'])
print('== email exit post-fire: state', e['state'], '| sent', e['sent'])
"

# 9) durable records: audit ledger + provenance rows
bun -e "
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
(async () => {
  const audits = await db.auditEvent.findMany({ where: { actor: { in: ['system:digest-webhook','system:digest-email'] } }, orderBy: { createdAt: 'desc' }, take: 4 });
  console.log('== digest exit audit rows (newest 4):');
  for (const a of audits) console.log('  ', a.createdAt.toISOString(), a.action, (a.detail||'').slice(0,150));
  const prov = await db.apiRequestLog.findMany({ where: { provider: 'DIGEST_WEBHOOK' }, orderBy: { retrievedAt: 'desc' }, take: 3 });
  console.log('== provenance rows (provider DIGEST_WEBHOOK, newest 3):');
  for (const p of prov) console.log('  ', p.retrievedAt.toISOString(), p.operation, 'status', p.status, p.ok, (p.errorDetail??'').slice(0,80));
  await db.\$disconnect();
})();
"

echo "== receiver stdout tail:"; tail -3 "$RECV_OUT"
echo "== done (.env restored, receiver + dev server stopped)"
