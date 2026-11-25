#!/bin/sh
# Explicit, operator-driven SQLite -> PostgreSQL cutover. Source is never deleted.
set -eu

usage() {
  echo "Usage: $0 --source <sqlite> --target-url <postgresql-url> --backup <new-backup.db> --target-snapshot <new.dump> --artifact <release-dir> --env-file <runtime.env> --freeze-hook <script> --activate-hook <script> --restart-hook <script> --readiness-url <https-url>" >&2
  exit 2
}
die() { echo "cutover: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"; }
require_value() { [ "$#" -ge 2 ] && [ -n "$2" ] || die "missing value for $1"; }
source_db= target_url= backup= snapshot= artifact= env_file= freeze_hook= activate_hook= restart_hook= readiness_url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --source) require_value "$@"; source_db=$2; shift 2 ;;
    --target-url) require_value "$@"; target_url=$2; shift 2 ;;
    --backup) require_value "$@"; backup=$2; shift 2 ;;
    --target-snapshot) require_value "$@"; snapshot=$2; shift 2 ;;
    --artifact) require_value "$@"; artifact=$2; shift 2 ;;
    --env-file) require_value "$@"; env_file=$2; shift 2 ;;
    --freeze-hook) require_value "$@"; freeze_hook=$2; shift 2 ;;
    --activate-hook) require_value "$@"; activate_hook=$2; shift 2 ;;
    --restart-hook) require_value "$@"; restart_hook=$2; shift 2 ;;
    --readiness-url) require_value "$@"; readiness_url=$2; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
for value in "$source_db" "$target_url" "$backup" "$snapshot" "$artifact" "$env_file" "$freeze_hook" "$activate_hook" "$restart_hook" "$readiness_url"; do
  [ -n "$value" ] || usage
done
case "$source_db" in */db/custom.db|db/custom.db) die "refusing protected source db/custom.db" ;; esac
case "$target_url" in postgresql://*|postgres://*) ;; *) die "target must be an explicit PostgreSQL URL" ;; esac
case "$readiness_url" in https://*|http://*) ;; *) die "readiness must be an HTTP(S) URL" ;; esac
case "$target_url$backup$snapshot$artifact$env_file" in *"
"*) die "arguments must not contain newlines" ;; esac
case "$backup" in *"'"*) die "unsupported backup path: apostrophes are not supported before write freeze" ;; esac
case "$backup" in -*|*/-*) die "unsupported backup path: basename must not begin with '-' before write freeze" ;; esac
case "$snapshot" in -*|*/-*) die "unsupported snapshot path: basename must not begin with '-' before write freeze" ;; esac
[ -f "$source_db" ] || die "source database not found: $source_db"
[ -d "$artifact" ] || die "release artifact directory not found: $artifact"
[ -f "$env_file" ] || die "runtime env file not found: $env_file"
for hook in "$freeze_hook" "$activate_hook" "$restart_hook"; do [ -f "$hook" ] || die "hook not found: $hook"; done
for output in "$backup" "$snapshot"; do
  [ ! -e "$output" ] || die "refusing to overwrite existing backup/snapshot: $output"
  [ ! -e "$output.sha256" ] || die "refusing to overwrite existing backup/snapshot checksum: $output.sha256"
  [ -d "$(dirname "$output")" ] || die "output directory not found: $(dirname "$output")"
done
need sqlite3; need sha256sum; need pg_dump; need curl; need bun

# Freeze first: every artifact must describe the same quiescent point.
echo 'cutover: freezing writes'
sh "$freeze_hook"
backup_tmp="$backup.tmp.$$"
snapshot_tmp="$snapshot.tmp.$$"
env_tmp="$env_file.tmp.$$"
trap 'rm -f "$backup_tmp" "$snapshot_tmp" "$env_tmp"' EXIT HUP INT TERM

# The supported SQLite backup API handles WAL consistency and path quoting without dot-command interpolation.
SOURCE_DB=$source_db BACKUP_TMP=$backup_tmp bun -e 'import { DatabaseSync, backup } from "node:sqlite"; const db = new DatabaseSync(process.env.SOURCE_DB!, { readOnly: true }); try { await backup(db, process.env.BACKUP_TMP!); } finally { db.close(); }' || die "SQLite backup failed; writes remain frozen"
[ "$(sqlite3 "$backup_tmp" 'PRAGMA integrity_check;')" = ok ] || die "SQLite backup integrity check failed; writes remain frozen"
[ "$(sqlite3 "$source_db" 'PRAGMA integrity_check;')" = ok ] || die "source integrity check failed; writes remain frozen"
[ "$(sqlite3 "$backup_tmp" 'SELECT COUNT(*) FROM Farm;')" = "$(sqlite3 "$source_db" 'SELECT COUNT(*) FROM Farm;')" ] || die "backup Farm count mismatch; writes remain frozen"
hash=$(CDPATH= cd "$(dirname "$backup_tmp")" && sha256sum "$(basename "$backup_tmp")" | cut -d ' ' -f1)
[ "${#hash}" -eq 64 ] || die "backup checksum failed (length ${#hash}); writes remain frozen"
case "$hash" in *[!a-f0-9]*) die "invalid backup checksum format; writes remain frozen" ;; esac
mv "$backup_tmp" "$backup"
printf '%s  %s\n' "$hash" "$(basename "$backup")" > "$backup.sha256"
echo 'cutover: verified SQLite backup and checksum'

pg_dump --dbname="$target_url" --format=custom --file="$snapshot_tmp" || die "PostgreSQL snapshot failed; writes remain frozen"
[ -s "$snapshot_tmp" ] || die "PostgreSQL snapshot is empty; writes remain frozen"
snapshot_hash=$(CDPATH= cd "$(dirname "$snapshot_tmp")" && sha256sum "$(basename "$snapshot_tmp")" | cut -d ' ' -f1)
[ "${#snapshot_hash}" -eq 64 ] || die "invalid PostgreSQL snapshot checksum length; writes remain frozen"
case "$snapshot_hash" in *[!a-f0-9]*) die "invalid PostgreSQL snapshot checksum format; writes remain frozen" ;; esac
printf '%s  %s\n' "$snapshot_hash" "$(basename "$snapshot")" > "$snapshot.sha256"
mv "$snapshot_tmp" "$snapshot"
echo 'cutover: verified pre-cutover PostgreSQL snapshot'

bun scripts/migrate-sqlite-to-postgres.ts "file:$source_db" "$target_url" || die "migration failed; writes remain frozen"
bun scripts/validate-migration.ts "file:$source_db" "$target_url" || die "validation failed; writes remain frozen"

RELEASE_ARTIFACT=$artifact sh "$activate_hook" || die "artifact activation failed; writes remain frozen"
NEW_DATABASE_URL=$target_url awk '
  BEGIN { replaced = 0 }
  /^DATABASE_URL=/ { if (!replaced) print "DATABASE_URL=" ENVIRON["NEW_DATABASE_URL"]; replaced = 1; next }
  { print }
  END { if (!replaced) print "DATABASE_URL=" ENVIRON["NEW_DATABASE_URL"] }
' "$env_file" > "$env_tmp"
chmod 600 "$env_tmp"
mv "$env_tmp" "$env_file"
sh "$restart_hook" || die "service restart failed; rollback is required"

attempt=0
while [ "$attempt" -lt 30 ]; do
  if curl --fail --silent --show-error --max-time 5 "$readiness_url" >/dev/null; then
    echo 'cutover: readiness verified; source retained'
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 1
done
die "readiness failed; configuration switched and rollback is required"
