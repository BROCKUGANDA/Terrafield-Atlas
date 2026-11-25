#!/usr/bin/env bash
# E2E verification of the SCHEDULED re-evaluation → pushed digest chain.
# Boots the server, subscribes a stream client, arms a watchlist cadence slot
# to be due now (Prisma write), and waits for the REAL 60 s scheduler tick to
# claim + run it — proving the digest is pushed with trigger=scheduled.
set -u
cd /home/z/my-project

bun run dev > /dev/null 2>&1 &
SERVER_PID=$!
for i in $(seq 1 120); do
  body=$(curl -s -m 5 http://127.0.0.1:3000/api/v1/health 2>/dev/null)
  if echo "$body" | head -c 1 | grep -q '{'; then echo "[boot] health OK after ${i}s"; break; fi
  sleep 1
done

curl -s -m 60 http://127.0.0.1:3000/api/v1/fires/watchlists -o /tmp/wl.json
WL=$(python3 -c "import json; d=json.load(open('/tmp/wl.json')); print(d['watchlists'][0]['id'], end='')")
NAME=$(python3 -c "import json; d=json.load(open('/tmp/wl.json')); print(d['watchlists'][0]['name'])")
echo "[watchlist] $NAME ($WL)"

# subscribe BEFORE arming so nothing is missed
rm -f /tmp/stream2.txt
curl -sN -m 240 http://127.0.0.1:3000/api/v1/fires/watchlists/digest-stream -o /tmp/stream2.txt 2>/dev/null &
STREAM_PID=$!
sleep 3

# arm the cadence slot to be due now — then the REAL scheduler runs it
bun scripts/nudge-next-run.ts "$WL" 360

# wait for the tick (<=60 s) + run + push
for i in $(seq 1 100); do
  if grep -q "event: watchlist.digest" /tmp/stream2.txt 2>/dev/null; then echo "[push] digest frame arrived after ~${i}s of waiting"; break; fi
  sleep 2
done

echo "== scheduler audit ledger (runs endpoint) =="
curl -s -m 60 "http://127.0.0.1:3000/api/v1/fires/watchlists/$WL/runs" -o /tmp/runs.json
python3 - <<'EOF'
import json
d = json.load(open('/tmp/runs.json'))
print('counts:', d['counts'])
for r in d['runs'][:3]:
    print(f"  {r['at']} {r['kind']} status={r['status']} count={r['detectionCount']} corr={r['correlationId']} claimedNext={r['claimedNextAt']}")
EOF

echo "== pushed scheduled digest =="
python3 - <<'EOF'
import json, re
raw = open('/tmp/stream2.txt').read()
m = re.search(r'^data: (\{"type":"digest".*)$', raw, re.M)
if not m:
    print('NO PUSH FRAME — stream tail:'); print(raw[-500:]); raise SystemExit
p = json.loads(m.group(1))
dg = p['digest']
print('  reason:', p['reason'], '| trigger:', p['trigger'], '| correlationId:', p['correlationId'])
print('  watchlist:', p['watchlistName'])
print('  window source:', dg['windowSource'], '| hours:', dg['hours'], '| cadenceMin:', dg['cadenceMin'])
print('  last in window:', dg['current']['last'])
for line in dg['digest'][:6]:
    print('   |', line)
EOF

kill $STREAM_PID 2>/dev/null
kill $SERVER_PID 2>/dev/null
pkill -f "next dev" 2>/dev/null
pkill -f next-server 2>/dev/null
echo "== done =="
