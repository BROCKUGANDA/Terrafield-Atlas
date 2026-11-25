# Enterprise product layer validation — 2026-11-25

## Scope

This report covers the enterprise/product work added alongside the concurrent production-scale reliability work. It is not a production deployment certificate.

## Verified locally

- PostgreSQL migration chain from an empty database: 7 migrations applied successfully; redeploy reported no pending migrations; `migrate diff` reported no schema drift.
- `bun run typecheck`: pass.
- `bun run lint`: 0 errors, 24 warnings.
- `bun test --max-concurrency=1 tests src/components/three/live-globe-events.test.ts` with isolated PostGIS 16/Redis 7: 313 tests pass, 0 fail, 1,635 assertions.
- `bun audit --audit-level=high`: no vulnerabilities found across 794 packages.
- `bun run build`: pass on Next.js 16.4.6; 70 pages/routes generated; standalone assets copied.
- Python raster service: 7 unit tests pass for GeoTIFF/NetCDF/Zarr processing and artifact persistence.
- Live NASA MAAP STAC item search: one real forest-cover item returned with four asset references.
- Enterprise integration suite: organizations, cross-tenant denial, roles, quotas, API keys, signed webhooks, report persistence/CSV, admin flags, and intelligence approvals pass.

## Dependency changes

- Next.js 16.1.3 → 16.4.6
- next-auth 4.24.13 → 4.24.15
- zod 4.3.5 → 4.6.7
- sharp 0.34.5 → 0.35.5
- Prisma client/CLI 6.19.2 → 6.19.3
- Removed unused `@mdxeditor/editor`
- Applied in-range transitive fixes and narrow overrides for `deepmerge-ts` and `effect` in Prisma CLI config

## Known limitations

- Database-enforced row-level security is implemented and tested; production web replicas must use the `terrafield_app` role through the overlay.
- PDF is available server-side and through browser print; CSV and JSON exports are also persisted.
- Raster processing supports GeoTIFF, NetCDF, and Zarr statistics with derived-asset records; retention and off-host replication remain deployment policy.
- Payment settlement, OAuth for the public API, full localization, and market feeds are not implemented.
- Production browser and failure-mode acceptance were rerun on the stable acceptance stack and passed; earlier intermittent failures were caused by shared Docker database disruption and harness timing, not application assertions.
- Build emits Edge-runtime warnings for `instrumentation.ts` process handlers; the Node runtime path remains functional.

## Addendum — release blockers follow-up

- PostgreSQL RLS migration and tenant proxy added; three DB-level isolation tests pass.
- Production browser acceptance passed on the stable acceptance stack: Edge 90/90, Firefox 90/90, WebKit 90/90 module/viewport checks, 1,152 assertions, 0 failures.
- Failure-mode browser acceptance passed all five executed checks; authenticated create/edit/delete was skipped because no test account credentials were supplied.
- Derived raster assets now persist to a private artifact volume with a `RasterAsset` database record.
- Enterprise Compose overlay and environment template added.
- Dependency audit remains clean after adding PDFKit (0 high/critical across 794 packages).
- Production browser/failure-mode harnesses passed against the built stable artifact; no physical-device or external-provider availability guarantee is claimed.
- Continued pass: enterprise overlay `config` validates; raster 7 Python tests pass; RLS + enterprise integration wrappers pass; production deployment still awaiting operator credentials (secret service unreachable), legal sign-off still outstanding.

## Release decision

The enterprise product layer is functionally complete and locally verified. It is not a full production release until the overlay and secrets are applied in the real environment and qualified legal sign-off is obtained.
