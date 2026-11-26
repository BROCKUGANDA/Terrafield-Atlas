# TerraField Atlas 0.6.0 — release validation (2026-11-26)

Production: https://terrafieldatlas.us · VPS `57.130.80.158` · release `/mnt/terrafield/releases/20261126T042109Z`.

## Local gates

- `bun run typecheck`: pass.
- `bun run lint`: 0 errors, 0 warnings.
- `bun test tests/ --timeout 120000 --max-concurrency=4`: pass (see final count in the release ledger; 357 tests / 0 failures on the security-hardening run).
- `bun run build`: pass.
- `bun audit --audit-level=high`: 0 vulnerabilities / 794 packages; Dependabot open alerts: 0.
- **RLS-mode suites** (`TENANT_RLS_TEST=1`): account, enterprise, enterprise product, OAuth, billing — **5/5 pass**.
- **Mutation testing**: `bun run test:mutation` → **31/31 mutants detected (100%)**: i18n (5), HDX/market (11), rotation engine (10), retention (2), onchain rules (2), invoice amount equality (1).
- **Contract**: `contracts/TerraFieldSupport.sol` compiles against `@openzeppelin/contracts@5.6.1` with solc 0.8.39; ABI committed; compile test passes.

## Lighthouse (mobile, throttled, production)

| Metric | Before (0.5.0) | Final (0.6.0) |
| --- | --- | --- |
| Performance | 26 | **59** |
| Accessibility | 96 | 96 |
| Best practices | 100 | 100 |
| SEO | 100 | 100 |
| LCP | 5.1 s | **4.2 s** |
| TBT | 4,460 ms | **820 ms** |
| CLS | 0.338 | **0.003** |
| Speed Index | 6.3 s | 5.5 s |
| Main-thread work | 35.3 s | ~7 s |
| JS bootup | 22.9 s | ~3 s |

Fixes: three.js globe code-split, mounted on idle and only on wide screens
(static orbit fallback + explicit render button on mobile), renderer paused
off-screen/hidden, DPR capped at 1.5, MSAA off on high-DPI; hero animations no
longer gate LCP; consent notice is a fixed overlay; command bar no longer wraps
as live chips change width; display fonts use `display: optional` so slow links
keep the metric-adjusted fallback.

## Security remediation (audit 2026-11-26)

All High/Medium findings from the independent review were fixed or reduced to a
documented mitigation; details in `docs/SECURITY_AUDIT_2026-11-26.md`:

- plan self-assignment blocked (admin-only), manual invoice settlement admin-only;
- fail-closed tenant resolution; readiness asserts `terrafield_app` without
  SUPERUSER/BYPASSRLS; production without `TENANT_DATABASE_URL` is not ready;
- explicit resource checks on farm/watchlist reads;
- owner-only role changes (admin→owner escalation closed);
- tenant-scoped idempotency keys + org in the request hash;
- proxy-IP trust fixed; OAuth throttle keyed by client+IP; public diagnostics
  rate-limited;
- HDX first-hop pinned (SSRF); raster content-length precheck; Caddy 50 MB body
  cap; Zarr uncompressed-size caps; CSV formula injection neutralized; storage
  quota metering enforced; password resets invalidate JWTs;
- app bound to `127.0.0.1:3011`; public `:3011` now times out; monitoring moved
  to host-network loopback; public metrics 403 at the edge and in-app.

## Kong (decK + Kong 3.9)

`deck file validate` exits 0 on `deploy/kong/terrafield-openapi.yaml`; a DB-less
Kong instance routed `POST /oauth/token` and `GET /developer/farms`, returning
the application's 401s with `X-RateLimit-*` headers. No production traffic goes
through Kong.

## Deploy and live verification

- Release `20261125T232727Z`; migrations through `20261129010000_session_version`.
- `/api/v1/readyz`: `ready`, including `tenantRole: request queries run as terrafield_app without RLS bypass`.
- `/api/v1/billing/onchain/config`: `enabled:false` with `missing` env names —
  honest until an operator supplies `ONCHAIN_*`; no fake provider.
- `/api/v1/metrics`: 403; `/api/v1/healthz`: ok; CSP enforced; HSTS preload,
  CORP and Permissions-Policy served.
- Prometheus target `http://127.0.0.1:3011/api/v1/metrics` is up; Grafana 200 on
  `127.0.0.1:33001`.
- Account page serves English/Kiswahili switcher; Swahili dictionary reviewed and
  parity-tested.

## Remaining

- Onchain support is **disabled in production until configured**: set
  `ONCHAIN_RPC_URL`, `ONCHAIN_CHAIN_ID`, `ONCHAIN_TREASURY`, and
  `ONCHAIN_TOKEN_ADDRESS` (or `native`), optionally `ONCHAIN_SUPPORT_CONTRACT`,
  then deploy the contract and restart. No keys are held by the server.
- Lighthouse mobile performance is 59: LCP remains network-bound (~4.2 s on
  simulated slow 4G); framer-motion was removed from the initial bundle and the
  globe is deferred, but React/Next and remaining UI libraries still dominate.
- Manual settlement remains operator-only; no fiat/card processor.
- Localization covers navigation/account/marketing entry; scientific and
  provider copy stays English by policy.
- Mutation targets remain an explicit high-value subset (now including retention, onchain rules and invoice settlement), not whole-repo.
- Kong config is an artifact/smoke test, not the production path.
