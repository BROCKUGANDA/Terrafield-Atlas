# Security audit remediation — 2026-11-26

Independent read-only review of 0.5.0 + in-flight 0.6.0 surfaces. Status after
remediation.

## High

| Finding | Status |
| --- | --- |
| H1 Self-service plan assignment could grant institutional quotas | **Fixed**: `PATCH /api/v1/billing` rejects `planCode` unless the caller is a platform administrator. |
| H2 Self-attested manual invoice settlement extended subscriptions | **Fixed**: manual bank/cash settlement is platform-admin only; customer settlement is the verified onchain path (support alone changes no entitlement). |
| H3 Tenant isolation could fail open without `TENANT_DATABASE_URL` | **Fixed**: `/api/v1/readyz` fails in production when the tenant URL is absent and asserts `current_user = terrafield_app`, not superuser, without BYPASSRLS; farm and watchlist reads now also call `canReadResource` explicitly. |

## Medium

| Finding | Status |
| --- | --- |
| M1 `apiHandler` swallowed tenant-resolution errors and continued as owner | **Fixed**: errors propagate; only mapped `AccountAccessError` return responses. |
| M2 Admin → owner privilege escalation | **Fixed**: granting/changing/suspending the owner role requires the caller to be an owner (or platform admin). Concurrency test updated (actor is an owner; two concurrent demotions still yield 200/409). |
| M3 Rate limits trusted client-controlled first XFF hop | **Fixed**: prefer `X-Real-IP`, else the last XFF hop; nginx now overwrites XFF; app is loopback-bound. |
| M4 HDX CSV first hop bypassed SSRF pinning | **Fixed**: `pinned: true` on the CSV download; every hop is validated. |
| M5 Unbounded multipart buffering before the 50 MB check | **Mitigated**: `content-length` rejected before `formData()`; Caddy caps every request body at 50 MB; nginx caps at 2 MB. Chunked bodies remain bounded by the proxy cap. |
| M6 Public market query could materialise 100k rows | **Mitigated**: row cap 20,000, 120/min per client; series remains honest about truncation. |

## Low (fixed)

- L1 password reset invalidates existing JWTs (`sessionVersion` claim).
- L2 onchain settlement uses a module-private branded capability; the public settle route rejects `onchain`.
- L3 native payments via the support contract verify the `Support` event; direct-to-treasury also accepted.
- L4 malformed `Transfer` logs are treated as non-matches.
- L5 invoice-linked intents are admin-only and require ≥6 confirmations.
- L6 CSV exports neutralize formula injection.
- L7 storage quota now sums metered `UsageEvent` rows.
- L9 idempotency is scoped per organization and includes the org in the hash.
- L10 OAuth throttle keyed by client **and** source IP.
- L11 public system diagnostics rate-limited (60/min).
- L12 metrics rejects forwarded public addresses in-app, not only at Caddy.
- L13 capability checks removed from API-key/webhook/OAuth/developer request paths; core features are free.
- L15 Zarr extraction caps uncompressed bytes and per-member size.

## Documented residual risk

- L5 reorg reconciliation after recording is not implemented; support-only
  payments grant nothing, and invoice-linked actions are admin-only with ≥6
  confirmations.
- L8 entitlement checks are serialized per tenant/metric in-process
  (`withQuotaGuard`) for job creation and report persistence, removing the
  concurrent-request overshoot in the single-web-process deployment. A
  multi-instance deployment must add a database advisory lock; jobs are still
  metered only on success.
- CSP keeps `'unsafe-inline'` for scripts because the console is statically
  rendered; a nonce policy requires dynamic rendering.
- RPC verification trusts the configured JSON-RPC provider; use a reputable
  endpoint and the confirmation floor.

## Verified-and-rejected (no action)

- `x-terrafield-organization` is re-validated against active membership.
- Developer routes run inside an explicit principal tenant context; API-key and
  OAuth membership/scope checks are enforced.
- OAuth secrets/tokens are SHA-256 hashed and compared in constant time.
- Account deletion, invitation acceptance and API-key revocation perform
  explicit authorization before owner-connection writes.
- Webhook SSRF, signing, non-redirecting delivery and secret encryption remain
  correct.
- Provider provenance redacts credentials; private calls store no URL.
