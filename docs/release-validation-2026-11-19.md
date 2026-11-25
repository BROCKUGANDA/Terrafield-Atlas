# Public demo hardening — 2026-11-19

Deployed to https://terrafieldatlas.us; previous production build retained at
`/home/ubuntu/ai-azimara-terrafield/.next.before-polish-20261119` and original source
in `source-before-polish-20261119.tar.gz`. No production database migration or reset.

## Verified

- `bun test tests src/components/three/live-globe-events.test.ts`: 179 passing tests.
- Targeted ESLint and `git diff --check`: pass. VPS `next build --webpack`: pass.
- Live `tests/responsive-browser.cjs`: Edge, Firefox and WebKit pass at widths
  360, 390, 768, 1024 and 1440 for landing; 360, 768 and 1024 for Explorer.
  Checks include overflow, mobile navigation, visible map, uncaught errors,
  server-rendered reference content, HttpOnly cookie, Secure on HTTPS, explicit
  SameSite=Strict response and functional cross-site cookie withholding.
  Windows WebKit reports inaccurate SameSite cookie metadata, so the test
  verifies actual response headers and browser cross-site behavior instead.
- Live `tests/console-browser.cjs`: all sidebar modules, browser history,
  coordinate/date guards, Explorer and mobile navigation pass.
- Live globe: canvas visible, eight sourced NASA EONET positions mapped, event
  timestamps and provenance accessible. Three marker unit tests cover geographic
  orientation, invalid coordinates, replacement and GPU disposal.
- POWER local integration: two-year daily ingestion, all seven requested
  variables, 5,117 valid observations. Separate one-variable repeat ingestion
  returned zero duplicate rows. These runs used the local database.
- Live fire integration: one-day historical GIBS ingestion at -3.375, 3.375
  completed; tile data available, zero detections in the small queried bbox.
  Zero detections is not evidence that fires do not exist elsewhere.
- Provider health errors reproduced before correction; SoilGrids standard
  response parsing and empty-profile bugs reproduced before correction.

## Operation and remaining limits

- Sessions are anonymous public-demo sessions, **not authentication or private
  tenant isolation**. Signed cookie expiry and client callsign expiry are eight
  hours. No analytics/advertising cookies were introduced. Existing local
  preferences/drafts remain on the device after sign-out, as disclosed.
  Set a stable `SESSION_SECRET` in the deployment environment for cookie
  continuity across restarts; otherwise a process restart invalidates cookies.
- Globe updates poll every 60 seconds; EONET has a 15-minute server cache and
  curated event-reporting delays. This is not a real-time fire-detection stream.
- Latest VPS health sample: POWER, GIBS imagery, EONET and FIRMS host responded
  successfully. Sampled recent GIBS fire tile returned 404 (degraded); SoilGrids
  timed out (unreachable). Provider success is not guaranteed by this release.
  FIRMS host reachability does not verify authenticated FIRMS ingestion.
- SoilGrids parser now consumes `depths[].values.mean`, honors `d_factor`,
  preserves zero and rejects empty profiles. New nitrogen storage uses g/kg ×
  1,000 for mg/kg. Historical saved soil tests were not rewritten; review and
  re-ingest old modelled profiles where appropriate.
- Production configuration already bypasses TypeScript build validation;
  full type checking has existing project-wide failures. A successful build
  is not a claim of clean types.
- Existing crop-catalogue initialization can log a concurrent unique-key race
  locally. This was not changed in this scoped release.
- Server-rendered `/about`, canonical metadata, sitemap and robots support
  search/answer engines; rankings, crawler indexing, GEO/AEO inclusion and
  hackathon results cannot be guaranteed. Console modules load on demand and
  hydrate client-side; not every interactive module has a separate crawlable URL.
- Automated browser engines are not physical iOS/Android device certification.
  No exhaustive certification of every farm/report/notification integration or
  external email/webhook delivery was performed.