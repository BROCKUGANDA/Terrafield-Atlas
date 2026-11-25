import { db } from '@/lib/db';
import { ingestPowerForLocation } from '@/lib/ingest/power';
import { analyzeTrend, aggregateAnnual } from '@/lib/stats/analyze';
import { POWER_VARIABLES } from '@/lib/types';
import type { ObservationPoint, VariableKey } from '@/lib/types';
import { fetchFiresForDate, persistFireDetections, FIRE_ARCHIVE_START } from '@/lib/adapters/gibsFires';
import { regionBboxAround, regionKeyFor } from '@/lib/geo';
import { recordIngestCoverage } from '@/lib/fires/coverage';
import { withPrivateProvider } from '@/lib/ingest/provider-context';
import { runWatchlistEvaluation } from '@/lib/fires/watchlist-evaluate';
import { JobPayload, JobType } from '@/lib/queue';
import { recordJobUsage } from '@/lib/commercial';
import { withTenantContext } from '@/lib/tenant-db';
import {
  acquireJobLease,
  acquireConcurrencySlot,
  deadlineExceeded,
  globalConcurrencyCap,
  globalScope,
  isJobCancelled,
  JobCancelledError,
  JobConcurrencyError,
  JobDeadlineExceededError,
  releaseConcurrencySlot,
  releaseJobLease,
  renewJobLease,
  tenantConcurrencyCap,
  tenantScope,
  type JobLease,
} from '@/lib/jobs/runtime';

/**
 * Durable job handlers.
 *
 * INVARIANTS
 *  - Provider work happens OUTSIDE database transactions.
 *  - Every write uses a natural-key upsert, so re-running a job never
 *    duplicates observations or detections.
 *  - The handler checks the cancellation flag and the overall deadline at
 *    cooperative checkpoints, so a cancelled job stops promptly.
 *  - The durable job row is the ledger: it is updated with the terminal state
 *    and the result reference.
 */

export interface JobExecutionContext {
  payload: JobPayload;
  lease: JobLease;
  holder: string;
  /** Cooperative checkpoint: throws on cancellation or deadline overrun. */
  checkpoint(): Promise<void>;
  /** Progress note for the durable job row. */
  progress(note: string): Promise<void>;
  /** Aborted when the job is cancelled or its deadline passes. */
  signal: AbortSignal;
}

export interface JobHandler {
  (ctx: JobExecutionContext): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asNumber(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`job parameter ${field} is not a finite number`);
  return parsed;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`job parameter ${field} is missing`);
  return value;
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`job parameter ${field} is missing`);
  return value.map((item) => String(item));
}

function asIsoDate(value: unknown, field: string): Date | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`job parameter ${field} must be YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error(`job parameter ${field} is not a real calendar date`);
  return date;
}

function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  for (let d = start; d <= end; d = new Date(d.getTime() + 86_400_000)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * A job that writes into a tenant's namespace may carry private coordinates
 * in a provider error. Such errors are never stored in the durable row and
 * never reach the shared queue: the message is replaced before it leaves the
 * worker.
 */
const PRIVATE_JOB_ERROR = 'Private provider request failed. No data was fabricated.';

export function isPrivateJob(payload: JobPayload): boolean {
  const owner = payload.params.ownerId;
  return typeof owner === 'string' && owner.length > 0;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** NASA POWER ingestion for one farm or coordinate. */
const handlePowerIngest: JobHandler = async (ctx) => {
  const params = ctx.payload.params as Record<string, unknown>;
  const lat = asNumber(params.lat, 'lat');
  const lon = asNumber(params.lon, 'lon');
  const years = asNumber(params.years, 'years');
  const variables = asStringArray(params.variables, 'variables') as VariableKey[];
  const farmId = typeof params.farmId === 'string' ? params.farmId : undefined;
  const organizationId = typeof params.organizationId === 'string' ? params.organizationId : null;

  await ctx.checkpoint();
  await ctx.progress('requesting NASA POWER daily API (MERRA-2) in 5-year chunks');
  const outcome = await ingestPowerForLocation(lat, lon, years, variables, farmId, ctx.payload.correlationId, {
    signal: ctx.signal,
    checkpoint: () => ctx.checkpoint(),
    organizationId,
  });
  await ctx.checkpoint();
  await ctx.progress(`wrote ${outcome.rowsWritten} observations (${outcome.chunks} POWER requests)`);
  return outcome;
};

/** Trend detection over stored POWER observations. */
const handleTrends: JobHandler = async (ctx) => {
  const params = ctx.payload.params as Record<string, unknown>;
  const lat = asNumber(params.lat, 'lat');
  const lon = asNumber(params.lon, 'lon');
  const farmId = typeof params.farmId === 'string' ? params.farmId : null;
  const ownerId = typeof params.ownerId === 'string' ? params.ownerId : null;
  const organizationId = typeof params.organizationId === 'string' ? params.organizationId : null;
  const variables = asStringArray(params.variables, 'variables') as VariableKey[];
  const from = asIsoDate(params.from, 'from');
  const to = asIsoDate(params.to, 'to');
  if (from && to && from > to) throw new Error('job parameter from must be on or before to');

  await ctx.checkpoint();
  const rows = await db.environmentalObservation.findMany({
    where: {
      lat, lon, ownerId, organizationId, variable: { in: variables }, ...(farmId ? { farmId } : {}),
      ...(from || to ? { obsDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: new Date(to.getTime() + 86_400_000 - 1) } : {}) } } : {}),
    },
    orderBy: { obsDate: 'asc' },
  });
  if (rows.length === 0) {
    throw new Error(
      `No POWER observations are stored for ${lat.toFixed(3)},${lon.toFixed(3)}. Trends are computed on real observations only, never on synthetic data.`,
    );
  }

  const byVar = new Map<string, ObservationPoint[]>();
  for (const row of rows) {
    const list = byVar.get(row.variable) ?? [];
    list.push({ date: row.obsDate.toISOString().slice(0, 10), value: row.value });
    byVar.set(row.variable, list);
  }

  const periodStart = rows[0].obsDate.toISOString().slice(0, 10);
  const periodEnd = rows[rows.length - 1].obsDate.toISOString().slice(0, 10);

  await ctx.checkpoint();
  const prelim = variables
    .filter((variable) => byVar.has(variable))
    .map((variable) => {
      const meta = POWER_VARIABLES.find((candidate) => candidate.key === variable)!;
      return analyzeTrend({
        variable,
        label: meta.label,
        unit: meta.unit,
        points: byVar.get(variable)!,
        periodStart,
        periodEnd,
      });
    });
  const pValues = prelim.map((result) => (result.pValue === null ? 1 : Math.min(1, Math.max(0, result.pValue))));
  const results = prelim.map((result, index) =>
    result.pValue === null
      ? result
      : analyzeTrend({
          variable: result.variable,
          label: result.label,
          unit: result.unit,
          points: byVar.get(result.variable)!,
          periodStart,
          periodEnd,
          allPValues: pValues,
          pIndex: index,
        }),
  );

  await ctx.checkpoint();
  // Persistence only — no provider call inside the transaction.
  await db.$transaction(async (tx) => {
    for (const result of results) {
      await tx.trendAnalysis.create({
        data: {
          ownerId,
          organizationId,
          farmId,
          lat,
          lon,
          variable: result.variable,
          periodStart: new Date(`${periodStart}T00:00:00Z`),
          periodEnd: new Date(`${periodEnd}T00:00:00Z`),
          sampleCount: result.sampleCount,
          method: result.method,
          slopePerYear: result.slopePerYear,
          pValue: result.pValue,
          zValue: result.zValue,
          direction: result.direction,
          significant: result.significant,
          ciLower: result.ciLower,
          ciUpper: result.ciUpper,
          resultJson: JSON.stringify(result),
          ruleVersion: 'trend-engine/2026.11-r1',
        },
      });
    }
  });

  const annual = Object.fromEntries(
    results.map((result) => [result.variable, aggregateAnnual(result.variable, byVar.get(result.variable) ?? [])]),
  );

  return {
    location: { lat, lon },
    farmId,
    period: { start: periodStart, end: periodEnd },
    observationCount: rows.length,
    datasetVersions: [...new Set(rows.map((row) => row.datasetVersion))],
    multipleTesting: {
      method: 'Benjamini-Hochberg FDR across requested variables',
      testedHypotheses: pValues.length,
    },
    results,
    annualSeries: annual,
  };
};

/** Public VIIRS fire ingestion (shared coverage ledger + natural-key upserts). */
const handleFiresIngest: JobHandler = async (ctx) => {
  const params = ctx.payload.params as Record<string, unknown>;
  const lat = asNumber(params.lat, 'lat');
  const lon = asNumber(params.lon, 'lon');
  const from = asString(params.from, 'from');
  const to = asString(params.to, 'to');
  const regionKey = regionKeyFor(lat, lon);
  const bbox = regionBboxAround(lat, lon);

  let totalDetections = 0;
  let written = 0;
  const noDataDays: string[] = [];
  await ctx.progress(`decoding GIBS VIIRS thermal-anomaly vector tiles for ${dateRange(from, to).length} day(s)`);
  for (const date of dateRange(from, to)) {
    await ctx.checkpoint();
    const result = await fetchFiresForDate(date, bbox, ctx.payload.correlationId, ctx.signal);
    await recordIngestCoverage(lat, lon, date, bbox, result.dataAvailable, result.detections.length);
    if (!result.dataAvailable && result.detections.length === 0) {
      noDataDays.push(date);
      continue;
    }
    totalDetections += result.detections.length;
    written += await persistFireDetections(regionKey, result.detections);
  }
  return {
    region: { key: regionKey, bbox },
    totalDetections,
    rowsWritten: written,
    noDataDays,
    source: 'NASA GIBS VIIRS_SNPP_Thermal_Anomalies_375m_All (VIIRS 375 m detections; the same detection stream NASA FIRMS distributes)',
  };
};

const SNAPSHOT_LIMIT = 5_000;

/** Private per-farm fire snapshot (never written to the shared coverage ledger). */
const handlePrivateFiresSnapshot: JobHandler = async (ctx) => {
  const params = ctx.payload.params as Record<string, unknown>;
  const farmId = asString(params.farmId, 'farmId');
  const lat = asNumber(params.lat, 'lat');
  const lon = asNumber(params.lon, 'lon');
  const from = asString(params.from, 'from');
  const to = asString(params.to, 'to');
  const bbox = regionBboxAround(lat, lon);

  const days: Array<{
    date: string;
    dataAvailable: boolean;
    stale: boolean;
    truncated: boolean;
    detections: unknown[];
  }> = [];
  let totalDetections = 0;
  let stored = 0;
  await ctx.progress('decoding private VIIRS snapshot tiles');
  for (const date of dateRange(from, to)) {
    await ctx.checkpoint();
    const result = await withPrivateProvider(() =>
      fetchFiresForDate(date, bbox, ctx.payload.correlationId, ctx.signal),
    );
    const detections = result.detections.filter(
      (detection) =>
        detection.obsDate === date &&
        detection.latitude >= bbox.south &&
        detection.latitude <= bbox.north &&
        detection.longitude >= bbox.west &&
        detection.longitude <= bbox.east,
    );
    const retained = detections.slice(0, SNAPSHOT_LIMIT - stored);
    totalDetections += detections.length;
    stored += retained.length;
    days.push({
      date,
      dataAvailable: result.dataAvailable,
      stale: result.stale === true,
      truncated: retained.length < detections.length,
      detections: retained,
    });
  }
  return {
    snapshot: { days },
    days,
    farmId,
    region: { key: regionKeyFor(lat, lon), bbox },
    totalDetections,
    rowsWritten: 0,
    privateDetectionsStored: stored,
    truncated: stored < totalDetections,
    noDataDays: days.filter((day) => !day.dataAvailable).map((day) => day.date),
    source: 'NASA GIBS VIIRS_SNPP_Thermal_Anomalies_375m_All; private farm snapshots only',
  };
};

/** Watchlist evaluation (live or backtest) for one watchlist. */
const handleWatchEvaluation: JobHandler = async (ctx) => {
  const params = ctx.payload.params as Record<string, unknown>;
  const watchlistId = asString(params.watchlistId, 'watchlistId');
  const trigger = params.trigger === 'backtest' ? 'backtest' : 'manual';
  const end = typeof params.end === 'string' ? params.end : undefined;

  await ctx.checkpoint();
  const outcome = await runWatchlistEvaluation({
    watchlistId,
    trigger,
    end,
    correlationId: ctx.payload.correlationId,
    actor: `job:${ctx.payload.jobId}`,
    ownerId: ctx.payload.ownerId,
    jobId: ctx.payload.jobId,
  });
  if (!outcome.ok) {
    const error = new Error(outcome.failure.message) as Error & { code?: string };
    error.code = outcome.failure.code;
    throw error;
  }
  return outcome.result;
};

const HANDLERS: Record<JobType, JobHandler> = {
  'power-ingest': handlePowerIngest,
  trends: handleTrends,
  'fires-ingest': handleFiresIngest,
  'private-fires-snapshot-v1': handlePrivateFiresSnapshot,
  'fires-watch-eval': handleWatchEvaluation,
};

export function handlerFor(type: string): JobHandler | undefined {
  return (HANDLERS as Record<string, JobHandler>)[type];
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export type JobTerminalStatus = 'succeeded' | 'failed' | 'cancelled' | 'dead-lettered' | 'skipped';

export interface ExecuteJobResult {
  jobId: string;
  status: JobTerminalStatus;
  error?: string;
  result?: unknown;
  /** true → the job may run again (BullMQ owns the backoff). */
  retryable?: boolean;
}

export interface ExecuteJobOptions {
  /** Identity of the executor (worker id). */
  holder?: string;
  leaseTtlMs?: number;
  /** Skip the Redis concurrency semaphores (used by direct in-process runs). */
  skipConcurrency?: boolean;
  /** Pre-built payload; otherwise it is loaded from the durable row. */
  payload?: JobPayload;
}

/**
 * Execute one durable job: lease → concurrency caps → handler → terminal
 * state. The BullMQ worker and direct in-process test runs share this path.
 */
export async function executeJob(
  jobId: string,
  options: ExecuteJobOptions = {},
): Promise<ExecuteJobResult> {
  const holder = options.holder ?? `worker:${process.pid}:${crypto.randomUUID()}`;
  const leaseTtlMs = options.leaseTtlMs ?? 60_000;

  const row = await db.processingJob.findUnique({ where: { id: jobId } });
  if (!row) return { jobId, status: 'skipped', error: 'job not found' };
  if (row.status === 'succeeded') return { jobId, status: 'skipped', error: 'job already succeeded' };
  if (row.status === 'dead-lettered') return { jobId, status: 'skipped', error: 'job is dead-lettered' };
  if (row.cancelRequested) {
    await db.processingJob.update({
      where: { id: jobId },
      data: { status: 'cancelled', finishedAt: new Date(), progressNote: 'cancelled before execution' },
    });
    return { jobId, status: 'cancelled' };
  }

  const payload: JobPayload = options.payload ?? {
    jobId: row.id,
    type: row.type as JobType,
    ownerId: row.ownerId,
    organizationId: row.organizationId,
    params: JSON.parse(row.params) as Record<string, unknown>,
    correlationId: row.correlationId ?? '',
    deadlineAt: row.deadlineAt ? row.deadlineAt.toISOString() : null,
    maxAttempts: row.maxAttempts,
    attempt: row.attempts + 1,
  };

  const handler = handlerFor(payload.type);
  if (!handler) {
    const error = `unknown job type ${payload.type}`;
    await db.$transaction(async (tx) => {
      await tx.processingJob.update({
        where: { id: jobId },
        data: { status: 'failed', error, finishedAt: new Date() },
      });
      await tx.outboxEvent.create({
        data: {
          aggregateType: 'ProcessingJob',
          aggregateId: jobId,
          eventType: 'job.failed',
          payload: JSON.stringify({ jobId, type: payload.type, ownerId: row.ownerId, organizationId: row.organizationId, error }),
        },
      });
    });
    return { jobId, status: 'failed', error };
  }

  const lease = await acquireJobLease(jobId, holder, leaseTtlMs);
  if (!lease) throw new JobConcurrencyError(`job ${jobId} is leased by another worker`);

  await db.processingJob.update({
    where: { id: jobId },
    data: { attempts: { increment: 1 }, status: 'running', leaseHolder: holder, leaseExpiresAt: lease.expiresAt },
  });

  const controller = new AbortController();
  const member = `${jobId}:${holder}`;
  let globalSlot = false;
  let tenantSlot = false;

  const stopHeartbeat = startHeartbeat(jobId, holder, leaseTtlMs, controller);

  try {
    if (!options.skipConcurrency) {
      globalSlot = await acquireConcurrencySlot(globalScope(), member, globalConcurrencyCap(), leaseTtlMs);
      if (!globalSlot) throw new JobConcurrencyError('global concurrency cap reached');
      tenantSlot = await acquireConcurrencySlot(tenantScope(payload.ownerId, payload.organizationId), member, tenantConcurrencyCap(), leaseTtlMs);
      if (!tenantSlot) throw new JobConcurrencyError('tenant concurrency cap reached');
    }

    const deadlineAt = row.deadlineAt;
    const ctx: JobExecutionContext = {
      payload,
      lease,
      holder,
      signal: controller.signal,
      async checkpoint() {
        if (controller.signal.aborted) {
          throw new JobCancelledError('job was cancelled cooperatively');
        }
        if (deadlineExceeded(deadlineAt)) {
          controller.abort();
          throw new JobDeadlineExceededError();
        }
        if (await isJobCancelled(jobId)) {
          controller.abort();
          throw new JobCancelledError('job was cancelled cooperatively');
        }
      },
      async progress(note: string) {
        await db.processingJob.updateMany({
          where: { id: jobId, leaseHolder: holder },
          data: { progressNote: note },
        });
      },
    };

    const result = await withTenantContext({
      userId: payload.ownerId,
      organizationId: payload.organizationId ?? null,
      organizationName: null,
      role: 'api_service',
      permissions: [],
      isPlatformAdmin: false,
    }, () => handler(ctx));
    await db.$transaction(async (tx) => {
      await tx.processingJob.update({
        where: { id: jobId },
        data: {
          status: 'succeeded',
          resultRef: JSON.stringify(result ?? null),
          progressNote: 'completed',
          finishedAt: new Date(),
          leaseExpiresAt: null,
          leaseHolder: null,
          error: null,
        },
      });
      await recordJobUsage(tx, { id: jobId, ownerId: row.ownerId, organizationId: row.organizationId, type: row.type });
      await tx.outboxEvent.create({
        data: {
          aggregateType: 'ProcessingJob',
          aggregateId: jobId,
          eventType: 'job.succeeded',
          payload: JSON.stringify({ jobId, type: row.type, ownerId: row.ownerId, organizationId: row.organizationId }),
        },
      });
    });
    return { jobId, status: 'succeeded', result };
  } catch (error) {
    const cancelled = error instanceof JobCancelledError;
    const expired = error instanceof JobDeadlineExceededError;
    const raw = error instanceof Error ? error.message : String(error);
    // Private jobs never publish provider details: the durable row and the
    // shared queue only ever see the generic message.
    const message = isPrivateJob(payload) ? PRIVATE_JOB_ERROR : raw;
    const attempts = row.attempts + 1;
    const exhausted = !cancelled && !expired && attempts >= row.maxAttempts;
    const retryable = !cancelled && !expired && !exhausted;
    // A retryable failure returns to the durable queue immediately. BullMQ
    // owns the backoff pointer, while PostgreSQL remains safe to recover even
    // if the process dies before BullMQ emits its failed event.
    const status: JobTerminalStatus = cancelled
      ? 'cancelled'
      : exhausted
        ? 'dead-lettered'
        : 'failed';
    await db.$transaction(async (tx) => {
      await tx.processingJob.update({
        where: { id: jobId },
        data: {
          status: retryable ? 'queued' : status,
          deadLettered: exhausted,
          error: message,
          progressNote: cancelled
            ? 'cancelled cooperatively'
            : expired
              ? 'deadline exceeded'
              : exhausted
                ? 'dead-lettered after exhausting the attempt budget'
                : 'failed — scheduled for retry',
          finishedAt: cancelled || expired || exhausted ? new Date() : null,
          leaseExpiresAt: null,
          leaseHolder: null,
        },
      });
      if (!retryable && !cancelled) {
        await tx.outboxEvent.create({
          data: {
            aggregateType: 'ProcessingJob',
            aggregateId: jobId,
            eventType: 'job.failed',
            payload: JSON.stringify({ jobId, type: row.type, ownerId: row.ownerId, organizationId: row.organizationId, error: message, status }),
          },
        });
      }
    });
    return { jobId, status, error: message, retryable };
  } finally {
    stopHeartbeat();
    if (tenantSlot) await releaseConcurrencySlot(tenantScope(payload.ownerId, payload.organizationId), member).catch(() => undefined);
    if (globalSlot) await releaseConcurrencySlot(globalScope(), member).catch(() => undefined);
    await releaseJobLease(jobId, holder);
  }
}

/**
 * Lease heartbeat. Losing the lease aborts the job: another worker may have
 * taken the job over, so this executor must stop touching shared state.
 */
function startHeartbeat(
  jobId: string,
  holder: string,
  leaseTtlMs: number,
  controller: AbortController,
): () => void {
  const intervalMs = Math.max(1_000, Math.floor(leaseTtlMs / 3));
  const timer = setInterval(() => {
    void renewJobLease(jobId, holder, leaseTtlMs)
      .then((renewed) => {
        if (!renewed) controller.abort();
      })
      .catch(() => controller.abort());
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export { FIRE_ARCHIVE_START };
