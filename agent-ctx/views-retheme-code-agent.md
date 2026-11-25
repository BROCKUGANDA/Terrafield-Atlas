# Task: views-retheme — Intelligence Views Mission-Grade Re-Theme

**Agent:** code-agent (Z.ai Code)
**Date:** 2026-11-14 04:20 UTC
**Scope files (exclusively owned):**
- `src/components/views/dashboard.tsx`
- `src/components/views/explorer.tsx`
- `src/components/views/analysis.tsx`
- `src/components/views/fire-intelligence.tsx`
- `src/components/charts/scientific-charts.tsx`
- `src/components/map/gibs-map.tsx`

## What was done

Re-themed the four intelligence views + shared charts + map overlays to the NASA
mission-console design system (`hud`/`hud-calm` panels, `text-ink/dim/faint`,
`border-edge`, `bg-panel`, NASA-red primary actions, signal/caution/crit/aqua
semantic colors, mono uppercase telemetry) with full async-state coverage
(loading skeletons / FaultPanel retry / EmptyState actions) and framer-motion
staggered section entrances (`whileInView`, y 12→0, 0.35 s, 60 ms stagger,
`viewport once`, global `MotionConfig reducedMotion="user"` respected upstream).

### Data-logic invariants (verified preserved)
- All `useQuery`/`useMutation` keys, queryFns, mutationFns, toasts, invalidations,
  `enabled` gating, store selectors/actions unchanged in all four views.
- Honesty copy preserved verbatim (POWER ingestion copy, FIRMS/GIBS note,
  statistical pipeline description, empty-state hints, limitations panels,
  "no fabrication" notes).
- `scientific-charts.tsx`: every export name + prop identical
  (`toMonthly`, `MonthlySeriesChart`, `ClimatologyChart`, `AnomalyChart`,
  `FireCalendarChart`, `RainfallProfileChart`); only colors/styling strings changed.
- `gibs-map.tsx`: map instantiation, all effects (layer add, setTiles, marker,
  fire overlay, boundary draw/click) byte-identical; only overlay/control JSX +
  legend chip hexes restyled. Boundary toolbar nudged to `top-[4.5rem]` to clear
  the maplibre zoom control (pure overlay positioning).

### Palette mapping (charts)
`--chart-1..5` hex mirrors: signal #45e39a, aqua #4cc3ff, caution #ffb224,
iris #8da2ff, coral #ff7e6b; grid rgba(151,174,224,0.14); ticks mono 10px faint;
tooltip #0d1729 panel; anomaly bars crit/aqua; fire calendar caution;
analysis SERIES_COLOR: precip/RH/GWETTOP aqua, T2M/solar caution, T2M_MAX coral,
T2M_MIN/RH iris, WS2M dim, GWETROOT signal.

### States added per view
- **dashboard**: regions select loading chip + disabled state; regions error
  FaultPanel(refetch); status query StatSkeletonRow + FaultPanel(refetch);
  obs query SkeletonPanel + FaultPanel(refetch) + EmptyState (ingest +
  setView('analysis') actions); ingest SweepLoader + mono progress note +
  FaultPanel(mutate retry); coverage TelemetryStat tiles; sources status list
  (from existing systemStatus.providers) with StatusPill; variables → mc-table
  (sticky head, max-h-96 scroll); farm-linked signal pill; CoordReadout.
- **explorer**: sources query — hud skeleton with sweep, FaultPanel(refetch),
  EmptyState (re-request registry action), GibsMap render; dynamic-import loader
  re-themed (hud frame + sweep + mono); date/lat/lon/fly controls moved into
  SectionHeader actions (Field mono labels, aria-labels); CoordReadout strip.
- **analysis**: run button (NASA red, mono, "COMPUTING…") in header actions;
  pending SweepLoader + methods mono note; mutation error FaultPanel(mutate
  retry); idle EmptyState with setView('dashboard') action; per-card
  observations loading SkeletonPanel + error FaultPanel(refetch); direction
  StatusPills (increasing iris / decreasing aqua / no-trend dim) + significance
  (signal) + autocorrelation/insufficient (caution) markers; stats as mc-table
  with telemetry mono (CI in unit/yr); warnings as caution lines; missing days
  caution when > 0.
- **fire-intelligence**: range-invalid caution alert + disabled ingest;
  ingest pending SweepLoader + mono note + FaultPanel(mutate retry); fires
  query StatSkeletonRow + SkeletonPanel skeleton, FaultPanel(refetch), EmptyState
  (ingest action); 4 TelemetryStat tiles + confidence distribution mono strip
  (low/nominal/high + source); FireCalendarChart panel; detection ledger
  mc-table with StatusPill confidence cells (crit/caution/dim), sticky head,
  max-h-96; `truncated` surfaced as caution mono note; limitations caution
  panel rendered whenever data exists (incl. empty result).

## Verification
- `bunx eslint <six files>` → exit 0 (clean). Whole-repo `bun run lint` has 1
  error in `src/components/three/earth-globe.tsx` — owned by ANOTHER agent,
  modified 04:06 by them; not introduced by me.
- `bunx tsc --noEmit` → zero errors in all six owned files (remaining repo
  errors are in files owned by others: api routes, lib, tests, examples).
- Grep: zero `slate-`/`emerald-`/`sky-` and zero legacy chart hexes in my files.
- Browser smoke test (isolated session): all four views exercised with REAL
  data — dashboard tiles/tables/providers, explorer map + layers + legend info,
  analysis full run (7 results, charts, stats, explanations), fire ingest →
  pending → ledger/chart. Zero page errors; console clean except a Three.js
  deprecation warning from another owner's globe.
- dev.log: `GET / 200`, compiles clean. NOTE: dev server was OOM-killed twice
  by the sandbox kernel (dmesg oom-kill evidence, pid 18619); restarted with
  browsers closed — stable afterwards (HTTP 200). If it dies again, restart
  with `cd /home/z/my-project && (setsid nohup bun run dev >/dev/null 2>&1 &)`.

## Deviations / notes for other agents
- Explorer kept its control cluster in SectionHeader actions (date + lat +
  lon + fly) per the "controls move into actions" contract; coordinate context
  moved to a hud strip below the map.
- Dashboard "sources status list" is sourced from the EXISTING
  `systemStatus.providers` field (no new query added).
- `gibs-map` layer panel wraps `.hud` inside an absolutely-positioned div
  because `.hud` sets `position: relative` (cascade: globals utilities layer
  wins over Tailwind's `absolute`). Anyone overlaying `.hud` panels must do
  the same.
- Charts use hex mirrors of `--chart-*` vars (SVG attrs cannot carry var()).
- `map.off` cleanup in gibs-map got braces so the effect returns void (TS
  fix, runtime behavior identical).
