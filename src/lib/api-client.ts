'use client';

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = (data as { error?: ApiError } | null)?.error;
    throw new ApiRequestError(res.status, err ?? { code: 'HTTP_' + res.status, message: text.slice(0, 300) || res.statusText });
  }
  return data as T;
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
    jobCounts: { status: string; count: number }[];
    failedJobs: { id: string; type: string; error: string | null; startedAt: string }[];
  };
  cache: { liveEntries: number; expiredEntries: number; maxEntries: number };
  circuitBreakers: { provider: string; consecutiveFailures: number; open: boolean; cooldownRemainingMs: number }[];
  providers: Record<string, { status: string; note?: string }>;
  reliability: Record<string, string>;
  methodology: { trend: string; rotation: string };
}

export interface IngestResponse {
  job: { id: string; status: string; progressNote: string | null; error: string | null };
  outcome: {
    lat: number;
    lon: number;
    start: string;
    end: string;
    rowsWritten: number;
    validPoints: number;
    missingPoints: number;
    chunks: number;
  };
}

export interface ReportResponse {
  generatedAt: string;
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

// ---- calls ----

export const api = {
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
  observations: (params: { farmId?: string; variable?: string }) => {
    const q = new URLSearchParams();
    if (params.farmId) q.set('farmId', params.farmId);
    if (params.variable) q.set('variable', params.variable);
    return request<ObservationsResponse>(`/api/v1/observations?${q.toString()}`);
  },
  ingest: (body: { farmId?: string; lat?: number; lon?: number; years?: number }) =>
    request<IngestResponse>('/api/v1/observations/ingest', { method: 'POST', body: JSON.stringify(body) }),
  trends: (body: { farmId?: string; lat?: number; lon?: number }) =>
    request<TrendAnalysisResponse>('/api/v1/analysis/trends', { method: 'POST', body: JSON.stringify(body) }),
  compare: (body: { farmId: string; scenarios: { name: string; cropKeys: string[] }[]; priorities: Record<string, number> }) =>
    request<CompareResponse>('/api/v1/rotation/compare', { method: 'POST', body: JSON.stringify(body) }),
  fires: (params: { lat: number; lon: number; from: string; to: string; confidence?: string; dayNight?: string }) => {
    const q = new URLSearchParams({ lat: String(params.lat), lon: String(params.lon), from: params.from, to: params.to });
    if (params.confidence) q.set('confidence', params.confidence);
    if (params.dayNight) q.set('dayNight', params.dayNight);
    return request<FireQueryResponse>(`/api/v1/fires?${q.toString()}`);
  },
  ingestFires: (body: { lat?: number; lon?: number; farmId?: string; from: string; to: string }) =>
    request<{ totalDetections: number; rowsWritten: number; noDataDays: string[]; source: string; region: { key: string; bbox: { west: number; south: number; east: number; north: number } } }>('/api/v1/fires', { method: 'POST', body: JSON.stringify(body) }),
  provenance: (limit = 50) => request<ProvenanceResponse>(`/api/v1/provenance?limit=${limit}`),
  systemStatus: () => request<SystemStatus>('/api/v1/system/status'),
  report: (farmId: string) => request<ReportResponse>('/api/v1/reports', { method: 'POST', body: JSON.stringify({ farmId }) }),
};
