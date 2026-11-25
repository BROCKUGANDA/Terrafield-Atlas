#!/bin/sh
set -eu
ROOT=/home/ubuntu/ai-azimara-terrafield
STAGE=/home/ubuntu/terrafield-accounts-release-20261119
PATCH=/home/ubuntu/terrafield-account-validation.tar.gz
test ! -e "$ROOT/.next.before-account-validation-20261119"
tar -xzf "$PATCH" -C "$STAGE"
cd "$STAGE"
NEXT_PUBLIC_SITE_URL=https://terrafieldatlas.us ./node_modules/.bin/next build --webpack
cp -a public .next/standalone/public
cp -a .next/static .next/standalone/.next/static
cp -a "$ROOT/.next/static/." .next/static/
cp -a "$ROOT/.next/static/." .next/standalone/.next/static/
mkdir "$ROOT/source-before-account-validation-20261119"
tar -tzf "$PATCH" | while IFS= read -r file; do
  if test -f "$ROOT/$file"; then
    mkdir -p "$ROOT/source-before-account-validation-20261119/$(dirname "$file")"
    cp -p "$ROOT/$file" "$ROOT/source-before-account-validation-20261119/$file"
  fi
done
sudo systemctl stop terrafield
mv "$ROOT/.next" "$ROOT/.next.before-account-validation-20261119"
mv .next "$ROOT/.next"
tar -xzf "$PATCH" -C "$ROOT"
sudo systemctl start terrafield
sleep 3
if ! curl -fsS https://terrafieldatlas.us/api/v1/healthz; then
  sudo systemctl stop terrafield
  mv "$ROOT/.next" "$STAGE/.next.failed-validation"
  mv "$ROOT/.next.before-account-validation-20261119" "$ROOT/.next"
  cp -a "$ROOT/source-before-account-validation-20261119/." "$ROOT/"
  sudo systemctl start terrafield
  exit 1
fi
systemctl is-active terrafield