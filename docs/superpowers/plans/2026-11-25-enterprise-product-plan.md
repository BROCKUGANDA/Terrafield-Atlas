# Enterprise Product Layer Implementation Plan

Date: 2026-11-25

**Spec:** `docs/superpowers/specs/2026-11-25-enterprise-product-design.md`
**Foundation:** `docs/superpowers/plans/2026-11-24-production-scale-plan.md`

## Global constraints

- Preserve personal-account and public-demo behavior.
- No provider call inside a transaction.
- Every mutation is validated, authorized, idempotent where retryable, and audit/outbox-backed.
- Do not return secrets after creation.
- Do not mark a feature complete without test evidence.
- Do not claim database RLS, payment settlement, or external delivery certification until verified.

## Steps

- [x] 1. Repair durable-job client/server/test contract and worker startup.
- [x] 2. Add organization, membership, workspace, plan, subscription, usage, API-key, webhook, agent, evidence, feature-flag, and report models with an additive PostgreSQL migration.
- [x] 3. Implement server-side tenant context, role permissions, organization-aware resource guards, and cross-tenant integration tests.
- [x] 4. Add organization/workspace APIs and a cooperative portfolio UI using existing design tokens and glyphs.
- [x] 5. Add configurable plans, subscription status, entitlements, successful-operation usage metering, and billing/usage APIs/UI.
- [x] 6. Add managed API keys, scoped developer resources, OpenAPI, rate/quota headers, and key-management UI.
- [x] 7. Add tenant-managed signed webhooks and durable outbox dispatch with SSRF protection and delivery history.
- [x] 8. Add typed intelligence tool contracts, validated query plans, agent runs, approval gates, evidence references, and an Intelligence workspace.
- [x] 9. Extend the source registry and add bounded STAC discovery with asset accessibility checks.
- [x] 10. Add protected platform administration and feature flags.
- [x] 11. Add functional marketing, pricing, API, research, contact, privacy, and terms surfaces.
- [x] 12. Persist report artifacts and add CSV/server-PDF pathways. JSON snapshots, server CSV, and server PDF are implemented; browser print-to-PDF remains as a fallback.
- [x] 13. Add a validated raster-processing service for quantitative GeoTIFF/NetCDF workflows. Six Python tests pass; derived-asset persistence is tracked separately.
- [ ] 14. Run migration-upgrade, unit, integration, security, build, and browser acceptance; update the implementation ledger and known limitations. Migration, unit, integration, dependency audit, typecheck, lint, and build pass; browser/acceptance and production deployment remain.

## Execution order

1. Steps 1–3 establish correctness and tenant boundaries.
2. Steps 4–7 make the product commercially enforceable.
3. Steps 8–10 add institutional intelligence and operations.
4. Steps 11–13 complete customer-facing surfaces and science infrastructure.
5. Step 14 is the release gate; incomplete steps remain explicitly open.
