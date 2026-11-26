# TerraField Atlas 0.6.0 — release notes (2026-11-26)

## Freemium, not a paywall

- Every product capability is free on every plan: organizations, workspaces,
  API keys, OAuth clients, webhooks, reports, analyses, markets and intelligence.
  `capabilities` now default to true for all plans; capability checks were
  removed from the API-key, webhook, OAuth and developer request paths.
- Plans differ only in cost-bearing quotas (jobs, AI runs, stored MB, API
  requests) where a provider charges TerraField.
- **No self-service plan escalation.** `PATCH /api/v1/billing` rejects plan
  assignment unless the caller is a platform administrator; cancel/resume stay
  self-service.
- **No self-attested settlement.** Manual bank/cash invoice settlement is an
  administrator-only record after an off-platform payment.

## Onchain support (OpenZeppelin)

- `contracts/TerraFieldSupport.sol`: OpenZeppelin `Ownable`,
  `ReentrancyGuard`, `SafeERC20`; native and ERC20 support forwarded to the
  treasury in the same transaction; `Support` event with payer/token/amount/memo;
  no fees, no custody, no upgradeability.
- `scripts/compile-contract.mjs` compiles against `@openzeppelin/contracts`
  5.6.1 and writes the ABI; a test asserts the compiled surface.
- Server-verified support intents: exact token/chain/recipient/amount,
  confirmation depth, duplicate-tx rejection, concurrent verification yields one
  payment, native direct and contract-event paths, malformed logs treated as
  non-matches. RPC URL never leaves the server.
- Invoice-linked intents are platform-admin only and use at least six
  confirmations; support alone changes no entitlement.
- Billing UI adds the support card with address/amount/memo copy and tx
  verification; docs in `docs/ONCHAIN_PAYMENTS.md`.

## Security audit remediation

- Fail-closed tenant resolution (no owner fallback when tenant lookup fails).
- `/api/v1/readyz` asserts the tenant connection is `terrafield_app`, not
  superuser, without BYPASSRLS; production without `TENANT_DATABASE_URL` is not
  ready.
- Explicit `canReadResource` checks on farm and watchlist reads in addition to
  RLS.
- Admin → owner privilege escalation blocked; owner-only role changes.
- Idempotency keys scoped by organization and organization included in the
  request hash.
- Rate limits prefer proxy-set `X-Real-IP` / last XFF hop; OAuth token throttle
  keyed by client **and** source IP; public diagnostics rate-limited.
- HDX CSV downloads pinned on the first hop (SSRF); raster uploads check
  `content-length` before buffering; Caddy caps request bodies at 50 MB; Zarr
  extraction caps uncompressed size; CSV report export neutralizes formula
  injection; storage quota metering is enforced.
- Password resets increment a session version, invalidating previously issued
  JWTs.
- Dead context-mutating helper removed.

## Quotas and availability

- Concurrent job/report creation is serialized per tenant before the entitlement check, closing the single-process check-then-act overshoot.

## Availability and performance

- App binds `127.0.0.1:3011`; only Caddy and host-network Prometheus can reach
  it. Public `:3011` is closed.
- Prometheus/Grafana moved to host networking on loopback (9090 / 33001).
- Landing hero globe is code-split and mounted on idle; globe rendering pauses
  off-screen/hidden, caps DPR at 1.5 and disables MSAA on high-DPI screens.
- Consent/privacy notice is a fixed overlay, removing the largest layout shift.
- Mutation testing: `bun run test:mutation` — 31/31 mutants detected (100%) across
i18n, markets, rotation, retention, onchain rules and invoice settlement.
- Kong: decK-validated declarative config (`deploy/kong`) and a DB-less Kong
  smoke test through the gateway (`docs/API_GATEWAY.md`).

## Localization accuracy

- Full Swahili review: corrected naturalness and product meaning across
  navigation, landing, account, invitations and errors; account form fully
  localized; dictionary parity, placeholder parity and untranslated-key policy
  enforced by tests.

## Verification

357 tests / 0 failures, typecheck, lint, production build, RLS-mode suites,
onchain suite, mutation run; Lighthouse mobile 59/96/100/100, LCP 4.2 s,
TBT 820 ms, CLS 0.003
(`docs/release-validation-0.6.0.md`).
