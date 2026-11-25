#!/bin/sh
# Restore a named SQLite artifact to a NEW path and a named PostgreSQL snapshot.
# It never removes or overwrites the original SQLite source.
set -eu
usage() {
  echo "Usage: $0 --confirm ROLLBACK --sqlite-backup <backup.db> --restore-source-to <new.db> --target-url <postgresql-url> --target-snapshot <before.dump> --freeze-hook <script> --artifact <previous-release-dir> --activate-hook <script> --env-file <runtime.env> --database-url <previous-database-url> --restart-hook <script> --readiness-url <http-url>" >&2
  exit 2
}
die() { echo "rollback: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"; }
require_value() { [ "$#" -ge 2 ] && [ -n "$2" ] || die "missing value for $1"; }
confirm= sqlite_backup= restore_to= target_url= target_snapshot= freeze_hook= artifact= activate_hook= env_file= database_url= restart_hook= readiness_url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --confirm) require_value "$@"; confirm=$2; shift 2 ;;
    --sqlite-backup) require_value "$@"; sqlite_backup=$2; shift 2 ;;
    --restore-source-to) require_value "$@"; restore_to=$2; shift 2 ;;
    --target-url) require_value "$@"; target_url=$2; shift 2 ;;
    --target-snapshot) require_value "$@"; target_snapshot=$2; shift 2 ;;
    --freeze-hook) require_value "$@"; freeze_hook=$2; shift 2 ;;
    --artifact) require_value "$@"; artifact=$2; shift 2 ;;
    --activate-hook) require_value "$@"; activate_hook=$2; shift 2 ;;
    --env-file) require_value "$@"; env_file=$2; shift 2 ;;
    --database-url) require_value "$@"; database_url=$2; shift 2 ;;
    --restart-hook) require_value "$@"; restart_hook=$2; shift 2 ;;
    --readiness-url) require_value "$@"; readiness_url=$2; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ "$confirm" = ROLLBACK ] || usage
for value in "$sqlite_backup" "$restore_to" "$target_url" "$target_snapshot" "$freeze_hook" "$artifact" "$activate_hook" "$env_file" "$database_url" "$restart_hook" "$readiness_url"; do [ -n "$value" ] || usage; done
case "$restore_to" in */db/custom.db|db/custom.db) die "refusing protected path db/custom.db" ;; esac
case "$target_url" in postgresql://*|postgres://*) ;; *) die "target must be an explicit PostgreSQL URL" ;; esac
case "$readiness_url" in https://*|http://*) ;; *) die "readiness must be an HTTP(S) URL" ;; esac
case "$database_url$restore_to$target_snapshot$artifact" in *"
"*) die "arguments must not contain newlines" ;; esac
[ -f "$sqlite_backup" ] || die "SQLite backup not found: $sqlite_backup"
[ -f "$sqlite_backup.sha256" ] || die "SQLite backup checksum not found: $sqlite_backup.sha256"
[ -f "$target_snapshot" ] && [ -s "$target_snapshot" ] || die "PostgreSQL snapshot missing or empty: $target_snapshot"
[ -f "$target_snapshot.sha256" ] || die "PostgreSQL snapshot checksum not found: $target_snapshot.sha256"
[ -d "$artifact" ] || die "previous release artifact not found: $artifact"
[ -f "$env_file" ] || die "runtime env file not found: $env_file"
[ -f "$activate_hook" ] || die "activation hook not found: $activate_hook"
[ -f "$freeze_hook" ] || die "freeze hook not found: $freeze_hook"
[ -f "$restart_hook" ] || die "restart hook not found: $restart_hook"
[ ! -e "$restore_to" ] || die "refusing to overwrite restore destination: $restore_to (choose a new path)"
[ -d "$(dirname "$restore_to")" ] || die "restore destination directory not found"
need sqlite3; need sha256sum; need pg_restore; need psql; need curl

verify_checksum() {
  file=$1
  checksum_line=
  IFS= read -r checksum_line < "$file.sha256" || [ -n "$checksum_line" ] || die "invalid checksum file: $file.sha256"
  expected=${checksum_line%% *}
  [ "${#expected}" -eq 64 ] || die "invalid checksum file: $file.sha256"
  case "$expected" in *[!a-f0-9]*) die "invalid checksum file: $file.sha256" ;; esac
  [ "$checksum_line" = "$expected  $(basename "$file")" ] || die "invalid checksum file format: $file.sha256"
  actual=$(CDPATH= cd "$(dirname "$file")" && sha256sum "$(basename "$file")" | cut -d ' ' -f1)
  [ "$actual" = "$expected" ] || die "checksum mismatch: $file"
}
verify_checksum "$sqlite_backup"
verify_checksum "$target_snapshot"
[ "$(sqlite3 "$sqlite_backup" 'PRAGMA integrity_check;')" = ok ] || die "SQLite backup integrity check failed"

# Inspect the complete archive before any destructive --clean restore.
snapshot_entries=$(pg_restore --list "$target_snapshot") || die "cannot inspect PostgreSQL snapshot contents"

# The operator hook must stop writers and verify that writes are rejected.
echo 'rollback: freezing writes'
sh "$freeze_hook" || die "write freeze failed; PostgreSQL snapshot was not restored"

cp "$sqlite_backup" "$restore_to"
[ "$(sqlite3 "$restore_to" 'PRAGMA integrity_check;')" = ok ] || die "restored SQLite integrity check failed"
echo 'rollback: verified SQLite artifact restored to a new path; original source retained'

# --clean drops objects in this explicitly selected database before restoring.
pg_restore --dbname="$target_url" --clean --if-exists --no-owner --no-privileges "$target_snapshot" || die "PostgreSQL snapshot restore failed"
case "$snapshot_entries" in
  *_migration_checkpoint*) ;;
  *) psql --dbname="$target_url" --set=ON_ERROR_STOP=1 --command='DROP TABLE IF EXISTS "_migration_checkpoint"' || die "cannot remove migration checkpoint added after snapshot" ;;
esac
echo 'rollback: restored named PostgreSQL snapshot'
PREVIOUS_ARTIFACT=$artifact sh "$activate_hook" || die "previous artifact activation failed"

env_tmp="$env_file.tmp.$$"
trap 'rm -f "$env_tmp"' EXIT HUP INT TERM
PREVIOUS_DATABASE_URL=$database_url awk '
  BEGIN { replaced = 0 }
  /^DATABASE_URL=/ { if (!replaced) print "DATABASE_URL=" ENVIRON["PREVIOUS_DATABASE_URL"]; replaced = 1; next }
  { print }
  END { if (!replaced) print "DATABASE_URL=" ENVIRON["PREVIOUS_DATABASE_URL"] }
' "$env_file" > "$env_tmp"
chmod 600 "$env_tmp"
mv "$env_tmp" "$env_file"
sh "$restart_hook" || die "service restart failed after rollback"
attempt=0
while [ "$attempt" -lt 30 ]; do
  if curl --fail --silent --show-error --max-time 5 "$readiness_url" >/dev/null; then
    echo 'rollback: readiness verified; no source data was deleted'
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 1
done
die "rollback readiness failed; inspect restored service manually"
