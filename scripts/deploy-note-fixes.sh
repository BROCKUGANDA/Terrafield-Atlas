#!/bin/sh
# HISTORICAL SQLITE-ONLY DEPLOYMENT SCRIPT — NOT FOR PRODUCTION OR POSTGRESQL.
# Retained to preserve the 2026-11-19 deployment/recovery history. The current
# PostgreSQL production deployment uses .github/workflows/deploy.yml instead.
# The archived SQLite migration is outside Prisma's active migration path.
set -eu
ROOT=/home/ubuntu/ai-azimara-terrafield
STAGE=/home/ubuntu/terrafield-accounts-release-20261119
test ! -e "$ROOT/.next.before-accounts-20261119"
if ! test -d "$STAGE"; then
  mkdir "$STAGE"
  rsync -a --exclude='.next*' --exclude='source-before-*' --exclude=node_modules --exclude=.git --exclude='*.tar.gz' "$ROOT/" "$STAGE/"
  ln -s "$ROOT/node_modules" "$STAGE/node_modules"
fi
tar -xzf /home/ubuntu/terrafield-notes-fixes.tar.gz -C "$STAGE"
cd "$STAGE"
./node_modules/.bin/prisma generate
NEXT_PUBLIC_SITE_URL=https://terrafieldatlas.us ./node_modules/.bin/next build --webpack
cp -a public .next/standalone/public
cp -a .next/static .next/standalone/.next/static
cp -a "$ROOT/.next/static/." .next/static/
cp -a "$ROOT/.next/static/." .next/standalone/.next/static/
mkdir "$ROOT/source-before-accounts-20261119"
tar -tzf /home/ubuntu/terrafield-notes-fixes.tar.gz | while IFS= read -r file; do
  if test -f "$ROOT/$file"; then
    mkdir -p "$ROOT/source-before-accounts-20261119/$(dirname "$file")"
    cp -p "$ROOT/$file" "$ROOT/source-before-accounts-20261119/$file"
  fi
done
test ! -e "$ROOT/.next.before-accounts-20261119"
sudo systemctl stop terrafield
DATABASE_FILE=$(cd "$ROOT"; node -e 'const{PrismaClient}=require("@prisma/client");const db=new PrismaClient();db.$queryRawUnsafe("PRAGMA database_list").then(rows=>console.log(rows.find(row=>row.name==="main").file)).finally(()=>db.$disconnect())')
if ! python3 scripts/migrate-private-accounts.py "$DATABASE_FILE" prisma/sqlite-migrations/20261119130000_private_accounts/migration.sql; then
  sudo systemctl start terrafield
  exit 1
fi
mv "$ROOT/.next" "$ROOT/.next.before-accounts-20261119"
mv .next "$ROOT/.next"
tar -xzf /home/ubuntu/terrafield-notes-fixes.tar.gz -C "$ROOT"
sudo systemctl start terrafield
sleep 3
if ! curl -fsS https://terrafieldatlas.us/api/v1/healthz; then
  sudo systemctl stop terrafield
  mv "$ROOT/.next" "$STAGE/.next.failed"
  mv "$ROOT/.next.before-accounts-20261119" "$ROOT/.next"
  cp -a "$ROOT/source-before-accounts-20261119/." "$ROOT/"
  sudo systemctl start terrafield
  exit 1
fi
systemctl is-active terrafield