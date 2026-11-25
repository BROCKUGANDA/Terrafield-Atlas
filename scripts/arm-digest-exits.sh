#!/usr/bin/env bash
# Arm the digest delivery exits LIVE (idempotent):
#   1. .env — append any missing DIGEST_WEBHOOK_* / DIGEST_SMTP_* variables.
#      The signing secret is generated with `openssl rand` and written
#      straight to .env; it is never echoed to the transcript.
#   2. verification endpoints — the signed-webhook receiver (127.0.0.1:4317)
#      and the SMTP sink (127.0.0.1:2525) are started unless already
#      listening. Their JSONL delivery logs land in download/hackathon/exits/
#      (durable proof of every signed POST and accepted message).
#   3. --restart-dev — restart `next dev` so the armed env is actually loaded.
#
# SSRF note: 127.0.0.1:4317 sits in a refused range, so the same script adds
# the EXACT host:port entry to DIGEST_WEBHOOK_ALLOWLIST — the OWASP "default
# deny + explicit operator opt-in" pattern for an internal ops relay.
set -u
cd /home/z/my-project

EXITS_DIR=download/hackathon/exits
mkdir -p "$EXITS_DIR"

# ---------------------------------------------------------------------------
# 1) .env arming — append only what is missing
# ---------------------------------------------------------------------------
ensure_env() { # name, value
  local name="$1" value="$2"
  if ! grep -q "^${name}=" .env 2>/dev/null; then
    printf '%s=%s\n' "$name" "$value" >> .env
    echo "[arm] .env += ${name}"
  fi
}

ensure_env DIGEST_WEBHOOK_URL "http://127.0.0.1:4317/digest"
if ! grep -q "^DIGEST_WEBHOOK_SECRET=" .env 2>/dev/null; then
  printf 'DIGEST_WEBHOOK_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env
  echo "[arm] .env += DIGEST_WEBHOOK_SECRET (openssl rand -hex 32; not echoed)"
fi
ensure_env DIGEST_WEBHOOK_SECRET_PREVIOUS "e2e-demo-secret"
ensure_env DIGEST_WEBHOOK_ALLOWLIST "127.0.0.1:4317"
ensure_env DIGEST_SMTP_HOST "127.0.0.1"
ensure_env DIGEST_SMTP_PORT "2525"
ensure_env DIGEST_SMTP_FROM "TerraField Atlas <atlas@terrafield.demo>"
ensure_env DIGEST_SMTP_TO "ops@terrafield.demo, rangers@terrafield.demo"

# ---------------------------------------------------------------------------
# 2) verification endpoints (start unless the port already answers)
# ---------------------------------------------------------------------------
port_listening() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3>&- 3<&-; return 0; } || return 1; }

RECEIVER_SECRET="$(grep '^DIGEST_WEBHOOK_SECRET=' .env | head -1 | cut -d= -f2-)"
RECEIVER_SECRET_PREVIOUS="$(grep '^DIGEST_WEBHOOK_SECRET_PREVIOUS=' .env | head -1 | cut -d= -f2-)"
export RECEIVER_SECRET RECEIVER_SECRET_PREVIOUS

if port_listening 4317; then
  echo "[arm] webhook receiver already listening on 127.0.0.1:4317"
else
  RECEIVER_SECRET="$RECEIVER_SECRET" RECEIVER_SECRET_PREVIOUS="$RECEIVER_SECRET_PREVIOUS" \
    nohup node scripts/webhook-receiver.mjs 4317 "$EXITS_DIR/webhook-deliveries.jsonl" 3600000 \
    > "$EXITS_DIR/webhook-receiver.log" 2>&1 &
  echo "[arm] webhook receiver started (pid $!) → $EXITS_DIR/webhook-deliveries.jsonl"
fi

if port_listening 2525; then
  echo "[arm] SMTP sink already listening on 127.0.0.1:2525"
else
  nohup node scripts/smtp-sink.mjs 2525 "$EXITS_DIR/smtp-deliveries.jsonl" 3600000 \
    > "$EXITS_DIR/smtp-sink.log" 2>&1 &
  echo "[arm] SMTP sink started (pid $!) → $EXITS_DIR/smtp-deliveries.jsonl"
fi

# ---------------------------------------------------------------------------
# 3) optional dev-server restart so the armed env is loaded
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--restart-dev" ]; then
  echo "[arm] restarting next dev…"
  pkill -f "next dev" 2>/dev/null; pkill -f "next-server" 2>/dev/null
  sleep 2
  nohup bun run dev > /tmp/dev-armed.log 2>&1 &
  echo "[arm] dev server restarting (pid $!) — log /tmp/dev-armed.log"
fi

echo "[arm] done — verify with: curl -s localhost:3000/api/v1/system/status | python3 -m json.tool | grep -A6 '\"webhook\"'"
