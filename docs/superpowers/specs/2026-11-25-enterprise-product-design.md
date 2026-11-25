# TerraField Atlas — Enterprise Product Layer Design

Date: 2026-11-25

## Goal

Add the commercial and institutional capabilities required to turn the existing verified-account application into a cooperative/enterprise platform without breaking personal accounts or the established mission-console design language.

This design extends `docs/superpowers/specs/2026-11-24-production-scale-design.md`.

## Architecture decisions

### Additive tenancy

- `AccountUser.ownerId` remains the creator/owner of existing records.
- `Organization` adds a shared tenant boundary.
- `Membership` binds a verified user to an organization with a validated role.
- `Workspace` groups farms inside an organization.
- `Farm.organizationId` and `Farm.workspaceId` are nullable for backward compatibility.
- Requests select an organization with `X-Terrafield-Organization`; the server verifies active membership on every request.
- Public seeded records remain readable and immutable.
- Personal workspaces continue to work without an organization header.

### Domain modules

1. **Identity/tenancy:** organizations, invitations, memberships, roles, workspaces.
2. **Commercial:** configurable plans, subscriptions, entitlements, usage events.
3. **Developer platform:** hashed API keys, scopes, versioned read/write resources, signed webhooks.
4. **Intelligence:** typed tool registry, deterministic query planner, agent runs, approvals, evidence references.
5. **Source governance:** structured source registry and STAC discovery.
6. **Administration:** protected overview, feature flags, users, organizations, jobs, sources, audit.

No new microservice is introduced unless a workload requires it. The raster service is the only planned separate compute domain because geospatial array processing should not run in request handlers.

## Permission model

Roles:

- `owner`: full organization control, billing, membership, API keys, webhooks.
- `admin`: organization operations and member management; cannot delete the organization.
- `analyst`: read portfolio, run analyses, create reports.
- `agronomist`: read portfolio, manage farms/soil/crop plans.
- `researcher`: read portfolio and evidence, export approved data.
- `field_officer`: read assigned portfolio, create field observations.
- `viewer`: read-only.
- `api_service`: API-key-only machine identity; scopes are explicit.

Permissions are derived server-side from role plus API-key scopes. UI visibility is convenience only.

Minimum permission matrix:

| Capability | owner | admin | analyst | agronomist | researcher | field_officer | viewer | api_service |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Read organization portfolio | yes | yes | yes | yes | yes | assigned | yes | scoped |
| Manage farms/soil | yes | yes | no | yes | no | field data | no | scoped |
| Run analyses | yes | yes | yes | yes | yes | no | no | scoped |
| Manage members | yes | yes | no | no | no | no | no | no |
| Manage billing | yes | no | no | no | no | no | no | no |
| Manage API keys/webhooks | yes | yes | no | no | no | no | no | no |
| Platform administration | no | no | no | no | no | no | no | no |

Platform super administration remains the existing `AccountUser.isAdmin` capability.

## Commercial model

- `Plan` rows are database configuration, not hardcoded price tiers.
- `Subscription` references a plan and an organization or personal account.
- Entitlements are a validated JSON map containing numeric limits and boolean capabilities.
- Default plans: Explorer, Professional, Cooperative, Enterprise, Institutional.
- No payment provider is assumed. `paymentProvider` and `providerReference` are replaceable fields.
- Usage is recorded only after successful fulfillment for job-based operations.
- Server-side entitlement checks happen before enqueue; metering happens in the terminal job transaction.
- Failed/cancelled operations are not billed.

Initial metrics:

- `farms`
- `processing_jobs`
- `api_requests`
- `reports`
- `ai_runs`
- `storage_mb`

## Developer platform

- API keys are shown once, stored only as SHA-256 hashes, and carry a short display prefix.
- Keys have scopes, optional expiry, revocation, last-use tracking, and organization/personal ownership.
- Versioned developer resources live under `/api/v1/developer/*` and reuse the same domain services.
- Every response has correlation IDs and stable error codes.
- OpenAPI is served from `/api/v1/openapi.json`.
- Webhooks use AES-GCM-encrypted signing secrets, HTTPS in production, SSRF guards, stable event IDs, exponential retry, and durable delivery records.
- The transactional outbox is the source of truth; Redis is transport only.

## Intelligence architecture

The intelligence layer is evidence-first and does not depend on an opaque chatbot.

- `AgentRun` stores query, validated plan, status, approvals, result, and evidence.
- `ToolExecution` stores typed tool name, validated input, permission decision, output reference, and timing.
- Specialized roles are implemented as tool allowlists:
  - Atlas Researcher: source discovery.
  - GeoSpatial Analyst: farm/portfolio spatial summaries.
  - Climate Analyst: stored-observation trends/anomalies.
  - Agronomy Analyst: crop/soil/rotation comparison.
  - Risk Analyst: fire exposure summaries.
  - Evidence Auditor: provenance/unit/coverage checks.
  - Report Composer: approved analytical outputs only.
  - Workflow Orchestrator: dependency-ordered execution.
- Natural-language input is translated into a validated plan before execution.
- Unsupported or ambiguous queries return clarifying limitations, not invented observations.
- Consequential actions require explicit human approval.
- Retrieved/provider content is treated as untrusted data and never interpreted as instructions.

## Source governance

Extend the source register with:

- provider, dataset identifier, product version, license, attribution;
- access conditions, API limits, spatial/temporal coverage;
- native resolution, units, quality metadata;
- processing history, retrieval timestamp, known limitations;
- STAC collection/API identifiers where supported.

STAC discovery proxies a configured provider endpoint with geometry/date/collection filters, bounded result counts, accessibility validation, and cached metadata. No global dataset download is permitted for a small query.

## Data flow examples

### Cooperative creates a shared farm

1. Verified user creates an organization and becomes `owner`.
2. User invites members; invitations create pending memberships.
3. Owner selects the organization header and creates a workspace.
4. Owner creates a farm with `organizationId` and `workspaceId`.
5. API guard verifies `farm.write`; the farm creator remains `ownerId`.
6. Organization members with read permission can query the farm and its observations.
7. Audit and outbox records include organization attribution.

### Analyst runs a metered trend job

1. Request selects an organization; server verifies membership and `analysis.run`.
2. Entitlement service checks monthly processing quota.
3. Durable job row, outbox event, and idempotency record commit atomically.
4. Worker executes against organization-authorized stored observations.
5. Terminal transaction stores results and one successful `processing_jobs` usage event.
6. Failed/cancelled jobs record no billable usage.

### Developer receives a webhook

1. Organization admin creates an endpoint and event allowlist.
2. Signing secret is generated and shown once; only ciphertext is persisted.
3. Domain transaction writes an outbox event.
4. Delivery worker signs the exact JSON bytes and posts with timeout/no redirects.
5. Delivery status and attempts are durable and visible to the organization.

## Security requirements

- Runtime validation on every body, query, header, and path parameter.
- Same-origin checks for cookie-authenticated mutations.
- API-key authentication is bearer-based and does not use cookies.
- Tenant scope is resolved server-side and included in every query.
- Cross-tenant tests must cover direct IDs, duplicate query parameters, forged organization headers, and API keys from another organization.
- Webhook URLs reject loopback/private/link-local/metadata targets and revalidate DNS/redirects.
- Secrets are never returned after creation or written to logs.
- Database-level RLS remains a release blocker; this layer does not claim it is complete.

## Testing and acceptance

- Unit: permission matrix, entitlement calculations, metering, API-key hashing, webhook signing/SSRF, plan validation, tool contracts.
- Integration: organization invitations, cross-tenant denial, shared farm reads, quota enforcement, successful-only usage, API-key scopes, outbox delivery.
- End-to-end: cooperative onboarding → invite → farm → coverage → analysis → report → export.
- Security: forged organization headers, foreign farm/watchlist/job IDs, revoked/expired keys, malicious webhook URLs, replayed events.
- Release: migrations from the current schema, full test suite, typecheck, lint, production build, browser smoke.

## Out of scope for this layer

- Real payment settlement without a selected provider.
- Fabricated market prices or production estimates.
- Autonomous consequential agricultural/financial decisions.
- Claiming scientific accuracy, certification, or NASA endorsement.
- Replacing the existing visual identity.
