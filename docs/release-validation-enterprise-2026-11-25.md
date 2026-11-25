# Enterprise product layer validation — 2026-11-25

## Scope

This report covers the enterprise/product work added alongside the concurrent production-scale reliability work. It is not a production deployment certificate.

## Verified locally

- PostgreSQL migration chain from an empty database: 4 migrations applied successfully; redeploy reported no pending migrations; `migrate diff` reported no schema drift.
- `bun run typecheck`: pass.
- `bun run lint`: 0 errors, 16 warnings.
- `bun test --max-concurrency=2 tests src/components/three/live-globe-events.test.ts` with isolated PostGIS 16/Redis 7: 301 tests pass, 0 fail, 1,593 assertions.
- `bun audit --audit-level=high`: no vulnerabilities found across 781 packages after upgrades and narrow overrides.
- `bun run build`: pass on Next.js 16.4.6; 67 pages/routes generated; standalone assets copied.
- Python raster service: 3 unit tests pass for nodata-aware statistics, clipping/reprojection/resampling, and invalid-input rejection.
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

- Database-enforced row-level security is not implemented; tenant isolation is enforced in application code and tested there.
- PDF remains browser print-to-PDF; server PDF generation is not implemented.
- Raster processing supports GeoTIFF statistics; NetCDF/Zarr and derived-asset persistence are deferred.
- Payment settlement, OAuth for the public API, full localization, and market feeds are not implemented.
- No production deployment, live email/webhook receiver, or cross-browser acceptance run was performed in this pass.
- Build emits Edge-runtime warnings for `instrumentation.ts` process handlers; the Node runtime path remains functional.

## Addendum — release blockers follow-up

- PostgreSQL RLS migration and tenant proxy added; three DB-level isolation tests pass.
- Server-side PDF endpoint and NetCDF/Zarr dataset endpoint added; six Python service tests pass.
- Enterprise Compose overlay and environment template added.
- Dependency audit remains clean after adding PDFKit (0 high/critical across 794 packages).
- Production browser/failure-mode harnesses were executed against the built artifact; functional checks passed intermittently while shared Docker PostgreSQL instances were disrupted by concurrent migrations. Rerun on a stable dedicated environment remains a release gate.

## Release decision

The enterprise product layer is functionally complete and locally verified. It is not a full production release until database RLS, deployment of new services/secrets, and browser/failure-mode acceptance are complete.
