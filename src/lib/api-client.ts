'use client';

import { useOrganizationStore } from '@/components/state/organization-store';

/**
 * Typed API client for the TerraField Atlas v1 contracts.
 * Relative paths only (gateway requirement). Zod-validated responses where
 * a schema adds real value; plain generics elsewhere.
 */

export interface ApiError {
  code: string;
  message: string;
  correlationId?: string;
  details?: unknown;
  providerMessage?: string;
}

export class ApiRequestError extends Error {
  code: string;
  status: number;
  correlationId?: string;
  details?: unknown;
  providerMessage?: string;
  constructor(status: number, err: ApiError) {
    super(err.message);
    this.code = err.code;
    this.status = status;
    this.correlationId = err.correlationId;
    this.details = err.details;
    this.providerMessage = err.providerMessage;
  }
}

/**
 * Console-side transport hardening (pairs with the server's retry policy):
 *  - caller cancellation and the 20 s timeout remain distinguishable;
 *  - every mutation gets an Idempotency-Key, but mutations never auto-retry;
 *  - GET/HEAD retry once on network/429/5xx and honor Retry-After;
 *  - malformed 2xx JSON is a typed contract error, never silent success.
 */
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRY_DELAY_MS = 5_000;

function isHtml(text: string): boolean {
  return /^\s*(?:<!doctype\s+html|<html[\s>])/i.test(text);
}

function friendlyStatus(status: number, statusText: string): string {
  if (status === 502) return 'gateway returned 502 — the console API is restarting or unreachable from this network';
  if (status === 503) return 'console API temporarily unavailable (503)';
  if (status === 504) return 'console API timed out upstream (504)';
  return `HTTP ${status} ${statusText}`.trim();
}

function retryDelayMs(response: Response | null, attempt: number): number {
  const raw = response?.headers.get('retry-after');
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, MAX_RETRY_DELAY_MS);
    const at = Date.parse(raw);
    if (Number.isFinite(at)) return Math.min(Math.max(0, at - Date.now()), MAX_RETRY_DELAY_MS);
  }
  return Math.min(400 * attempt, MAX_RETRY_DELAY_MS);
}

async function attempt(path: string, init: RequestInit, timeoutMs: number): Promise<{ res: Response; text: string }> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abortFromCaller = () => controller.abort();
  if (init.signal?.aborted) controller.abort();
  else init.signal?.addEventListener('abort', abortFromCaller, { once: true });
  try {
    const res = await fetch(path, { ...init, signal: controller.signal });
    const text = await res.text();
    return { res, text };
  } catch (error) {
    if (timedOut) {
      throw new ApiRequestError(0, {
        code: 'TIMEOUT',
        message: `request exceeded the ${timeoutMs / 1000}s console budget — the API may be busy or down`,
      });
    }
    if (init.signal?.aborted) {
      throw new ApiRequestError(0, { code: 'ABORTED', message: 'request was cancelled by its caller' });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', abortFromCaller);
  }
}

function parseJson(text: string, status: number): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiRequestError(status, {
      code: 'BAD_PAYLOAD',
      message: isHtml(text)
        ? `${friendlyStatus(status, '')} — an HTML error page came back instead of console JSON`
        : 'console API returned malformed JSON',
    });
  }
}

export async function request<T>(path: string, init: RequestInit = {}, options: { timeoutMs?: number } = {}): Promise<T> {
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? REQUEST_TIMEOUT_MS, 1), 120_000);
  const method = (init.method ?? 'GET').toUpperCase();
  const idempotent = method === 'GET' || method === 'HEAD';
  const headers = new Headers(init.headers);
  const organizationId = useOrganizationStore.getState().activeOrganizationId;
  if (organizationId && !headers.has('x-terrafield-organization')) headers.set('x-terrafield-organization', organizationId);
  if (init.body && !(typeof FormData !== 'undefined' && init.body instanceof FormData) && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (!idempotent && !headers.has('idempotency-key')) headers.set('idempotency-key', crypto.randomUUID());
  const normalizedInit: RequestInit = { ...init, headers };
  const maxAttempts = idempotent ? 2 : 1;

  let lastRes: Response | null = null;
  let lastText = '';
  let networkError: Error | null = null;

  for (let a = 1; a <= maxAttempts; a++) {
    networkError = null;
    try {
      const { res, text } = await attempt(path, normalizedInit, timeoutMs);
      lastRes = res;
      lastText = text;
      if (res.ok) return parseJson(text, res.status) as T;
      if (!(res.status >= 500 || res.status === 429) || a >= maxAttempts) break;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(res, a)));
    } catch (err) {
      if (err instanceof ApiRequestError && (err.code === 'ABORTED' || err.code === 'TIMEOUT')) throw err;
      networkError = err instanceof Error ? err : new Error('network error');
      if (a >= maxAttempts) break;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(lastRes, a)));
    }
  }

  if (networkError && !lastRes) {
    throw new ApiRequestError(0, { code: 'NETWORK', message: 'console API unreachable from this browser (network error)' });
  }

  const res = lastRes as Response;
  let data: unknown = null;
  if (lastText && !isHtml(lastText)) {
    try { data = JSON.parse(lastText) as unknown; } catch { data = null; }
  }
  if (!res.ok) {
    if (!data && isHtml(lastText)) {
      throw new ApiRequestError(res.status, {
        code: 'GATEWAY_HTML',
        message: `${friendlyStatus(res.status, res.statusText)} — an HTML error page came back instead of console JSON`,
      });
    }
    const err = (data as { error?: ApiError } | null)?.error;
    throw new ApiRequestError(res.status, err ?? { code: 'HTTP_' + res.status, message: friendlyStatus(res.status, res.statusText) });
  }
  throw new ApiRequestError(res.status, { code: 'BAD_PAYLOAD', message: 'console API returned an invalid success payload' });
}

// ---- contracts ----

export interface RegionPreset {
  key: string;
  name: string;
  country: string;
  lat: number;
  lon: number;
  croppingContext: string;
  typicalCrops: string[];
}

export interface FarmSummary {
  id: string;
  name: string;
  country: string | null;
  region: string | null;
  centroidLat: number;
  centroidLon: number;
  areaHa: number | null;
  createdAt: string;
  updatedAt: string;
  _count: { soilTests: number; scenarios: number; trendAnalyses: number };
}

export interface FarmDetail extends Omit<FarmSummary, '_count'> {
  boundaryGeoJson: string | null;
  cropHistory: string | null;
  notes: string | null;
  soilTests: SoilTest[];
  _count: { soilTests: number; scenarios: number; trendAnalyses: number; observations: number };
}

export interface SoilTest {
  id: string;
  farmId: string;
  measuredAt: string;
  source: 'farmer' | 'laboratory' | 'soilgrids';
  sourceDetail: string | null;
  depthCm: number | null;
  texture: string | null;
  sandPct: number | null;
  siltPct: number | null;
  clayPct: number | null;
  ph: number | null;
  organicCarbonPct: number | null;
  nitrogenMgKg: number | null;
  phosphorusMgKg: number | null;
  potassiumCmolKg: number | null;
  notes: string | null;
}

export interface CropDef {
  cropKey: string;
  name: string;
  scientificName: string;
  family: string;
  familyGroup: string;
  growthDays: [number, number];
  waterReqMm: [number, number];
  waterUseClass: string;
  nFixation: boolean;
  nutrientDemand: string;
  soilPh: [number, number];
  textureSuitability: { best: string[]; acceptable: string[] };
  calorieStaple: boolean;
  notes: string;
  sources: string[];
}

export interface TrendResult {
  variable: string;
  label: string;
  unit: string;
  periodStart: string;
  periodEnd: string;
  observationPeriodYears: number;
  sampleCount: number;
  missingCount: number;
  method: string;
  seasonalMethod: string;
  direction: 'increasing' | 'decreasing' | 'no trend';
  slopePerYear: number | null;
  ciLower: number | null;
  ciUpper: number | null;
  zValue: number | null;
  pValue: number | null;
  significant: boolean;
  autocorrelationAdjusted: boolean;
  minSampleSatisfied: boolean;
  multipleTestingAdjustedP: number | null;
  anomalies: { date: string; value: number; zScore: number }[];
  monthlyClimatology: { month: number; mean: number; std: number; n: number }[];
  explanation: { headline: string; interpretation: string; caveats: string[] };
  warnings: string[];
}

export interface TrendAnalysisResponse {
  jobId: string;
  location: { lat: number; lon: number };
  farmId: string | null;
  period: { start: string; end: string };
  observationCount: number;
  datasetVersions: string[];
  multipleTesting: { method: string; testedHypotheses: number };
  results: TrendResult[];
  annualSeries: Record<string, { year: number; value: number; n: number }[]>;
}

export interface RotationFactor {
  criterion: string;
  weight: number;
  score: number | null;
  missingDataReason?: string;
  explanation: string;
}

export interface RotationResult {
  scenarioName: string;
  cropKeys: string[];
  cropNames: string[];
  factors: RotationFactor[];
  overallScore: number;
  confidence: number;
  incompatible: { rule: string; detail: string }[];
  missingInformation: string[];
  narrative: string[];
  ruleVersion: string;
  weightsUsed: Record<string, number>;
}

export interface CompareResponse {
  jobId: string;
  farmId: string;
  environmentAvailable: { rainfall: boolean; thermal: boolean };
  soilAvailable: { present: boolean; source: string | null };
  ranking: { rank: number; scenarioName: string; overallScore: number; confidence: number; incompatibleCount: number }[];
  results: RotationResult[];
}

export interface FireQueryResponse {
  location: { lat: number; lon: number };
  region: { key: string; bbox: { west: number; south: number; east: number; north: number } };
  requestedRange: { from: string; to: string };
  count: number;
  source: string;
  monthlyCounts: { month: string; count: number }[];
  confidenceDistribution: { low: number; nominal: number; high: number };
  frpStats: { meanMW: number; minMW: number; count: number } | null;
  detections: {
    date: string;
    time: string;
    latitude: number;
    longitude: number;
    confidence: string;
    dayNight: string;
    frp: number | null;
    brightTi4: number | null;
    sensor: string;
  }[];
  truncated: boolean;
  limitations: string;
}

// ---- fire watchlists (regional fire-alert rules) ----

export type WatchConfidence = 'low' | 'nominal' | 'high';
export type WatchStatus = 'unverified' | 'clear' | 'watch' | 'alert';

export interface WatchEvent {
  id: string;
  evaluatedAt: string;
  windowStart: string;
  windowEnd: string;
  status: WatchStatus;
  detectionCount: number;
  highConfidenceCount: number;
  nominalCount: number;
  lowCount: number;
  maxFrpMW: number | null;
  daysWithDetections: number;
  daysChecked: number;
  daysNoData: number;
  triggeredAlert: boolean;
  rationale: string;
  daysNoDataList: string[];
  daysUnchecked: string[];
  perDay: { date: string; total: number; qualifying: number }[];
  /** What fired this evaluation: console click, historical backtest, scheduler. */
  trigger: 'manual' | 'backtest' | 'scheduled';
  /** Shared with the scheduler's audit-ledger entry for scheduled runs. */
  correlationId: string | null;
}

export interface Watchlist {
  id: string;
  name: string;
  label: string | null;
  lat: number;
  lon: number;
  radiusKm: number;
  minConfidence: WatchConfidence;
  lookbackDays: number;
  detectionThreshold: number;
  watchThreshold: number;
  notes: string | null;
  lastStatus: WatchStatus;
  lastDetectionCount: number | null;
  lastEvaluatedAt: string | null;
  /** Scheduled re-evaluation cadence (minutes) — null = manual only. */
  reevaluateIntervalMin: number | null;
  /** Next claimed scheduler run (ISO) — null when no cadence is set. */
  nextReevaluateAt: string | null;
  createdAt: string;
}

export interface WatchlistRow extends Watchlist {
  eventCount: number;
  lastEvent: WatchEvent | null;
}

export interface WatchlistsResponse {
  watchlists: WatchlistRow[];
  summary: { total: number; alerting: number; watch: number; clear: number; unverified: number };
  note: string;
}

export interface WatchEvaluateResponse {
  watchlist: Watchlist;
  evaluation: WatchEvaluationResult;
  event: WatchEvent;
  recentEvents: WatchEvent[];
  /** 'backtest' when the request pinned an explicit historical end date. */
  mode: 'live' | 'backtest';
  requestedEnd: string;
  trigger: 'manual' | 'backtest' | 'scheduled';
  source: string;
}

export interface WatchEvaluationResult {
  status: WatchStatus;
  windowStart: string;
  windowEnd: string;
  daysChecked: number;
  daysNoData: string[];
  daysUnchecked: string[];
  coverageComplete: boolean;
  detectionCount: number;
  byConfidence: { low: number; nominal: number; high: number };
  watchThreshold: number;
  daysWithDetections: number;
  maxFrpMW: number | null;
  perDay: { date: string; total: number; qualifying: number }[];
  rationale: string;
  daysFetchedFromGibs: number;
  rowsWritten: number;
}

export interface WatchlistInput {
  name: string;
  label?: string;
  lat: number;
  lon: number;
  radiusKm?: number;
  minConfidence?: WatchConfidence;
  lookbackDays?: number;
  detectionThreshold?: number;
  notes?: string;
  /** Scheduled re-evaluation cadence in minutes (360 | 720 | 1440) or null to disable. */
  reevaluateIntervalMin?: number | null;
}

// ---- scheduler-run history + cadence-aware digests (per watchlist) ----

/** One scheduler-run ledger entry, optionally enriched with its evaluation. */
export interface SchedulerRunEntry {
  kind: 'run' | 'fail';
  /** When the outcome was recorded (ISO). */
  at: string;
  /** Shared with the matching FireWatchEvent on successful runs. */
  correlationId: string | null;
  /** nextReevaluateAt claimed BEFORE the run (claim-before-run ordering). */
  claimedNextAt: string | null;
  status: string | null;
  detectionCount: number | null;
  error: string | null;
  /** Full evaluation record for successful runs; null for failures. */
  evaluation: WatchEvent | null;
}

export interface WatchlistRunsResponse {
  watchlist: Watchlist;
  runs: SchedulerRunEntry[];
  counts: { total: number; ok: number; failed: number };
  showing: number;
  cap: number;
  note: string;
}

export interface DigestWindow {
  start: string;
  end: string;
}

export interface DigestSummary {
  evaluations: number;
  byTrigger: { manual: number; backtest: number; scheduled: number };
  statusPath: string[];
  transitions: { from: string; to: string; at: string }[];
  alertingEvaluations: number;
  clearEvaluations: number;
  peak: { detectionCount: number; at: string } | null;
  last: { status: string; detectionCount: number; at: string } | null;
  noDataDays: string[];
  daysCheckedTotal: number;
}

export interface DigestComparison {
  evaluationsDelta: number;
  peakDelta: number | null;
  statusChanged: boolean;
  alertEntered: boolean;
  alertCleared: boolean;
  previousLast: DigestSummary['last'];
}

export interface DigestFailure {
  at: string;
  error: string;
  correlationId: string | null;
}

export interface WatchDigestResponse {
  watchlist: Watchlist;
  hours: number;
  cadenceMin: number | null;
  /** 'cadence' (derived from the watchlist) | 'request' (?hours=) | 'default' (24 h). */
  windowSource: 'cadence' | 'request' | 'default';
  window: { current: DigestWindow; previous: DigestWindow };
  current: DigestSummary;
  previous: DigestSummary;
  comparison: DigestComparison;
  failures: DigestFailure[];
  digest: string[];
  truncated: boolean;
  note: string;
}

// ---- push-style digest delivery (SSE channel) ----

/** Server-Sent Events endpoint the console's EventSource stays subscribed to. */
export const DIGEST_STREAM_PATH = '/api/v1/fires/watchlists/digest-stream';

/** The digest body shared by the REST response and every pushed payload. */
export type DigestBody = Omit<WatchDigestResponse, 'watchlist' | 'note' | 'correlationId'>;

/** `watchlist.digest` event on the stream — one whole cadence-aware digest. */
export interface DigestPushPayload {
  type: 'digest';
  /** Stable triggering identity used to deduplicate reconnects/retries. */
  eventId: string;
  /** What pushed it: an evaluation event landed, or a scheduled run FAILED. */
  reason: 'evaluation' | 'scheduled-failure';
  /** Trigger of the newest evaluation in the digest — null for scheduled failures. */
  trigger: 'manual' | 'backtest' | 'scheduled' | null;
  correlationId: string | null;
  /** When the triggering fact landed (ISO). */
  triggeredAt: string;
  /** When the channel recomputed and published the digest (ISO). */
  pushedAt: string;
  watchlistId: string;
  watchlistName: string;
  watchlist: Watchlist;
  digest: DigestBody;
}

/** `channel.hello` event — subscription confirmation with channel facts. */
export interface DigestHelloPayload {
  type: 'hello';
  connectionId: string;
  connectedAt: string;
  subscribers: number;
  maxClients: number;
  schedulerEnabled: boolean;
  schedulerTickEverySec: number | null;
  note: string;
}

export interface DigestChannelStatus {
  kind: 'sse';
  enabled: boolean;
  disabledByEnv: boolean;
  maxClients: number;
  subscribers: number;
  connectionsOpened: number;
  eventsDelivered: number;
  lastEventAt: string | null;
  /** Additional env-gated delivery exits beyond the SSE channel. */
  exits: {
    webhook: {
      state: 'configured' | 'not-configured' | 'disabled';
      urlConfigured: boolean;
      host: string | null;
      secretPresent: boolean;
      secretBytes?: number;
      secretAdequate?: boolean;
      rotationSecretPresent?: boolean;
      allowlistCount?: number;
      targetSafe?: boolean | null;
      targetAllowlisted?: boolean | null;
      targetUnsafeReason?: string | null;
      signingScheme?: string;
      attempts: number;
      delivered: number;
      failed: number;
      lastAttemptAt: string | null;
      lastDeliveredAt: string | null;
      lastError: string | null;
      note: string;
    };
    email: {
      state: 'configured' | 'not-configured' | 'disabled' | 'incomplete';
      host: string | null;
      port: number;
      recipients: number;
      missing: string[];
      sent: number;
      failed: number;
      lastSentAt: string | null;
      lastError: string | null;
      note: string;
    };
  };
  note: string;
}

export interface DataSourceRow {
  id: string;
  provider: string;
  datasetName: string;
  productId: string | null;
  endpointTemplate: string;
  dataFormat: string;
  temporalCoverage: string;
  spatialResolution: string;
  units: string | null;
  authRequired: boolean;
  rateLimit: string | null;
  license: string;
  attribution: string;
  limitations: string;
  status: string;
  productVersion?: string | null;
  spatialCoverage?: string | null;
  temporalStart?: string | null;
  temporalEnd?: string | null;
  nativeResolutionM?: number | null;
  qualityMetadata?: string | null;
  processingHistory?: string | null;
  accessConditions?: string | null;
  apiLimits?: string | null;
  knownLimitations?: string | null;
  stacCollectionId?: string | null;
  stacApiUrl?: string | null;
  retrievalTimestamp?: string | null;
}

export interface ProvenanceResponse {
  summary: { requestsLogged: number; ok: number; failed: number; byProvider: Record<string, { total: number; ok: number; failed: number; lastStatus: number | null; lastRetrievedAt: string | null }> };
  requestLog: {
    id: string;
    provider: string;
    datasetId: string | null;
    operation: string;
    requestUrl: string;
    status: number;
    latencyMs: number;
    responseBytes: number | null;
    ok: boolean;
    errorDetail: string | null;
    correlationId: string | null;
    retrievedAt: string;
  }[];
  sources: DataSourceRow[];
  recentTrendAnalyses: unknown[];
  recentJobs: unknown[];
  methodologyPointer: string;
}

export interface SystemStatus {
  service: string;
  engines: { trendEngine: string; rotationEngine: string; cropCatalogue: string };
  database: {
    observations: number;
    fireDetections: number;
    farms: number;
    fireWatchlists: number;
    fireWatchEvents: number;
    jobCounts: { status: string; count: number }[];
    failedJobs: { id: string; type: string; error: string | null; startedAt: string }[];
  };
  cache: { liveEntries: number; expiredEntries: number; maxEntries: number };
  circuitBreakers: { total: number; open: number; withFailures: number };
  scheduler: {
    kind: 'database-leased';
    enabled: boolean;
    disabledByEnv: boolean;
    tickEverySec: number;
    maxRunsPerTick: number;
    running: boolean;
    startedAt: string | null;
    lastTickAt: string | null;
    lastTick: { tickAt: string; ran: number; dueCount: number; runs: { watchlistId: string; name: string; ok: boolean; status?: string; detectionCount?: number; error?: string; lostRace?: boolean }[] } | null;
    ticksFired: number;
    ticksSkippedBusy: number;
    consecutiveFailedRuns: number;
    scheduledWatchlists: number;
    nextDueAt: string | null;
    dueNow: { id: string; name: string }[];
    note: string;
  };
  digestChannel: {
    enabled: boolean;
    maxClients: number;
    subscribers: number;
    connectionsOpened: number;
    eventsDelivered: number;
    exits: {
      webhook: { state: string; attempts: number; delivered: number; failed: number };
      email: { state: string; attempts: number; delivered: number; failed: number };
    };
  };
  digestEmail: { state: string; sent: number; failed: number };
  experiments?: {
    key: string;
    active: boolean;
    variants: { variant: string; exposures: number; outcomes: number }[];
  }[];
  providers: Record<string, { status: string; latencyMs?: number | null; note?: string }>;
  sourceSigns?: { checkedAt: string; probeMs: number; summary: { live: number; degraded: number; unreachable: number } };
  reliability: Record<string, string>;
  methodology: { trend: string; rotation: string };
}

// ---- live source signs (probe-backed chips) ----

export type SourceSignState = 'live' | 'degraded' | 'unreachable' | 'checking';

export interface SourceSign {
  key: string;
  label: string;
  state: SourceSignState;
  latencyMs: number | null;
  checkedAt: string;
  detail: string;
  servingFireDetections?: boolean;
}

export interface SourcesLiveResponse {
  checkedAt: string;
  probeMs: number;
  signs: SourceSign[];
  summary: { live: number; degraded: number; unreachable: number };
  eonet: {
    ok: boolean;
    fresh: boolean;
    staleMs: number | null;
    days: number;
    count: number;
    events: { id: string; title: string; startedAt: string | null; lon: number | null; lat: number | null; source: string | null }[];
    note: string;
  };
  note: string;
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'dead-lettered';

/** Every long-running POST returns 202 plus this durable job pointer. */
export interface JobAccepted {
  jobId: string;
  jobUrl: string;
  type: string;
  status: JobStatus;
  duplicate: boolean;
  enqueued?: boolean;
  deadlineAt: string | null;
  correlationId: string;
  message?: string;
  trigger?: 'manual' | 'backtest';
}

export interface JobDetail<T> {
  job: {
    id: string;
    ownerId: string | null;
    type: string;
    status: JobStatus;
    params: string;
    progressNote: string | null;
    resultRef: string | null;
    error: string | null;
    correlationId: string | null;
    idempotencyKey: string | null;
    dedupeKey: string | null;
    attempts: number;
    maxAttempts: number;
    deadlineAt: string | null;
    leaseExpiresAt: string | null;
    leaseHolder: string | null;
    cancelRequested: boolean;
    deadLettered: boolean;
    startedAt: string;
    finishedAt: string | null;
    enqueuedAt: string | null;
  };
  result: T;
  jobUrl: string;
}

export interface IngestOutcome {
  lat: number;
  lon: number;
  start: string;
  end: string;
  rowsWritten: number;
  validPoints: number;
  missingPoints: number;
  chunks: number;
}

export interface FireIngestOutcome {
  totalDetections: number;
  rowsWritten: number;
  privateDetectionsStored?: number;
  truncated?: boolean;
  noDataDays: string[];
  source: string;
  region: { key: string; bbox: { west: number; south: number; east: number; north: number } };
}

export interface ReportResponse {
  generatedAt: string;
  reportId?: string;
  persisted?: boolean;
  farm: { id: string; name: string; location: { lat: number; lon: number }; country: string | null; region: string | null; areaHa: number | null; cropHistory: { season: string; crop: string; family?: string }[]; notes: string | null };
  environmentalRecord: { available: boolean; observationCount: number; period: { start: string | null; end: string | null }; datasetVersions: string[]; sources: string; climatology: { rainfallMonthlyMedianMm: number[]; years: number } | null; thermal: { meanMonthlyTemperatureC: number[]; years: number } | null };
  trendAnalyses: { variable: string; label: string; unit: string; direction: string; significant: boolean; slopePerYear: number | null; ci: (number | null)[]; pValue: number | null; fdrAdjustedP: number | null; sampleCount: number; method: string; minSampleSatisfied: boolean; interpretation: string }[];
  annualSeries: Record<string, { year: number; value: number; n: number }[]>;
  soilInformation: { measured: Record<string, unknown> | null; supplementaryModeled: Record<string, unknown> | null; note: string };
  rotationScenarios: { name: string; cropKeys: string[]; ruleVersion: string; overallScore: number; confidence: number; incompatible: { rule: string; detail: string }[]; fullResult: RotationResult; createdAt: string }[];
  provenance: { provider: string; datasetId: string | null; operation: string; status: number; ok: boolean; latencyMs: number; retrievedAt: string; requestUrl: string }[];
  methodology: { trendEngine: string; rotationEngine: string; honestyRules: string[] };
  limitations: string[];
}

export interface MapLayerInfo {
  id: string;
  name: string;
  group: string;
  format: string;
  resolution: string;
  temporalCoverage: string;
  cadence: string;
  description: string;
  productSource: string;
  limitations: string;
  tileMatrixSet: string;
}

export interface ObservationsResponse {
  count: number;
  variables: string[];
  datasetVersions: string[];
  firstRetrievedAt: string | null;
  provenanceNote: string;
  series: Record<string, { unit: string; points: { date: string; value: number | null }[] }>;
  location?: { lat: number; lon: number };
}

export interface RasterStatsResponse {
  metadata: { source: Record<string, unknown>; output: Record<string, unknown> };
  statistics: { validPixels: number; totalPixels: number; validFraction: number; minimum: number; maximum: number; mean: number; standardDeviation: number; percentiles: Record<string, number> };
  lineage: { inputSha256: string; inputBytes: number; band: number; steps: Record<string, unknown>[]; processorVersion: string; processedAt: string };
  limitations: string[];
  artifactRef?: string;
  artifactBytes?: number;
  rasterAsset?: { assetId: string; artifactRef: string };
}

export interface RasterAssetRecord {
  id: string;
  filename: string;
  format: string;
  sourceHash: string;
  artifactRef: string;
  artifactBytes: number;
  createdAt: string;
  lineage: Record<string, unknown>;
}

export interface StacItem {
  id: string;
  collection: string | null;
  datetime: string | null;
  start: string | null;
  end: string | null;
  cloudCover: number | null;
  assets: { name: string; href: string; type: string | null; title: string | null }[];
}

export interface StacSearchResponse {
  provider: string;
  endpoint: string;
  count: number;
  items: StacItem[];
  assetAccessibility: { href: string; status: number | null; accessible: boolean; note: string }[];
  limitations: string[];
  retrievedAt: string;
}

// ---- enterprise tenancy and commercial contracts ----

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  country: string | null;
  timezone: string;
  role: string;
  farms: number;
  members: number;
  workspaces: number;
}

export interface Workspace {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  createdAt: string;
  _count?: { farms: number };
}

export interface OrganizationMember {
  id: string;
  organizationId: string;
  userId: string;
  role: string;
  status: string;
  createdAt: string;
  user: { id: string; email: string; name: string | null };
}

export interface OrganizationDetail {
  id: string;
  name: string;
  slug: string;
  country: string | null;
  timezone: string;
  createdAt: string;
  workspaces: Workspace[];
  subscriptions: BillingSubscription[];
  _count: { farms: number; memberships: number; reports: number; agentRuns: number };
}

export interface BillingPlan {
  id: string;
  code: string;
  name: string;
  description: string;
  monthlyPriceMinor: number;
  currency: string;
  active: boolean;
  sortOrder: number;
  entitlements: {
    limits: Record<string, number>;
    capabilities: Record<string, boolean>;
  };
}

export interface BillingSubscription {
  id: string | null;
  organizationId: string | null;
  ownerId: string | null;
  planId: string;
  status: string;
  trialEndsAt?: string | null;
  currentPeriodStart?: string | null;
  currentPeriodEnd?: string | null;
  paymentProvider?: string | null;
  plan?: BillingPlan;
}

export interface BillingResponse {
  plans: BillingPlan[];
  subscription: BillingSubscription;
  entitlements: BillingPlan['entitlements'];
  usage: Record<string, number>;
  events: { id: string; metric: string; quantity: number; operationId: string; jobId: string | null; billed: boolean; occurredAt: string }[];
  paymentNote: string;
}

export interface WebhookRecord {
  id: string;
  name: string;
  url: string;
  events: string[];
  status: string;
  createdAt: string;
  deliveryCount?: number;
}

export interface WebhookDeliveryRecord {
  id: string;
  eventId: string;
  eventType: string;
  status: string;
  attempts: number;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface AdminOverview {
  organizations: { id: string; name: string; slug: string; country: string | null; createdAt: string; farms: number; members: number }[];
  users: { id: string; email: string; name: string | null; isAdmin: boolean; emailVerified: string | null; createdAt: string }[];
  sources: { id: string; provider: string; datasetName: string; status: string; lastCheckedAt: string | null }[];
  featureFlags: { key: string; description: string; enabled: boolean; rolloutJson: string | null; updatedAt: string }[];
  audit: { id: string; actor: string; action: string; targetId: string | null; organizationId: string | null; createdAt: string }[];
  failedJobs: { id: string; type: string; status: string; error: string | null; startedAt: string; organizationId: string | null }[];
  queue: { depth: Record<string, number>; workers: { id: string; ageSec: number }[]; oldestJobAgeSec: number | null };
}

export interface IntelligencePlan {
  intent: string;
  agent: string;
  geographicScope: { farmId: string | null; lat: number | null; lon: number | null; label: string };
  datasets: string[];
  method: string;
  tools: string[];
  dateRange: { from: string; to: string } | null;
  requiresApproval: boolean;
  limitations: string[];
}

export interface AgentRun {
  id: string;
  query: string;
  status: string;
  createdAt: string;
  finishedAt: string | null;
  planJson?: string;
  resultJson?: string | null;
  limitationsJson?: string | null;
  toolExecutions?: { id: string; toolName: string; status: string; error: string | null }[];
  evidence?: { id: string; sourceType: string; sourceId: string }[];
}

// ---- calls ----

type FireLocationInput = { farmId: string } | { lat: number; lon: number };
type FireQueryInput = FireLocationInput & { from: string; to: string; confidence?: string; dayNight?: string };
type FireIngestInput = FireLocationInput & { from: string; to: string };

export const api = {
  rasterStats: (file: File, params: { band?: number; bbox?: string; target_crs?: string; target_resolution?: number; persist?: boolean } = {}) => {
    const form = new FormData();
    form.set('file', file, 'raster.tif');
    const q = new URLSearchParams();
    if (params.band) q.set('band', String(params.band));
    if (params.bbox) q.set('bbox', params.bbox);
    if (params.target_crs) q.set('target_crs', params.target_crs);
    if (params.target_resolution) q.set('target_resolution', String(params.target_resolution));
    if (params.persist) q.set('persist', 'true');
    return request<RasterStatsResponse>(`/api/v1/raster/stats?${q.toString()}`, { method: 'POST', body: form }, { timeoutMs: 65_000 });
  },
  rasterDataset: (file: File, params: { variable?: string; bbox?: string; target_crs?: string; target_resolution?: number; crs?: string; persist?: boolean } = {}) => {
    const form = new FormData();
    form.set('file', file, file.name || 'dataset.nc');
    const q = new URLSearchParams();
    if (params.variable) q.set('variable', params.variable);
    if (params.bbox) q.set('bbox', params.bbox);
    if (params.target_crs) q.set('target_crs', params.target_crs);
    if (params.target_resolution) q.set('target_resolution', String(params.target_resolution));
    if (params.crs) q.set('crs', params.crs);
    if (params.persist) q.set('persist', 'true');
    return request<RasterStatsResponse>(`/api/v1/raster/dataset?${q.toString()}`, { method: 'POST', body: form }, { timeoutMs: 65_000 });
  },
  rasterAssets: () => request<{ assets: RasterAssetRecord[]; nextCursor: string | null }>('/api/v1/raster/assets'),
  stacSearch: (params: { geometry?: string; from?: string; to?: string; collections?: string; limit?: number; checkAssets?: boolean }) => {
    const q = new URLSearchParams();
    if (params.geometry) q.set('geometry', params.geometry);
    if (params.from) q.set('from', params.from);
    if (params.to) q.set('to', params.to);
    if (params.collections) q.set('collections', params.collections);
    q.set('limit', String(params.limit ?? 20));
    if (params.checkAssets) q.set('checkAssets', '1');
    return request<StacSearchResponse>(`/api/v1/stac/search?${q.toString()}`);
  },
  organizations: () => request<{ organizations: OrganizationSummary[] }>('/api/v1/organizations'),
  organization: (id: string) => request<{ organization: OrganizationDetail }>(`/api/v1/organizations/${id}`),
  createOrganization: (body: { name: string; country?: string; timezone?: string }) =>
    request<{ organization: OrganizationSummary; workspace: Workspace; trialEndsAt: string }>('/api/v1/organizations', { method: 'POST', body: JSON.stringify(body) }),
  workspaces: (organizationId: string) => request<{ workspaces: Workspace[] }>(`/api/v1/organizations/${organizationId}/workspaces`),
  createWorkspace: (organizationId: string, body: { name: string; description?: string }) =>
    request<{ workspace: Workspace }>(`/api/v1/organizations/${organizationId}/workspaces`, { method: 'POST', body: JSON.stringify(body) }),
  members: (organizationId: string) => request<{ members: OrganizationMember[] }>(`/api/v1/organizations/${organizationId}/members`),
  updateMember: (organizationId: string, membershipId: string, body: { role?: string; status?: string }) =>
    request<{ member: OrganizationMember }>(`/api/v1/organizations/${organizationId}/members/${membershipId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  inviteMember: (organizationId: string, body: { email: string; role: string }) =>
    request<{ invitation: { id: string; email: string; role: string; expiresAt: string } }>(`/api/v1/organizations/${organizationId}/invitations`, { method: 'POST', body: JSON.stringify(body) }),
  acceptOrganizationInvitation: (token: string) =>
    request<{ accepted: boolean; organizationId: string; role: string }>('/api/v1/organizations/invitations/accept', { method: 'POST', body: JSON.stringify({ token }) }),
  billing: () => request<BillingResponse>('/api/v1/billing'),
  updateBilling: (body: { planCode?: string; action?: 'cancel' | 'resume' }) =>
    request<{ subscription: BillingSubscription }>('/api/v1/billing', { method: 'PATCH', body: JSON.stringify(body) }),
  webhooks: () => request<{ webhooks: WebhookRecord[] }>('/api/v1/webhooks'),
  createWebhook: (body: { name: string; url: string; events: string[] }) =>
    request<{ webhook: WebhookRecord; secret: string; note: string }>('/api/v1/webhooks', { method: 'POST', body: JSON.stringify(body) }),
  webhookDeliveries: (id: string) => request<{ deliveries: WebhookDeliveryRecord[] }>(`/api/v1/webhooks/${id}`),
  disableWebhook: (id: string) => request<{ disabled: boolean; id: string }>(`/api/v1/webhooks/${id}`, { method: 'DELETE' }),
  apiKeys: () => request<{ keys: ApiKeyRecord[] }>('/api/v1/api-keys'),
  createApiKey: (body: { name: string; scopes: string[]; expiresInDays?: number }) =>
    request<{ key: ApiKeyRecord; secret: string; note: string }>('/api/v1/api-keys', { method: 'POST', body: JSON.stringify(body) }),
  revokeApiKey: (id: string) => request<{ revoked: boolean; id: string }>(`/api/v1/api-keys/${id}`, { method: 'DELETE' }),
  capabilities: () => request<{ isAdmin: boolean }>('/api/v1/account/capabilities'),
  adminOverview: () => request<AdminOverview>('/api/v1/admin/overview'),
  updateFeatureFlag: (body: { key: string; description: string; enabled: boolean; rolloutJson?: string }) =>
    request<{ flag: AdminOverview['featureFlags'][number] }>('/api/v1/admin/feature-flags', { method: 'PATCH', body: JSON.stringify(body) }),
  intelligencePlans: (body: { query: string; farmId?: string; lat?: number; lon?: number; label?: string }) =>
    request<{ run: AgentRun; plan: IntelligencePlan; canExecute: boolean }>('/api/v1/intelligence/plans', { method: 'POST', body: JSON.stringify(body) }),
  intelligenceRuns: () => request<{ runs: AgentRun[] }>('/api/v1/intelligence/plans'),
  intelligenceRun: (id: string) => request<{ run: AgentRun; plan: IntelligencePlan; result: unknown }>(`/api/v1/intelligence/runs/${id}`),
  approveIntelligenceRun: (id: string) => request<{ run: AgentRun; result: unknown }>(`/api/v1/intelligence/runs/${id}/approve`, { method: 'POST', body: '{}' }),
  health: () => request<{ status: string; dataSources: { datasetName: string; status: string }[] }>('/api/v1/health'),
  regions: () => request<{ regions: RegionPreset[] }>('/api/v1/regions'),
  farms: () => request<{ farms: FarmSummary[] }>('/api/v1/farms'),
  farm: (id: string) => request<{ farm: FarmDetail }>(`/api/v1/farms/${id}`),
  createFarm: (body: { name: string; centroidLat: number; centroidLon: number; country?: string; region?: string; boundaryGeoJson?: string; notes?: string }) =>
    request<{ farm: FarmSummary }>('/api/v1/farms', { method: 'POST', body: JSON.stringify(body) }),
  updateFarm: (id: string, body: Record<string, unknown>) =>
    request<{ farm: FarmDetail }>(`/api/v1/farms/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  soilTests: (farmId: string) => request<{ soilTests: SoilTest[] }>(`/api/v1/farms/${farmId}/soil-tests`),
  addSoilTest: (farmId: string, body: Record<string, unknown>) =>
    request<{ soilTest: SoilTest }>(`/api/v1/farms/${farmId}/soil-tests`, { method: 'POST', body: JSON.stringify(body) }),
  fetchSoilGrids: (farmId: string) =>
    request<{ soilTest: SoilTest; retrieved: { property: string; value: number; unit: string }[] }>(`/api/v1/farms/${farmId}/soil-tests/soilgrids`, { method: 'POST' }),
  crops: () => request<{ catalogueVersion: string; crops: CropDef[] }>('/api/v1/crops'),
  sources: () => request<{ sources: DataSourceRow[]; mapLayers: MapLayerInfo[] }>('/api/v1/observations/sources'),
  observations: (params: { farmId?: string; variable?: string; lat?: number; lon?: number; signal?: AbortSignal }) => {
    const q = new URLSearchParams();
    if (params.farmId) q.set('farmId', params.farmId);
    if (params.variable) q.set('variable', params.variable);
    if (params.lat !== undefined) q.set('lat', String(params.lat));
    if (params.lon !== undefined) q.set('lon', String(params.lon));
    return request<ObservationsResponse>(`/api/v1/observations?${q.toString()}`, { signal: params.signal });
  },
  ingest: (body: { farmId?: string; lat?: number; lon?: number; years?: number }) =>
    request<JobAccepted>('/api/v1/observations/ingest', { method: 'POST', body: JSON.stringify(body) }),
  trends: (body: { farmId?: string; lat?: number; lon?: number }) =>
    request<JobAccepted>('/api/v1/analysis/trends', { method: 'POST', body: JSON.stringify(body) }),
  job: <T>(id: string, signal?: AbortSignal) =>
    request<JobDetail<T>>(`/api/v1/analysis/jobs/${encodeURIComponent(id)}`, { signal }),
  compare: (body: { farmId: string; scenarios: { name: string; cropKeys: string[] }[]; priorities: Record<string, number> }) =>
    request<CompareResponse>('/api/v1/rotation/compare', { method: 'POST', body: JSON.stringify(body) }),
  fires: (params: FireQueryInput) => {
    const q = new URLSearchParams({ from: params.from, to: params.to });
    if ('farmId' in params) q.set('farmId', params.farmId);
    else {
      q.set('lat', String(params.lat));
      q.set('lon', String(params.lon));
    }
    if (params.confidence) q.set('confidence', params.confidence);
    if (params.dayNight) q.set('dayNight', params.dayNight);
    return request<FireQueryResponse>(`/api/v1/fires?${q.toString()}`);
  },
  ingestFires: (body: FireIngestInput) =>
    request<JobAccepted>('/api/v1/fires', { method: 'POST', body: JSON.stringify(body) }),
  watchlists: () => request<WatchlistsResponse>('/api/v1/fires/watchlists'),
  createWatchlist: (body: WatchlistInput) =>
    request<{ watchlist: Watchlist; note: string }>('/api/v1/fires/watchlists', { method: 'POST', body: JSON.stringify(body) }),
  updateWatchlist: (id: string, body: Partial<WatchlistInput>) =>
    request<{ watchlist: Watchlist }>(`/api/v1/fires/watchlists/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteWatchlist: (id: string) =>
    request<{ deleted: { id: string; name: string } }>(`/api/v1/fires/watchlists/${id}`, { method: 'DELETE' }),
  evaluateWatchlist: (id: string, end?: string) =>
    request<JobAccepted>(`/api/v1/fires/watchlists/${id}/evaluate`, { method: 'POST', body: JSON.stringify(end ? { end } : {}) }),
  watchlistRuns: (id: string) =>
    request<WatchlistRunsResponse>(`/api/v1/fires/watchlists/${id}/runs`),
  watchlistDigest: (id: string, hours?: number) =>
    request<WatchDigestResponse>(`/api/v1/fires/watchlists/${id}/digest${hours !== undefined ? `?hours=${hours}` : ''}`),
  provenance: (limit = 50) => request<ProvenanceResponse>(`/api/v1/provenance?limit=${limit}`),
  systemStatus: () => request<SystemStatus>('/api/v1/system/status'),
  systemSources: (force = false) => request<SourcesLiveResponse>(`/api/v1/system/sources${force ? '?force=1' : ''}`),
  reports: () => request<{ reports: { id: string; title: string; format: string; farmId: string | null; createdAt: string }[]; nextCursor: string | null }>('/api/v1/reports'),
  report: (farmId: string, persist = false) => request<ReportResponse>('/api/v1/reports', { method: 'POST', body: JSON.stringify({ farmId, persist }) }),
};
