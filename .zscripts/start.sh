#!/bin/sh
set -eu

# Production Compose launcher. Database, Redis and monitoring ports remain on
# private Docker networks; Caddy is the only public listener.
cd "$(dirname "$0")/.."

: "${DATABASE_URL:?DATABASE_URL must be supplied by the deployment environment}"
: "${REDIS_URL:?REDIS_URL must be supplied by the deployment environment}"
: "${NEXTAUTH_SECRET:?NEXTAUTH_SECRET is required}"
: "${NEXTAUTH_URL:?NEXTAUTH_URL is required}"
: "${NEXT_PUBLIC_SITE_URL:?NEXT_PUBLIC_SITE_URL is required}"
: "${DOMAIN:?DOMAIN is required}"
: "${ACME_EMAIL:?ACME_EMAIL is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${GRAFANA_ADMIN_PASSWORD:?GRAFANA_ADMIN_PASSWORD is required}"

docker compose up -d --wait
