#!/bin/sh
# Create a checksummed PostgreSQL backup for a release gate.
set -eu

COMPOSE_FILES="${COMPOSE_FILES:-compose.yaml}"
BACKUP_DIR="${BACKUP_DIR:-/home/ubuntu/terrafield-backups}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-terrafield}"

mkdir -p "$BACKUP_DIR"
BACKUP="$BACKUP_DIR/terrafield-$(date -u +%Y%m%dT%H%M%SZ).dump"
# shellcheck disable=SC2086
docker compose $COMPOSE_FILES exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom > "$BACKUP"
[ -s "$BACKUP" ] || { echo 'backup is empty' >&2; exit 1; }
sha256sum "$BACKUP" > "$BACKUP.sha256"
printf '%s\n' "$BACKUP"
