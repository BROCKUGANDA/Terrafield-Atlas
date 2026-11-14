# Task: planning-trust-retheme — Planning & Trust Views Mission-Grade Re-Theme

**Agent:** code-agent (Z.ai Code)
**Task ID:** T2-planning-trust-retheme
**Date:** 2026-11-14 04:25 UTC
**Scope files (exclusively owned):**
- `src/components/views/farm-workspace.tsx`
- `src/components/views/rotation-planner.tsx`
- `src/components/views/reports.tsx`
- `src/components/views/provenance.tsx`
- `src/components/views/settings.tsx`

Read-only references used: `ui-mc/kit.tsx`, `system/query-state.tsx`,
`system/skeletons.tsx`, `state/store.ts`, `lib/api-client.ts`,
`views-retheme-code-agent.md` (parallel agent's record — see /agent-ctx),
`charts/scientific-charts.tsx` (imported unchanged: `RainfallProfileChart`).

## What was done

Re-themed the five planning/trust views to the NASA mission-console design system:
`SectionHeader` (kicker + title + description + actions) on every view, `hud`/`hud-calm`
panels replacing all Card/slate look, `text-ink/dim/faint`, `border-edge`, `bg-panel`,
primary actions = default Button (NASA red), semantics: signal=measured/good,
caution=missing/modeled, crit=errors/incompatible, aqua=water/climate, iris=neutral,
`.mc-table` tables with sticky `bg-panel` heads and max-h scroll, mono uppercase
pending labels with blink dots, framer-motion staggered section entrances
(`variants` resolver, y 12→0, 0.35 s, 60 ms stagger, `whileInView` + `viewport once`,
global `MotionConfig reducedMotion="user"` respected upstream).

### Data-logic invariants (verified preserved)
- Every `useQuery`/`useMutation` queryKey, queryFn, mutationFn, toast text,
  invalidation, `enabled` gating, store selector/action, validation rule and
  disabled rule is byte-equivalent to the pre-retheme code.
- Honesty/methodology copy preserved verbatim: source-hierarchy note, "never mixed
  with modeled values", SoilGrids "model estimates" wording, deterministic-engine
  copy ("weights normalised server-side; versioned"), "Every scenario needs at least
  one crop", rainfall-evidence caption, report compiler copy + all 7 report sections +
  limitations + footer, "Every external request … success or failure" framing,
  reliability/failed-jobs copy, methodology pointers. No yields/profit language added.
- `api.*` call semantics and `src/lib/**` untouched. No new routes, no new deps.

### States added per view
- **farm-workspace**: farms query → SkeletonPanel / FaultPanel(refetch) / EmptyState
  (registry empty); farm query → SkeletonPanel "Reading farm profile" / FaultPanel
  (refetch); no-active-farm EmptyState with real action (open explorer); boundary
  drawing flow elevated — live "boundary in session · N vertices" caution chip +
  save/draw buttons (disabled rules kept); profile TelemetryStat row (observations,
  soil tests, scenarios, area) + mono centroid/boundary rows; soil section: caution
  source-hierarchy note, mc-table ledger with source pills (lab/farmer=signal
  MEASURED, soilgrids=caution MODELED), modeled rows tinted `bg-caution/5` with
  caution-toned numerals, soil-tests EmptyState whose action is the real SoilGrids
  fetch; all forms (create farm, crop history, soil test) keep validation behavior
  with themed inputs/selects; crop-history entries list max-h-96 scroll.
- **rotation-planner (flagship)**: no-farm EmptyState + "Set up a farm first";
  catalogue chip in SectionHeader actions (LoadingChip while loading, "catalogue
  fault" on error); builder HudPanel — scenario tabs (NASA active state), sequence
  chips with family-color borders (cereal=caution, legume=signal, root-tuber=aqua,
  oilseed=iris, fiber=nasa, vegetable=signal) + numbered mono indices + aria-labeled
  removes; native `<select>` replaced by themed shadcn Select (same value semantics);
  priorities sliders (themed tokens) with mono labels/values; compare button NASA-red
  with mono pending + disabled rules kept; **results**: SweepLoader while scoring,
  FaultPanel(mutate retry) on failure, ranking as Accordion of scenario rows with
  big mono rank numerals (`01`…, rank-1 NASA glow), animated framer-motion gradient
  bars (score: `from-nasa to-signal`; confidence: `from-signal to-aqua`), crit
  "N incompatible" + caution "N missing inputs" chips, rule-version mono chip;
  expanded detail: incompatible rules as crit chips+details, missing-information
  caution list ("confidence lowered, not fabricated"), per-criterion factor grid
  (mono criterion, score/100 colored, animated bar, weight + missingDataReason mono,
  320-char explanation truncation kept), narrative list, ruleset footer; rainfall
  context: SkeletonPanel / FaultPanel(refetch) / caution "no stored rainfall
  record → scored as missing data" empty / chart + caption; catalogue: SkeletonPanel
  / FaultPanel(refetch) / EmptyState, mc-table with sticky head, max-h-96, keyboard
  row expansion (Enter/Space) added for a11y.
- **reports**: no-farm EmptyState + action; generate flow → SweepLoader "Compiling
  field report", FaultPanel(mutate retry) on error (toast kept), mono pending;
  document preview rebuilt as a mission field-report: mono cover block (mission
  kicker, farm name display type, CoordReadout, region/area, generated/engine line),
  numbered kicker sections (01–06) + caution-bordered limitations block (07),
  telemetry tables with mono headers, provenance status codes colored
  (ok=signal / fail=crit); Print/save-PDF button kept functional, `print:hidden`
  on controls; print-only color overrides (`print:text-neutral-*`,
  `print:border-neutral-300`, `print:bg-white`, `print:text-amber-700`,
  `print:text-red-700`) so the printed document stays legible on white paper —
  these classes apply ONLY in print media.
- **provenance**: ledger QueryState (combined StatSkeletonRow + SkeletonPanel /
  FaultPanel(refetch) / EmptyState with real "Ingest telemetry from Earth
  Intelligence" action); TelemetryStat trio (logged / succeeded / failed); provider
  summary cards (StatusPill derived from last logged status: 2xx=operational,
  4xx=degraded, 5xx/0=error) + animated nasa→signal success-ratio bars + last
  retrieval mono; request ledger mc-table with status-code coloring (2xx signal,
  4xx caution, 5xx/0 crit) + ok/fail icons, provider filter chips (NASA active),
  filtered-empty row note; sources register QueryState + per-source HudPanel cards
  (StatusPill, auth-required caution pill, full dl grid, limitations, endpoint);
  methodology pointer panel; refresh-ledger button with isFetching mono pending.
- **settings**: status QueryState (StatSkeletonRow + SkeletonPanel / FaultPanel
  (refetch)); TelemetryStat row (observations, fire detections, farms, cache live);
  engines panel with mono version rows; reliability panel with cache chip +
  circuit breakers: OPEN ones as crit chips with live per-second cooldown countdown
  (mono `cooldown Ns`, `role="status"`, self-ticking from cooldownRemainingMs),
  recent-failure caution chips; providers grid with StatusPill (pulse off only
  when operational); failed-jobs crit HudPanel + "surfaced, not masked" note;
  operations buttons (invalidate cache / refresh all) with mono pending labels +
  added onError toast for invalidate (API call semantics unchanged); methodology
  panels kept.

## Verification
- `bun run lint` → exit 0, zero output (clean).
- `bunx tsc --noEmit -p tsconfig.json` → zero errors in all five owned files
  (remaining repo errors belong to other owners: examples/, skills/, api routes
  pre-existing ZodDefault typing, gibs-map effect cleanup — owned by parallel agent).
- Grep: zero `slate-`/`emerald-`/`sky-` classes in the five files. Only
  `print:`-prefixed neutral/amber/red utilities exist in reports.tsx (print media
  only, deliberate — see deviations).
- Browser smoke test with real data (headless agent-browser): guest login → farm
  workspace (registry, farm selection, profile stats, boundary chips, soil table
  with farmer-measured row) → rotation planner (builder, priorities sliders,
  compare run → ranking accordion ranks 01–03 with score/confidence bars, expanded
  rank-1 detail showing missing-information caution list + factor breakdown with
  weights and per-criterion scores) → reports (generate → document preview with
  cover + 01–07 sections; print button present) → provenance (stats, provider cards
  GIBS/NASA_POWER operational with success ratios, ledger table, filter chips) →
  system health (telemetry stats, engines, reliability, providers grid). Zero page
  errors during the final pass.
- dev.log: `GET / 200`, `POST /api/v1/rotation/compare 200`, `GET
  /api/v1/provenance?limit=120 200`, compiles clean.

## Bug fixed during verification (important pattern)
`provenance.tsx` initially crashed with "Cannot read properties of undefined
(reading 'summary')" because `<QueryState>` children are evaluated EAGERLY in the
parent render — non-null-asserted `provenance.data!.summary` threw while the query
was still pending even though QueryState never renders those children. Rule for
all agents: **children passed to QueryState must be lazy-safe** — wrap in
`{query.data && (<>…</>)}` (const-narrowed) or use optional chaining, never
`data!`. Farm/rotation/reports/settings already followed the conditional pattern.

## Deviations / notes for other agents
- **Print palette in reports.tsx**: `print:text-neutral-*`, `print:amber-*`,
  `print:red-*` utilities exist solely for the printable document (browsers drop
  the dark theme on paper). Screen styling is 100% mission tokens. The banned
  `slate/emerald/sky` screen palette is absent everywhere.
- Report section headers were converted from `h2 "1 · Environmental record"` to
  kicker `01 · ENVIRONMENTAL RECORD` + same words — numbering and copy preserved,
  markup changed to the mission eyebrow pattern per the spec ("sections with
  kickers").
- Rotation planner: the plain `<select>` for adding crops was swapped to the
  themed shadcn `Select` (same `selectedCrop` string state and option list
  semantics); the add button is additionally disabled while the catalogue is
  unavailable (`!crops.data`) instead of silently adding to a missing catalogue.
- settings.tsx invalidate-cache mutation gained an `onError` toast (UI feedback
  only; fetch call and URL unchanged).
- Provider summary StatusPill statuses are derived client-side from the LAST
  LOGGED status code (display-only; no data invented — derivation documented in
  code as `providerStatus()`).
- Dev server was OOM-killed by the sandbox kernel during verification (same
  pattern as the parallel agent's record; dmesg oom-kill evidence). Restarted with
  `cd /home/z/my-project && nohup bun run dev >> dev.log 2>&1 &` after closing the
  headless browser — now stable, HTTP 200, pid tracked in `.zscripts/dev.pid`
  may be stale (points at the older dead pid 6762).
- Scientific-charts import untouched (`RainfallProfileChart` props identical);
  the parallel agent's chart re-theme is compatible — verified rendering live.
