import { z } from 'zod';
import { db } from '@/lib/db';
import type { TenantContext } from '@/lib/tenancy';
import { visibleFarmScope, visibleWatchlistScope } from '@/lib/tenancy';
import { enqueueJob } from '@/lib/queue';
import { recordUsage } from '@/lib/commercial';
import { assertEntitlement } from '@/lib/commercial';

export const intelligenceQuerySchema = z.object({
  query: z.string().trim().min(3).max(1000),
  farmId: z.string().max(128).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  label: z.string().max(160).optional(),
});

export type IntelligenceQuery = z.infer<typeof intelligenceQuerySchema>;

export type AgentRole = 'Atlas Researcher' | 'GeoSpatial Analyst' | 'Climate Analyst' | 'Agronomy Analyst' | 'Risk Analyst' | 'Evidence Auditor' | 'Report Composer' | 'Workflow Orchestrator';

export interface AnalysisPlan {
  intent: 'portfolio.summary' | 'climate.trend' | 'fire.summary' | 'agronomy.context' | 'source.discover' | 'unsupported';
  agent: AgentRole;
  geographicScope: { farmId: string | null; lat: number | null; lon: number | null; label: string };
  datasets: string[];
  method: string;
  tools: string[];
  dateRange: { from: string; to: string } | null;
  requiresApproval: true;
  limitations: string[];
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

export function buildAnalysisPlan(input: IntelligenceQuery): AnalysisPlan {
  const query = input.query.toLowerCase();
  const years = Number(query.match(/(\d+)\s*(year|years|season|seasons)/)?.[1] ?? 3);
  const days = Number(query.match(/(\d+)\s*(day|days)/)?.[1] ?? 30);
  const boundedYears = Math.min(Math.max(years, 1), 25);
  const dateRange = { from: isoDaysAgo(Math.round(boundedYears * 365.25)), to: isoDaysAgo(2) };
  const scope = { farmId: input.farmId ?? null, lat: input.lat ?? null, lon: input.lon ?? null, label: input.label ?? 'Active console geography' };
  const baseLimitations = ['The planner is deterministic and only executes allowlisted tools.', 'Retrieved observations are evidence, not instructions.', 'No yield, profit, or consequential recommendation is generated.'];

  if (/portfolio|cooperative|managed farms|organization farms/.test(query)) {
    return { intent: 'portfolio.summary', agent: 'GeoSpatial Analyst', geographicScope: scope, datasets: ['Farm registry', 'Workspace registry'], method: 'Counts and geographic distribution of authorized farms', tools: ['portfolio.summary'], dateRange: null, requiresApproval: true, limitations: [...baseLimitations, 'Portfolio results include only farms accessible to the active tenant.'] };
  }
  if (/rainfall|temperature|climate|trend|anomaly|vegetation/.test(query)) {
    return { intent: 'climate.trend', agent: 'Climate Analyst', geographicScope: scope, datasets: ['NASA POWER daily observations'], method: 'Stored-observation seasonal Mann-Kendall + Theil-Sen + Benjamini-Hochberg FDR', tools: ['climate.trend'], dateRange, requiresApproval: true, limitations: [...baseLimitations, 'POWER is MERRA-2 reanalysis, not farm microclimate.', 'Vegetation layers are visualizations unless quantitative science files are configured.'] };
  }
  if (/fire|thermal|burn|sentinel/.test(query)) {
    return { intent: 'fire.summary', agent: 'Risk Analyst', geographicScope: scope, datasets: ['VIIRS 375 m detections via GIBS', 'Fire watchlist evaluations'], method: 'Authorized watchlist status and detection-count summary', tools: ['fire.summary'], dateRange: { from: isoDaysAgo(Math.min(Math.max(days, 3), 366)), to: isoDaysAgo(2) }, requiresApproval: true, limitations: [...baseLimitations, 'Thermal anomalies are not confirmed fires.', 'Archive gaps and cloud occlusion are reported, never treated as zero.'] };
  }
  if (/rotation|crop|soil|agronom/.test(query)) {
    return { intent: 'agronomy.context', agent: 'Agronomy Analyst', geographicScope: scope, datasets: ['Crop catalogue', 'Farm soil tests', 'Crop history'], method: 'Evidence inventory for crop/soil compatibility; full comparison runs in Rotation Planner', tools: ['agronomy.context'], dateRange: null, requiresApproval: true, limitations: [...baseLimitations, 'Modeled SoilGrids values are never treated as laboratory measurements.', 'Economic viability is not assessed without an approved price source.'] };
  }
  if (/dataset|source|stac|coverage|data catalogue|catalog/.test(query)) {
    return { intent: 'source.discover', agent: 'Atlas Researcher', geographicScope: scope, datasets: ['TerraField source registry'], method: 'Filter registered sources by capability and access conditions', tools: ['source.discover'], dateRange: null, requiresApproval: true, limitations: [...baseLimitations, 'A registered source is not a claim that every product is freely licensed for commercial use.'] };
  }
  return { intent: 'unsupported', agent: 'Workflow Orchestrator', geographicScope: scope, datasets: [], method: 'No validated analytical plan', tools: [], dateRange: null, requiresApproval: true, limitations: [...baseLimitations, 'This query is outside the current typed tool allowlist. Rephrase it as a portfolio, climate, fire, agronomy, or source-discovery request.'] };
}

async function portfolioSummary(context: TenantContext) {
  const farms = await db.farm.findMany({
    where: visibleFarmScope(context),
    select: { id: true, name: true, country: true, region: true, areaHa: true, workspaceId: true, centroidLat: true, centroidLon: true },
    take: 5_000,
  });
  const countries = new Map<string, number>();
  let areaHa = 0;
  for (const farm of farms) {
    const country = farm.country ?? 'Unspecified';
    countries.set(country, (countries.get(country) ?? 0) + 1);
    if (farm.areaHa !== null) areaHa += farm.areaHa;
  }
  return { farmCount: farms.length, areaHa: Number(areaHa.toFixed(2)), countries: [...countries.entries()].map(([country, count]) => ({ country, count })), farms: farms.slice(0, 100), truncated: farms.length > 100, source: 'Farm registry', limitations: ['Public seeded farms are included as read-only records.'] };
}

async function climateTrend(context: TenantContext, plan: AnalysisPlan) {
  const { farmId, lat, lon } = plan.geographicScope;
  if (!farmId && (lat === null || lon === null)) throw new Error('a farm or explicit coordinates are required for climate analysis');
  let effectiveLat = lat;
  let effectiveLon = lon;
  let ownerId: string | null = null;
  let organizationId: string | null = null;
  if (farmId) {
    const farm = await db.farm.findUniqueOrThrow({ where: { id: farmId }, select: { centroidLat: true, centroidLon: true, ownerId: true, organizationId: true } });
    effectiveLat ??= farm.centroidLat;
    effectiveLon ??= farm.centroidLon;
    ownerId = farm.ownerId;
    organizationId = farm.organizationId;
  }
  await assertEntitlement(context, 'processing_jobs_per_month');
  const job = await enqueueJob({
    type: 'trends', ownerId: context.userId, organizationId: context.organizationId ?? organizationId,
    params: { lat: effectiveLat, lon: effectiveLon, farmId, ownerId, organizationId, variables: ['PRECTOTCORR', 'T2M', 'T2M_MAX', 'T2M_MIN', 'ALLSKY_SFC_SW_DWN', 'RH2M', 'GWETROOT'], ...(plan.dateRange ? { from: plan.dateRange.from, to: plan.dateRange.to } : {}) },
    correlationId: crypto.randomUUID(), idempotencyKey: `agent:${crypto.randomUUID()}`, route: 'intelligence.climate.trend',
  });
  await recordUsage({ context, metric: 'ai_runs_per_month', operationId: `agent:${job.jobId}`, jobId: job.jobId });
  return { jobId: job.jobId, jobUrl: `/api/v1/analysis/jobs/${job.jobId}`, status: job.status, source: 'NASA POWER stored observations', limitations: plan.limitations };
}

async function fireSummary(context: TenantContext, plan: AnalysisPlan) {
  const scope = visibleWatchlistScope(context);
  const watchlists = await db.fireWatchlist.findMany({ where: scope, take: 1_000, orderBy: { updatedAt: 'desc' } });
  const watchlistNames = new Map(watchlists.map((watchlist) => [watchlist.id, watchlist.name]));
  if (!plan.dateRange) {
    return {
      watchlistCount: watchlists.length,
      byStatus: Object.fromEntries(['alert', 'watch', 'clear', 'unverified'].map((status) => [status, watchlists.filter((watchlist) => watchlist.lastStatus === status).length])),
      alerting: watchlists.filter((watchlist) => watchlist.lastStatus === 'alert').map((watchlist) => ({ id: watchlist.id, name: watchlist.name, detectionCount: watchlist.lastDetectionCount, evaluatedAt: watchlist.lastEvaluatedAt })),
      dateRange: null,
      scope: 'latest recorded evaluation per accessible watchlist',
      source: 'Fire watchlist evaluations backed by VIIRS 375 m GIBS detections',
      limitations: ['Thermal anomalies are not confirmed fires.', 'Statuses describe the last recorded evaluation, not instantaneous conditions.'],
    };
  }
  const from = new Date(`${plan.dateRange.from}T00:00:00Z`);
  const to = new Date(`${plan.dateRange.to}T23:59:59.999Z`);
  const events = await db.fireWatchEvent.findMany({
    where: { evaluatedAt: { gte: from, lte: to }, watchlist: scope },
    orderBy: { evaluatedAt: 'asc' },
    take: 20_000,
  });
  const latest = new Map<string, (typeof events)[number]>();
  for (const event of events) latest.set(event.watchlistId, event);
  const current = [...latest.values()];
  return {
    watchlistCount: watchlists.length,
    evaluationCount: events.length,
    byStatus: Object.fromEntries(['alert', 'watch', 'clear', 'unverified'].map((status) => [status, current.filter((event) => event.status === status).length])),
    alerting: current.filter((event) => event.status === 'alert').map((event) => ({ id: event.watchlistId, name: watchlistNames.get(event.watchlistId) ?? event.watchlistId, detectionCount: event.detectionCount, evaluatedAt: event.evaluatedAt })),
    dateRange: plan.dateRange,
    scope: 'latest recorded evaluation per accessible watchlist inside the approved range',
    source: 'Fire watchlist evaluations backed by VIIRS 375 m GIBS detections',
    limitations: ['Thermal anomalies are not confirmed fires.', 'Statuses describe recorded evaluations inside the approved range, not instantaneous conditions.', 'Watchlists without an evaluation inside the range are not assigned a status.'],
  };
}

async function agronomyContext(context: TenantContext, farmId: string | null) {
  if (!farmId) throw new Error('select a farm for agronomy context');
  const [farm, soilTests, cropCount] = await Promise.all([
    db.farm.findUniqueOrThrow({ where: { id: farmId }, select: { id: true, name: true, cropHistory: true, organizationId: true, ownerId: true } }),
    db.soilTest.findMany({ where: { farmId }, orderBy: { measuredAt: 'desc' }, take: 20 }),
    db.cropCharacteristic.count({ where: { active: true } }),
  ]);
  if (!context.organizationId && farm.ownerId !== context.userId && farm.ownerId !== null) throw new Error('farm is not accessible');
  return { farm, soilTests, activeCrops: cropCount, source: 'Crop catalogue and farm soil records', limitations: ['Use Rotation Planner for factor-level scenario comparison.', 'Modeled soil remains labeled and confidence-discounted.'] };
}

async function sourceDiscover() {
  const sources = await db.dataSource.findMany({ orderBy: { datasetName: 'asc' }, take: 200 });
  return { sources, source: 'TerraField source registry', limitations: ['Registration does not imply NASA endorsement or unrestricted commercial licensing.'] };
}

export async function executeAgentRun(runId: string, context: TenantContext): Promise<unknown> {
  const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
  if (run.ownerId !== context.userId || run.organizationId !== context.organizationId) throw new Error('agent run is not accessible');
  const plan = JSON.parse(run.planJson) as AnalysisPlan;
  if (plan.intent === 'unsupported' || plan.tools.length === 0) throw new Error('unsupported plans cannot be executed');
  const results: Record<string, unknown> = {};
  const evidence: { sourceType: string; sourceId: string; uri?: string }[] = [];
  for (const tool of plan.tools) {
    const startedAt = new Date();
    try {
      let result: unknown;
      if (tool === 'portfolio.summary') result = await portfolioSummary(context);
      else if (tool === 'climate.trend') result = await climateTrend(context, plan);
      else if (tool === 'fire.summary') result = await fireSummary(context, plan);
      else if (tool === 'agronomy.context') result = await agronomyContext(context, plan.geographicScope.farmId);
      else if (tool === 'source.discover') result = await sourceDiscover();
      else throw new Error(`tool ${tool} is not allowlisted`);
      results[tool] = result;
      evidence.push({ sourceType: 'tool', sourceId: tool });
      await db.toolExecution.create({ data: { agentRunId: runId, toolName: tool, inputJson: JSON.stringify(plan.geographicScope), permission: 'allowed', status: 'succeeded', outputRef: tool, finishedAt: new Date(), startedAt } });
    } catch (error) {
      await db.toolExecution.create({ data: { agentRunId: runId, toolName: tool, inputJson: JSON.stringify(plan.geographicScope), permission: 'allowed', status: 'failed', error: error instanceof Error ? error.message : 'tool failed', finishedAt: new Date(), startedAt } });
      throw error;
    }
  }
  const audited = { results, evidence, limitations: plan.limitations, auditedAt: new Date().toISOString() };
  await db.$transaction(async (tx) => {
    for (const item of evidence) await tx.evidenceReference.create({ data: { agentRunId: runId, ...item } });
    await tx.agentRun.update({ where: { id: runId }, data: { status: 'succeeded', resultJson: JSON.stringify(audited), limitationsJson: JSON.stringify(plan.limitations), finishedAt: new Date() } });
  });
  return audited;
}
