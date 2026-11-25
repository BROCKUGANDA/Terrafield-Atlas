#!/bin/sh
set -eu
umask 077
ROOT=/home/ubuntu/ai-azimara-terrafield
STAGE=/home/ubuntu/terrafield-accounts-release-20261119
PATCH=/home/ubuntu/terrafield-private-workflows.tar.gz
BACKUP="$ROOT/.next.before-private-workflows-20261119"
SOURCE="$ROOT/source-before-private-workflows-20261119"
test ! -e "$BACKUP"
test ! -e "$SOURCE"
test -d "$STAGE/node_modules"
tar -xzf "$PATCH" -C "$STAGE"
cd "$STAGE"
./node_modules/.bin/prisma generate
NEXT_PUBLIC_SITE_URL=https://terrafieldatlas.us ./node_modules/.bin/next build --webpack
cp -a public .next/standalone/public
cp -a .next/static .next/standalone/.next/static
cp -a "$ROOT/.next/static/." .next/static/
cp -a "$ROOT/.next/static/." .next/standalone/.next/static/
mkdir "$SOURCE"
tar -tzf "$PATCH" | while IFS= read -r file; do
  if test -f "$ROOT/$file"; then
    mkdir -p "$SOURCE/$(dirname "$file")"
    cp -p "$ROOT/$file" "$SOURCE/$file"
  fi
done
sudo systemctl stop terrafield
trap 'sudo systemctl start terrafield' EXIT
DATABASE_FILE=$(cd "$ROOT"; node -e 'const{PrismaClient}=require("@prisma/client");const db=new PrismaClient();db.$queryRawUnsafe("PRAGMA database_list").then(rows=>console.log(rows.find(row=>row.name==="main").file)).finally(()=>db.$disconnect())')
python3 - "$DATABASE_FILE" <<'PY'
import sqlite3
import sys
from pathlib import Path
source = Path(sys.argv[1])
backup = Path(str(source) + '.before-private-workflows-20261119')
if backup.exists():
    raise SystemExit('Refusing to overwrite database backup')
with sqlite3.connect(source) as src, sqlite3.connect(backup) as dst:
    src.backup(dst)
print('SQLite backup retained before private-workflow migration.')
PY
if ! python3 scripts/migrate-private-workflows.py "$DATABASE_FILE"; then
  sudo systemctl start terrafield
  exit 1
fi
mv "$ROOT/.next" "$BACKUP"
mv .next "$ROOT/.next"
tar -xzf "$PATCH" -C "$ROOT"
sudo systemctl start terrafield
sleep 3
if ! curl -fsS https://terrafieldatlas.us/api/v1/healthz; then
  sudo systemctl stop terrafield
  mv "$ROOT/.next" "$STAGE/.next.failed-private-workflows"
  mv "$BACKUP" "$ROOT/.next"
  cp -a "$SOURCE/." "$ROOT/"
  sudo systemctl start terrafield
  exit 1
fi
systemctl is-active terrafield
trap - EXIT