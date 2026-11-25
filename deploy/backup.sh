#!/bin/sh
set -eu

BACKUP_DIR="${BACKUP_DIR:-/var/backups/terrafield}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-terrafield}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARTIFACT="$BACKUP_DIR/terrafield-$STAMP.dump"

mkdir -p "$BACKUP_DIR"
umask 077
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$ARTIFACT"
sha256sum "$ARTIFACT" > "$ARTIFACT.sha256"
docker compose exec -T postgres pg_restore --list < "$ARTIFACT" > /dev/null
printf '%s\n' "$ARTIFACT"
