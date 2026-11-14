import type { ViewKey } from '@/components/state/store';

/**
 * Guided first-run tour — step definitions.
 *
 * Each step either targets a real DOM element (matched by its `data-tour`
 * attribute — those anchors live on the actual controls being described) or is
 * centered. Steps with a `view` first switch the console module and WAIT for
 * the target element to mount (views load data asynchronously), so the tour
 * never points at an empty region. If a target fails to appear within the
 * patience budget the card falls back to a centered placement instead of
 * stalling the operator.
 */

export const TOUR_VERSION = 1;

export interface TourStep {
  id: string;
  /** Ensure this console module is shown before locating the target. */
  view?: ViewKey;
  /** data-tour attribute value; omit for a centered card. */
  target?: string;
  title: string;
  body: string[];
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to TerraField Atlas',
    body: [
      'A 2-minute walk through this NASA-earth-data console: real satellite observations, statistics you can audit, and recommendations that explain themselves.',
      'Nothing here is simulated — missing days are reported as missing, and every number links back to the request that fetched it.',
      'Navigate with the buttons, ←/→ keys, or the dots below. Esc leaves the tour; you can restart it any time from System Health or the ⌘K palette.',
    ],
  },
  {
    id: 'nav',
    target: 'nav-rail',
    title: 'Mission modules',
    body: [
      'Four groups: Mission (overview), Earth Intelligence (what the satellites observe), Field Planning (what you do about it), Trust & Systems (how you verify both).',
      'Single-key jumps work too: D for Earth Intelligence, E for Explorer, F for Fire… press ? anywhere for the full list.',
    ],
  },
  {
    id: 'location',
    target: 'hdr-location',
    title: 'Console geography',
    body: [
      'This chip is the location every module targets — rainfall records, map layers, fire queries, all of it.',
      'Change it from the Geospatial Explorer inputs, the region presets in the ⌘K palette, or a fire-watchlist card.',
    ],
  },
  {
    id: 'clock',
    target: 'hdr-clock',
    title: 'Mission clock & link check',
    body: [
      'The console runs on UTC — the same clock the satellite archives use.',
      'The “chk T-NNs” counter counts down to the next real system-health poll (every 120 s); it is a liveness check, not field telemetry.',
    ],
  },
  {
    id: 'health',
    target: 'hdr-health',
    title: 'System health',
    body: [
      'A live summary of the data providers behind every number: NASA POWER, GIBS, SoilGrids.',
      'Click it to open full diagnostics — engines, circuit breakers, failed jobs. Degradations are surfaced, never masked.',
    ],
  },
  {
    id: 'farm-select',
    target: 'hdr-farm',
    title: 'Active farm',
    body: [
      'Once you register a farm in the Farm Workspace, select it here to scope soil tests, rotation scenarios and reports to that boundary.',
    ],
  },
  {
    id: 'cmdk',
    target: 'hdr-cmdk',
    title: 'Command palette',
    body: [
      '⌘K (Ctrl K) jumps anywhere: modules, region presets, farms, even starting a POWER ingestion.',
      'It works while typing anywhere — the master escape hatch of the console.',
    ],
  },
  {
    id: 'explorer',
    view: 'explorer',
    target: 'explorer-map',
    title: 'Geospatial Explorer',
    body: [
      'NASA GIBS imagery on a live map: MODIS true color, MOD13Q1 NDVI (16-day composites), SMAP root-zone soil moisture — plus ingested VIIRS fire points.',
      'Set the observation date, drag the coordinate inputs, or draw a boundary that later attaches to a farm.',
    ],
  },
  {
    id: 'ingest',
    view: 'dashboard',
    target: 'dash-ingest',
    title: 'Ingest the Earth record',
    body: [
      'This button pulls the real 12-year NASA POWER daily record for the selected geography — rainfall, temperature, radiation, humidity, root-zone wetness.',
      'It takes ~10–30 s and is idempotent: re-running verifies stored rows instead of duplicating them.',
    ],
  },
  {
    id: 'analysis',
    view: 'analysis',
    target: 'analysis-run',
    title: 'Statistical trend analysis',
    body: [
      'Runs seasonal Mann-Kendall with Theil-Sen slopes and FDR control over the stored record — then explains each result in plain language with caveats.',
      'It needs ingested observations first (the previous step); below 8 full years it refuses to claim significance.',
    ],
  },
  {
    id: 'fire',
    view: 'fire',
    target: 'fire-ingest',
    title: 'Fire Intelligence',
    body: [
      'Decodes real VIIRS 375 m active-fire detections from NASA GIBS vector tiles for any ≤ 40-day window since 2015.',
      'Browse the fire calendar, the detection ledger, export CSV, or show detections on the map.',
    ],
  },
  {
    id: 'watchlists',
    view: 'fire',
    target: 'fire-watchlists',
    title: 'Fire watchlists — new',
    body: [
      'Standing regional alerts: pick a geography and radius, set a confidence floor, lookback window and detection threshold.',
      '“Evaluate now” checks every uncovered day against the live VIIRS archive and reports clear / watch / alert from real detections only. While any watchlist alerts, a red chip in the header shows it from anywhere in the console.',
    ],
  },
  {
    id: 'farm',
    view: 'farm',
    target: 'farm-create',
    title: 'Farm Workspace',
    body: [
      'Register a farm at the console location (a boundary drawn in the Explorer attaches automatically), then enter soil tests.',
      'Measured lab tests and SoilGrids modeled profiles are stored side by side but never silently mixed.',
    ],
  },
  {
    id: 'rotation',
    view: 'rotation',
    target: 'rotation-compare',
    title: 'Rotation Planner',
    body: [
      'Build alternative crop sequences, set your priorities, and compare deterministic rule-based scores with full factor-level explanations.',
      'No yield or profit predictions — missing evidence lowers confidence instead of inventing numbers.',
    ],
  },
  {
    id: 'reports',
    view: 'reports',
    target: 'reports-generate',
    title: 'Field Reports',
    body: [
      'Compiles the farm assessment from stored evidence only — environment, trends, soil, rotations, provenance — and prints to PDF from your browser.',
    ],
  },
  {
    id: 'provenance',
    view: 'provenance',
    target: 'prov-ledger',
    title: 'Evidence & Provenance',
    body: [
      'Every external request — success or failure — with status, latency and retrieval time, plus the full source register and licenses.',
      'This is where you audit any number the console has ever shown you.',
    ],
  },
  {
    id: 'settings',
    view: 'settings',
    target: 'settings-tour',
    title: 'System Health & restart',
    body: [
      'Engines, cache, circuit breakers and the restart control for this tour live here — the operational state behind the console.',
      'That completes the walkthrough: explore from the Mission Overview, or run it again whenever the console grows new modules.',
    ],
  },
];
