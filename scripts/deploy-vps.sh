#!/bin/sh
# Deploy TerraField Atlas to the production VPS.
#
# The production host runs the Next.js standalone server under systemd
# (terrafield.service) against the PostgreSQL/PostGIS container and Redis on the
# private loopback ports from APP_DIR/.env. This script is the local fallback
# for the GitHub Actions deploy workflow, which cannot run while the Actions
# account is billing-locked.
#
# Required environment:
#   VPS_HOST      ssh host or IP of the production server
#   VPS_SSH_KEY   private key path
# Optional:
#   VPS_USER      default ubuntu
#   APP_DIR       default /home/ubuntu/ai-azimara-terrafield
#   SERVICE       default terrafield.service
#   READY_URL     default http://127.0.0.1:3011/api/v1/readyz
#
# Exit 0 only after the deployed process answers readiness. Any failure after
# the previous build was set aside restores it and restarts the service.
set -eu

: "${VPS_HOST:?set VPS_HOST}"
: "${VPS_SSH_KEY:?set VPS_SSH_KEY}"
VPS_USER=${VPS_USER:-ubuntu}
APP_DIR=${APP_DIR:-/home/ubuntu/ai-azimara-terrafield}
SERVICE=${SERVICE:-terrafield.service}
READY_URL=${READY_URL:-http://127.0.0.1:3011/api/v1/readyz}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
ROOT=$(cd "$(dirname "$0")/.." && pwd)

remote() {
  ssh -o BatchMode=yes -o ConnectTimeout=15 -i "$VPS_SSH_KEY" "$VPS_USER@$VPS_HOST" "$@"
}

echo "deploy: $STAMP -> $VPS_USER@$VPS_HOST:$APP_DIR"

# 1. Ship the source. Generated trees and local state stay on the workstation.
tar -czf - -C "$ROOT" \
  --exclude='./.git' --exclude='./.next' --exclude='./node_modules' \
  --exclude='./db/*.db*' --exclude='./download' --exclude='./test-results' \
  --exclude='./tool-results' --exclude='./.env' --exclude='./*.log' \
  . | remote "mkdir -p '$APP_DIR' && rm -rf '$APP_DIR/prisma/migrations' && tar -xzf - -C '$APP_DIR'"

# 2. Backup, build, migrate, swap, restart and gate readiness atomically.
remote "APP_DIR='$APP_DIR' SERVICE='$SERVICE' READY_URL='$READY_URL' STAMP='$STAMP' sh -s" <<'REMOTE'
set -eu
cd "$APP_DIR"
RELEASES=/mnt/terrafield/releases
mkdir -p "$RELEASES"
# Turbopack resolves PostCSS plugins relative to the build directory, so the
# build must happen in the application tree where node_modules lives. The
# finished tree is then published to the block volume and .next becomes a
# symlink to that immutable release (the layout production already runs).
if [ -L .next ]; then
  OLD_TARGET=$(readlink -f .next)
  rm -f .next
elif [ -d .next ]; then
  OLD_TARGET=
  rm -rf .next
else
  OLD_TARGET=
fi
# Superseded 2026-11-19 rollback trees on the root disk; releases on the block
# volume replace them.
rm -rf .next.before-*

BACKUP_DIR=/mnt/terrafield/backups
mkdir -p "$BACKUP_DIR"
PG=$(docker ps --filter name=terrafield-postgres --format '{{.Names}}' | head -n 1)
[ -n "$PG" ] || { echo 'deploy: terrafield-postgres container not found; refusing to migrate without a backup' >&2; exit 2; }
PG_USER=$(docker exec "$PG" printenv POSTGRES_USER)
PG_DB=$(docker exec "$PG" printenv POSTGRES_DB)
BACKUP="$BACKUP_DIR/terrafield-$STAMP.dump"
docker exec "$PG" pg_dump -U "$PG_USER" -d "$PG_DB" --format=custom > "$BACKUP"
[ -s "$BACKUP" ] || { echo 'deploy: backup is empty' >&2; exit 2; }
sha256sum "$BACKUP" > "$BACKUP.sha256"
ls -t "$BACKUP_DIR"/terrafield-*.dump 2>/dev/null | tail -n +11 | xargs -r rm -f
echo "deploy: backup $BACKUP ($(wc -c < "$BACKUP") bytes)"

SUCCESS=0
rollback() {
  echo 'deploy: restoring the previous release' >&2
  rm -rf .next
  if [ -n "$OLD_TARGET" ] && [ -d "$OLD_TARGET" ]; then
    ln -sfn "$OLD_TARGET" .next
    sudo -n systemctl restart "$SERVICE" || true
  fi
}
on_exit() { [ "$SUCCESS" = 1 ] || rollback; }
trap on_exit EXIT

/home/ubuntu/.bun/bin/bun install --frozen-lockfile
/home/ubuntu/.bun/bin/bunx prisma generate
NODE_ENV=production /home/ubuntu/.bun/bin/bun run build
/home/ubuntu/.bun/bin/bun run db:migrate:deploy

NEW_RELEASE="$RELEASES/$STAMP"
mkdir -p "$NEW_RELEASE"
mv .next "$NEW_RELEASE/.next"
ln -sfn "$NEW_RELEASE/.next" .next

sudo -n systemctl restart "$SERVICE"
attempt=0
while [ "$attempt" -lt 60 ]; do
  CODE=$(curl -sS -o /tmp/terrafield-ready.json -w '%{http_code}' --max-time 5 "$READY_URL" || true)
  if [ "$CODE" = '200' ]; then
    curl -fsS --max-time 5 "${READY_URL%/readyz}/healthz" >/dev/null
    SUCCESS=1
    # Keep the running release plus two rollback candidates.
    ls -dt "$RELEASES"/*/ 2>/dev/null | tail -n +4 | xargs -r rm -rf
    echo "deploy: ready at $STAMP"
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 5
done
echo 'deploy: readiness gate timed out' >&2
exit 1
REMOTE

echo "deploy: complete"
