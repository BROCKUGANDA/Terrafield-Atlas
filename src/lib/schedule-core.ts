/**
 * Pure scheduling core for watchlist re-evaluation — no I/O, fully testable.
 *
 * The runtime wiring (Prisma queries, the live evaluation call, the interval
 * timer) lives in `lib/scheduler.ts`; this module owns the WHEN and HOW-MANY:
 * which cadences exist, when a watchlist is next due, and what one scheduler
 * tick does. `runSchedulerTick` receives all side effects as injected deps, so
 * tests exercise the exact production orchestration with in-memory fakes.
 *
 * Claim-before-run: `nextReevaluateAt` is advanced BEFORE the evaluation
 * executes. If the process dies mid-run the watchlist is simply late by one
 * cadence period — it can never hot-loop.
 */

/** Allowed re-evaluation cadences (minutes). `null`/absent = manual only. */
export const REEVALUATE_INTERVALS = [360, 720, 1440] as const;
export type ReevaluateIntervalMin = (typeof REEVALUATE_INTERVALS)[number];

export const REEVALUATE_LABELS: Record<ReevaluateIntervalMin, string> = {
  360: 'every 6 h',
  720: 'every 12 h',
  1440: 'every 24 h',
};

export function isReevaluateInterval(v: unknown): v is ReevaluateIntervalMin {
  return typeof v === 'number' && (REEVALUATE_INTERVALS as readonly number[]).includes(v);
}

/** Next due time = now + interval minutes (exact, no drift accumulation). */
export function nextRunAfter(nowMs: number, intervalMin: ReevaluateIntervalMin): Date {
  return new Date(nowMs + intervalMin * 60_000);
}

export interface SchedulableWatch {
  id: string;
  name: string;
  reevaluateIntervalMin: number | null;
  nextReevaluateAt: Date | string | null;
}

/** A watchlist is due when a cadence is set and the claimed time has arrived. */
export function isDue(w: SchedulableWatch, now: Date): boolean {
  if (!isReevaluateInterval(w.reevaluateIntervalMin)) return false;
  if (w.nextReevaluateAt === null || w.nextReevaluateAt === undefined) return true; // never claimed (e.g. legacy row)
  const t = w.nextReevaluateAt instanceof Date ? w.nextReevaluateAt.getTime() : new Date(w.nextReevaluateAt).getTime();
  return Number.isFinite(t) && t <= now.getTime();
}

/** Due watchlists, oldest claim first (fair ordering), capped at `maxRuns`. */
export function selectDueWatchlists(rows: SchedulableWatch[], now: Date, maxRuns: number): SchedulableWatch[] {
  const stamp = (w: SchedulableWatch): number => {
    if (w.nextReevaluateAt === null || w.nextReevaluateAt === undefined) return 0; // unclaimed → most urgent
    const t = w.nextReevaluateAt instanceof Date ? w.nextReevaluateAt.getTime() : new Date(w.nextReevaluateAt).getTime();
    return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
  };
  return rows
    .filter((w) => isDue(w, now))
    .sort((a, b) => stamp(a) - stamp(b))
    .slice(0, Math.max(0, Math.floor(maxRuns)));
}

export interface TickRunResult {
  watchlistId: string;
  name: string;
  ok: boolean;
  status?: string;
  detectionCount?: number;
  error?: string;
  claimedNextAt: string;
  correlationId: string;
}

export interface TickResult {
  tickAt: string;
  candidates: number;
  dueCount: number;
  ran: number;
  skippedRunning: boolean;
  runs: TickRunResult[];
}

/** Side effects of one tick, injected. The real implementation lives in lib/scheduler.ts. */
export interface TickDeps {
  now: Date;
  /** Per-tick evaluation budget (protects the single runtime from GIBS storms). */
  maxRuns: number;
  /** All watchlists with a cadence set (due or not). */
  listCandidates(): Promise<SchedulableWatch[]>;
  /** Claim the next run: persist nextReevaluateAt BEFORE evaluating. */
  claim(w: SchedulableWatch, nextAt: Date): Promise<void>;
  /** Run the live evaluation; resolves with status/count or throws. */
  evaluate(w: SchedulableWatch, ctx: { correlationId: string; now: Date }): Promise<{ status: string; detectionCount: number }>;
  /** Persist the outcome for the operator (audit ledger). */
  recordOutcome(
    w: SchedulableWatch,
    outcome: { ok: true; status: string; detectionCount: number; claimedNextAt: Date; correlationId: string } | { ok: false; error: string; claimedNextAt: Date; correlationId: string },
  ): Promise<void>;
  /** True when the same watchlist already has an evaluation in flight. */
  isInFlight(w: SchedulableWatch): boolean;
}

/** Correlation ID for scheduler-triggered evaluations (fits the 4–64 char contract). */
export function schedulerCorrelationId(w: SchedulableWatch, now: Date): string {
  return `sched-${now.getTime().toString(36)}-${w.id.slice(-8)}`;
}

export async function runSchedulerTick(deps: TickDeps): Promise<TickResult> {
  const candidates = await deps.listCandidates();
  const due = selectDueWatchlists(candidates, deps.now, deps.maxRuns * 2); // headroom for in-flight skips
  const runs: TickRunResult[] = [];

  for (const w of due) {
    if (runs.length >= deps.maxRuns) break;
    if (deps.isInFlight(w)) continue; // a manual/scheduled run is already executing — try next tick
    const interval = w.reevaluateIntervalMin as ReevaluateIntervalMin;
    const claimedNextAt = nextRunAfter(deps.now.getTime(), interval);
    const correlationId = schedulerCorrelationId(w, deps.now);
    await deps.claim(w, claimedNextAt);
    try {
      const res = await deps.evaluate(w, { correlationId, now: deps.now });
      await deps.recordOutcome(w, { ok: true, status: res.status, detectionCount: res.detectionCount, claimedNextAt, correlationId });
      runs.push({ watchlistId: w.id, name: w.name, ok: true, status: res.status, detectionCount: res.detectionCount, claimedNextAt: claimedNextAt.toISOString(), correlationId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await deps.recordOutcome(w, { ok: false, error: msg, claimedNextAt, correlationId });
      runs.push({ watchlistId: w.id, name: w.name, ok: false, error: msg, claimedNextAt: claimedNextAt.toISOString(), correlationId });
    }
  }

  return {
    tickAt: deps.now.toISOString(),
    candidates: candidates.length,
    dueCount: due.length,
    ran: runs.length,
    skippedRunning: due.length > runs.length,
    runs,
  };
}
