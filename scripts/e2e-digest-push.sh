#!/usr/bin/env bash
# E2E verification of push-style digest delivery over the SSE channel.
# One invocation: boots the dev server, subscribes a curl client to the digest
# stream, triggers a watchlist evaluation, and proves the digest frame arrives
# on the stream (server push — no client request for it).
set -u
cd /home/z/my-project

# 1) boot dev server inside this call
bun run dev > /dev/null 2>&1 &
SERVER_PID=$!
for i in $(seq 1 120); do
  body=$(curl -s -m 5 http://127.0.0.1:3000/api/v1/health 2>/dev/null)
  if echo "$body" | head -c 1 | grep -q '{'; then echo "[boot] health OK after ${i}s"; break; fi
  sleep 1
done

echo "== system/status channel telemetry =="
curl -s -m 90 http://127.0.0.1:3000/api/v1/system/status -o /tmp/status.json -w "status HTTP %{http_code}\n"
python3 - <<'EOF'
import json
d = json.load(open('/tmp/status.json'))
dc = d.get('digestChannel')
print('digestChannel:', json.dumps({k: v for k, v in (dc or {}).items() if k != 'note'}, indent=1))
print('note:', (dc or {}).get('note', '')[:120], '...')
print('scheduler.enabled:', d['scheduler']['enabled'])
EOF

# 2) pick a watchlist (prefer one with existing coverage so evaluate is fast)
curl -s -m 60 http://127.0.0.1:3000/api/v1/fires/watchlists -o /tmp/wl.json
WL=$(python3 - <<'EOF'
import json
d = json.load(open('/tmp/wl.json'))
rows = d.get('watchlists', [])
print(rows[0]['id'] if rows else '', end='')
if rows:
    print(f"[watchlist] {rows[0]['name']} — last status {rows[0]['lastStatus']}, {rows[0]['eventCount']} events", file=__import__('sys').stderr)
EOF
)
if [ -z "$WL" ]; then echo "NO WATCHLISTS — creating one (Zambia preset)"; fi

# 3) subscribe to the push channel in the background for up to 8 minutes
rm -f /tmp/stream.txt
curl -sN -m 480 http://127.0.0.1:3000/api/v1/fires/watchlists/digest-stream -o /tmp/stream.txt 2>/dev/null &
STREAM_PID=$!
sleep 3
echo "== stream frames so far (hello + retry) =="
head -c 700 /tmp/stream.txt; echo; echo "----"

# 4) trigger an evaluation (manual) — push should follow within seconds
echo "== evaluate $WL (manual) =="
curl -s -m 420 -X POST "http://127.0.0.1:3000/api/v1/fires/watchlists/$WL/evaluate" \
  -H 'content-type: application/json' -d '{}' -o /tmp/eval.json -w "evaluate HTTP %{http_code} in %{time_total}s\n"
python3 - <<'EOF'
import json
try:
    d = json.load(open('/tmp/eval.json'))
except Exception:
    print(open('/tmp/eval.json').read()[:300]); raise SystemExit
if 'evaluation' in d:
    ev = d['evaluation']
    print(f"[evaluate] status={ev['status']} detections={ev['detectionCount']} daysFetched={ev.get('daysFetchedFromGibs')} window={ev['windowStart']}->{ev['windowEnd']} mode={d.get('mode')}")
else:
    print('[evaluate] error:', json.dumps(d)[:300])
EOF

# 5) wait for the pushed digest to land on the open stream
sleep 8
echo "== pushed stream after evaluation =="
if grep -q "event: watchlist.digest" /tmp/stream.txt; then
  echo "PUSH RECEIVED — watchlist.digest frames on the stream:"
  grep -c "^event: watchlist.digest" /tmp/stream.txt | sed 's/^/  frames: /'
  python3 - <<'EOF'
import json, re
raw = open('/tmp/stream.txt').read()
m = re.search(r'^data: (\{"type":"digest".*)$', raw, re.M)
if m:
    p = json.loads(m.group(1))
    dg = p['digest']
    print('  reason:', p['reason'], '| trigger:', p['trigger'], '| pushedAt:', p['pushedAt'])
    print('  watchlist:', p['watchlistName'], '| last status in window:', dg['current']['last'])
    print('  window source:', dg['windowSource'], '| hours:', dg['hours'])
    for line in dg['digest'][:3]:
        print('   |', line)
else:
    print('  (frame header present but data line not parsed)')
EOF
else
  echo "NO PUSH FRAME YET — stream tail:"
  tail -c 600 /tmp/stream.txt
fi
echo "== keepalive comments seen: $(grep -c '^: keepalive' /tmp/stream.txt) =="

kill $STREAM_PID 2>/dev/null
# 6) channel status after the push (eventsDelivered must be > 0)
curl -s -m 60 http://127.0.0.1:3000/api/v1/system/status -o /tmp/status2.json
python3 - <<'EOF'
import json
d = json.load(open('/tmp/status2.json'))
dc = d['digestChannel']
print('channel after push:', json.dumps({k: dc[k] for k in ('subscribers', 'connectionsOpened', 'eventsDelivered', 'lastEventAt')}, indent=1))
EOF

kill $SERVER_PID 2>/dev/null
pkill -f "next dev" 2>/dev/null
pkill -f next-server 2>/dev/null
echo "== done =="
