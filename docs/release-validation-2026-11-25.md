# Production scale release validation — 2026-11-25

## Verdict

The production-scale implementation is complete and verified against the built artifact. No commits or pushes were made.

## Artifact

- Image `terrafield-atlas:latest`, ID `0abd0e8048b8`, digest `sha256:0abd0e8048b85122d21112d1f7828cef9bfdb3603956fba9a7236c0a030b44ba`.
- Base commit `9f319191a3b0c557618020e1a6a9a6a63b808659`; all implementation remained in the working tree.
- Production image build passed with 69 generated route entries.

## Quality gates

| Gate | Result |
| --- | --- |
| Build | Passed |
| Typecheck | Passed |
| Full lint | Passed with 0 errors (24 pre-existing/concurrent warnings) |
| Task 6 durable jobs | 7/7, 69 assertions |
| Task 7 replica safety/delivery | 6/6, 33 assertions |
| Task 8 client transport/context | 8/8, 18 assertions |
| Task 9 UI regressions | 10/10, 23 assertions |
| Task 10 deployment config | 6/6, 38 assertions |
| Production browser matrix | 270/270 checks, 1,152 assertions |
| Failure-mode browser | 5/5 executed checks |
| Backup + restore drill | Passed |

## Production stack evidence

The fresh Compose stack started with empty PostgreSQL and Redis volumes. All four migrations applied, the production baseline seeded, worker/scheduler/outbox heartbeats became healthy, Caddy became healthy, and readiness returned `ready`. Private web metrics exposed Prometheus data; Caddy denied public `/api/v1/metrics` with HTTP 403.

Browser acceptance covered Edge, Firefox and WebKit at 320, 375, 390, 768, 1024 and 1440 widths across all 15 console modules. The failure-mode suite verified anonymous denial, offline recovery and retry, rejection of a delayed stale location response, visible provider degradation, and durable queue failure handling. A named `pg_dump -Fc` artifact was checksummed, restored into a disposable database, validated and dropped.

## Skips and limitations

- Authenticated browser create/edit/delete was skipped because no test account credentials were supplied. Verified-write behaviour is covered by API integration tests.
- Physical-device certification and external-provider availability were not claimed.
- Windows Docker Desktop returned an empty body through Caddy's published host port; a local-only Compose override exposed the web replicas for browser automation. Caddy's private-network routing and metrics denial were validated directly.
- One full-suite run under heavy concurrent activity was invalidated by a Bun segfault; the focused gates above were rerun and are green.

## Operational notes

Deployment requires `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `NEXT_PUBLIC_SITE_URL`, `POSTGRES_PASSWORD`, `DOMAIN`, `ACME_EMAIL` and `GRAFANA_ADMIN_PASSWORD`. Databases, Redis and monitoring remain on private networks; Caddy is the sole public listener. Releases use `deploy/scripts/release.sh` with named backup and readiness-gated rollback.
