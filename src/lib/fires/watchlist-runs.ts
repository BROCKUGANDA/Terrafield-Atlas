/**
 * Scheduler-run history for one watchlist — assembled from two ledgers.
 *
 * The database-leased scheduler (lib/scheduler.ts) records EVERY run in the audit
 * ledger:
 *
 *   - action 'watchlist.schedule.run'  → the run succeeded (status + count)
 *   - action 'watchlist.schedule.fail' → the run FAILED (error message)
 *
 * Successful runs additionally write a FireWatchEvent row (the evaluation
 * itself) carrying the SAME correlationId as their audit entry. Failed runs
 * write NO FireWatchEvent — no status was ever computed — so the audit ledger
 * is the only place they exist. This module merges both sources into one
 * chronological run history.
 *
 * The parsing/merging is pure (no I/O) and unit-tested; the route module owns
 * the Prisma reads.
 */

/** Minimal shape of an audit-ledger row as stored by lib/scheduler.ts. */
export interface SchedulerAuditRow {
  action: string; // 'watchlist.schedule.run' | 'watchlist.schedule.fail'
  createdAt: Date;
  detail: string | null; // JSON written by the scheduler's recordOutcome
}

/** What one scheduler audit row says, parsed defensively. */
export interface ParsedSchedulerRun {
  kind: 'run' | 'fail';
  /** Audit-row timestamp (ISO) — when the outcome was recorded. */
  at: string;
  /** Correlation ID shared with the FireWatchEvent on successful runs. */
  correlationId: string | null;
  /** nextReevaluateAt claimed BEFORE the run (claim-before-run ordering). */
  claimedNextAt: string | null;
  status: string | null; // run rows ('clear' | 'watch' | 'alert' | ...)
  detectionCount: number | null; // run rows
  error: string | null; // fail rows
}

export function parseSchedulerAuditRow(row: SchedulerAuditRow): ParsedSchedulerRun | null {
  if (row.action !== 'watchlist.schedule.run' && row.action !== 'watchlist.schedule.fail') return null;
  let detail: Record<string, unknown> = {};
  try {
    detail = row.detail ? (JSON.parse(row.detail) as Record<string, unknown>) : {};
  } catch {
    detail = {}; // corrupt ledger detail — still emit an entry, degrade fields
  }
  const correlationId = typeof detail.correlationId === 'string' ? detail.correlationId : null;
  const claimedNextAt = typeof detail.nextReevaluateAt === 'string' ? detail.nextReevaluateAt : null;
  const base = { at: row.createdAt.toISOString(), correlationId, claimedNextAt };
  if (row.action === 'watchlist.schedule.fail') {
    return {
      kind: 'fail',
      ...base,
      status: null,
      detectionCount: null,
      error: typeof detail.error === 'string' ? detail.error : 'unknown error (ledger detail unreadable)',
    };
  }
  return {
    kind: 'run',
    ...base,
    status: typeof detail.status === 'string' ? detail.status : null,
    detectionCount: typeof detail.detectionCount === 'number' ? detail.detectionCount : null,
    error: null,
  };
}

/** A serialized FireWatchEvent (serializeEvent output) or anything with a correlationId. */
export interface RunHistoryEventLike {
  correlationId: string | null;
}

export interface SchedulerRunEntry {
  kind: 'run' | 'fail';
  at: string;
  correlationId: string | null;
  claimedNextAt: string | null;
  status: string | null;
  detectionCount: number | null;
  error: string | null;
  /** The full evaluation record for successful runs, matched by correlationId. */
  evaluation: RunHistoryEventLike | null;
}

/**
 * Merge scheduler audit rows with evaluation events, newest first.
 *
 * - `auditRows` come from the DB (any order — this function sorts desc by `at`);
 *   each row becomes one entry, capped at `cap` (newest kept).
 * - `events` are candidate FireWatchEvent serializations; each audit entry with
 *   a correlationId is enriched with its matching event when one exists.
 * - Failed runs keep `evaluation: null` — no evaluation was ever written.
 */
export function buildRunHistory<T extends RunHistoryEventLike>(
  auditRows: SchedulerAuditRow[],
  events: T[],
  cap = 50,
): (Omit<SchedulerRunEntry, 'evaluation'> & { evaluation: T | null })[] {
  const byCorrelation = new Map<string, T>();
  for (const e of events) {
    if (e.correlationId) byCorrelation.set(e.correlationId, e);
  }
  return auditRows
    .map(parseSchedulerAuditRow)
    .filter((r): r is ParsedSchedulerRun => r !== null)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, Math.max(1, cap))
    .map((r) => ({
      kind: r.kind,
      at: r.at,
      correlationId: r.correlationId,
      claimedNextAt: r.claimedNextAt,
      status: r.status,
      detectionCount: r.detectionCount,
      error: r.error,
      evaluation: r.correlationId ? (byCorrelation.get(r.correlationId) ?? null) : null,
    }));
}
