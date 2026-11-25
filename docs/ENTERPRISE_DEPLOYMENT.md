# Enterprise deployment overlay

This overlay layers the enterprise product services onto the production-scale base stack without modifying `compose.yaml`.

## Services added

- `raster`: private FastAPI/Rasterio service for GeoTIFF, NetCDF, and Zarr ZIP statistics.
- Web replicas run as PostgreSQL role `terrafield_app` so RLS policies apply to user-facing queries.
- Migrations, job worker, scheduler, and outbox worker retain the owner role because they process cross-tenant work.

## Required secrets

See `deploy/enterprise.env.example`.

- `WEBHOOK_ENCRYPTION_KEY`: 32-byte base64 or hex key. Webhook creation fails closed without it.
- `STAC_API_URL`: optional; defaults to NASA MAAP public STAC.
- `RASTER_SERVICE_URL`: set by the overlay to `http://raster:8001`.

## Commands

```bash
docker compose -f compose.yaml -f compose.enterprise.yml config
docker compose -f compose.yaml -f compose.enterprise.yml build
docker compose -f compose.yaml -f compose.enterprise.yml up -d
docker compose -f compose.yaml -f compose.enterprise.yml ps
```

Verify:

```bash
curl -fsS http://127.0.0.1:8080/api/v1/healthz
curl -fsS http://127.0.0.1:8080/api/v1/readyz
curl -fsS http://127.0.0.1:8080/api/v1/openapi.json
docker compose -f compose.yaml -f compose.enterprise.yml exec raster python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8001/health').read().decode())"
```

## RLS behavior

The migration creates `terrafield_app` with no login password. The web URL uses PostgreSQL `options=-c role=terrafield_app`; each request sets transaction-local `app.user_id` and `app.organization_id`. Policies permit public rows, personal owner rows, and active organization membership rows. Anonymous requests see only public rows.

Cross-tenant database behavior is verified by `tests/rls.integration.ts`, which switches to `terrafield_app` and asserts that foreign rows are invisible and cross-tenant writes affect zero rows.

## Operator handoff

`scripts/deploy-vps.sh` performs the host deploy used by production: it ships the source over SSH, takes a checksummed `pg_dump` of the PostgreSQL container, runs `bun install --frozen-lockfile`, Prisma generate/migrate, the production build, restarts `terrafield.service`, and gates on `/api/v1/readyz`. Any failure after the previous build was set aside restores it and restarts the service. The Compose overlay remains the alternative for a container-only deployment (`deploy/scripts/release.sh`).

Required environment variables: `VPS_HOST`, `VPS_PORT`, `VPS_USER`, `VPS_SSH_KEY`, `NEXTAUTH_SECRET`, `POSTGRES_PASSWORD`, `DOMAIN`, and `GRAFANA_ADMIN_PASSWORD`. Provide them through the platform secret mechanism, not a chat message or committed file.

## Rollback

Remove the overlay by stopping with the same two `-f` arguments and starting the base stack normally. The schema migration is additive; rolling back application images does not remove data. Do not drop the RLS migration without a reviewed backup.
