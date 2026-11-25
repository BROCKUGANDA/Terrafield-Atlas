#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <named-backup.dump>" >&2
  exit 2
fi
ARTIFACT="$1"
[ -s "$ARTIFACT" ] || { echo "backup artifact is missing or empty: $ARTIFACT" >&2; exit 2; }

POSTGRES_USER="${POSTGRES_USER:-postgres}"
DRILL_DB="terrafield_restore_$(date -u +%Y%m%d%H%M%S)_$$"
cleanup() {
  docker compose exec -T postgres psql -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE IF EXISTS \"$DRILL_DB\";" > /dev/null
}
trap cleanup EXIT INT TERM

docker compose exec -T postgres createdb -U "$POSTGRES_USER" "$DRILL_DB"
docker compose exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$DRILL_DB" --no-owner --exit-on-error < "$ARTIFACT"
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$DRILL_DB" -v ON_ERROR_STOP=1 -c 'SELECT 1;' > /dev/null
printf 'restore drill passed: %s\n' "$ARTIFACT"
