import { db } from '@/lib/db';
import {
  runSchedulerTick,
  selectDueWatchlists,
  type SchedulableWatch,
  type TickResult,
} from '@/lib/schedule-core';
import { runWatchlistEvaluation } from '@/lib/fires/watchlist-evaluate';
import { publishDigestForWatchlist } from '@/lib/fires/digest-channel';

/**
 * In-process background scheduler for watchlist re-evaluation.
 *
 * Topology note (documented deviation in docs/ARCHITECTURE.md): the runtime is
 * ONE Node process — no broker, no worker tier. Rather than leave alert
 * freshness to manual clicks, this module runs a real scheduler INSIDE that
 * process, started from `instrumentation.ts` when the server boots. It:
 *
 *  - ticks every 60 s (timer is unref'd: it never keeps the process alive);
 *  - claims due watchlists (advances nextReevaluateAt BEFORE running, so a
 *    crash can never hot-loop a failing evaluation);
 *  - runs at most MAX_RUNS_PER_TICK live evaluations per tick, sequentially —
 *    GIBS traffic stays bounded and SQLite stays single-writer friendly;
 *  - skips a watchlist whose evaluation is already in flight this process;
 *  - records every scheduled run (success or failure) in the audit ledger;
 *  - is disabled entirely with WATCH_SCHEDULER_OFF=1 (surfaced in
 *    /api/v1/system/status).
 *
 * Cadences are opt-in PER WATCHLIST (reevaluateIntervalMin: 360 | 720 | 1440);
 * with none enabled the timer does no provider traffic at all.
 */

const TICK_MS = 60_000;
export const MAX_RUNS_PER_TICK = 5;

interface SchedulerRuntime {
  timer: ReturnType<typeof setInterval> | null;
  enabled: boolean;
  startedAt: Date | null;
  lastTickAt: Date | null;
  lastTick: TickResult | null;
  running: boolean;
  ticksFired: number;
  ticksSkippedBusy: number;
  consecutiveFailedRuns: number;
}

const runtimeHost = globalThis as unknown as { __terraSchedulerRuntime?: SchedulerRuntime };

function runtime(): SchedulerRuntime {
  if (!runtimeHost.__terraSchedulerRuntime) {
    runtimeHost.__terraSchedulerRuntime = {
      timer: null,
      enabled: false,
      startedAt: null,
      lastTickAt: null,
      lastTick: null,
      running: false,
      ticksFired: 0,
      ticksSkippedBusy: 0,
      consecutiveFailedRuns: 0,
    };
  }
  return runtimeHost.__terraSchedulerRuntime;
}

/** In-flight evaluation registry shared with nothing else — best-effort skip. */
const inFlight = new Set<string>();

// --- real TickDeps, bound to Prisma + the shared evaluation core ---

async function listCandidates(): Promise<SchedulableWatch[]> {
  const rows = await db.fireWatchlist.findMany({
    where: { reevaluateIntervalMin: { not: null } },
    select: { id: true, name: true, reevaluateIntervalMin: true, nextReevaluateAt: true },
  });
  return rows;
}

/**
 * ATOMIC claim (race-safe). The blind `update` this used to be could double-
 * run a watchlist when two claimants raced between read and write (e.g. dev
 * HMR double-register or a manual evaluate landing mid-tick). Now the claim
 * is a single conditional UPDATE: it only advances nextReevaluateAt when the
 * row is STILL due (null or <= now), and reports whether THIS caller won.
 * A loser simply skips — the winner runs the evaluation.
 */
async function claim(w: SchedulableWatch, nextAt: Date, now: Date): Promise<boolean> {
  const res = await db.fireWatchlist.updateMany({
    where: {
      id: w.id,
      OR: [{ nextReevaluateAt: null }, { nextReevaluateAt: { lte: now } }],
    },
    data: { nextReevaluateAt: nextAt },
  });
  return res.count === 1;
}

async function evaluate(w: SchedulableWatch, ctx: { correlationId: string; now: Date }): Promise<{ status: string; detectionCount: number }> {
  inFlight.add(w.id);
  try {
    const outcome = await runWatchlistEvaluation({
      watchlistId: w.id,
      trigger: 'scheduled',
      end: undefined, // live semantics: window ends yesterday
      correlationId: ctx.correlationId,
      actor: 'system:scheduler',
      now: ctx.now,
    });
    if (!outcome.ok) throw new Error(outcome.failure.message);
    return { status: outcome.result.evaluation.status, detectionCount: outcome.result.evaluation.detectionCount };
  } finally {
    inFlight.delete(w.id);
  }
}

async function recordOutcome(
  w: SchedulableWatch,
  outcome:
    | { ok: true; status: string; detectionCount: number; claimedNextAt: Date; correlationId: string }
    | { ok: false; error: string; claimedNextAt: Date; correlationId: string },
): Promise<void> {
  if (outcome.ok) runtime().consecutiveFailedRuns = 0;
  else runtime().consecutiveFailedRuns += 1;
  await db.auditEvent.create({
    data: {
      actor: 'system:scheduler',
      action: outcome.ok ? 'watchlist.schedule.run' : 'watchlist.schedule.fail',
      targetId: w.id,
      detail: JSON.stringify(
        outcome.ok
          ? { status: outcome.status, detectionCount: outcome.detectionCount, nextReevaluateAt: outcome.claimedNextAt.toISOString(), correlationId: outcome.correlationId }
          : { error: outcome.error, nextReevaluateAt: outcome.claimedNextAt.toISOString(), correlationId: outcome.correlationId },
      ),
    },
  });
  // Push-style digest delivery: successful runs publish through the shared
  // evaluation core (it records the event itself); FAILED runs write no
  // evaluation event, so THIS is the only place a failure becomes a digest
  // push. Fire-and-forget — the ledger row above is already the durable
  // record, and with zero open consoles this costs nothing.
  if (!outcome.ok) {
    void publishDigestForWatchlist(w.id, 'scheduled-failure', {
      correlationId: outcome.correlationId,
      triggeredAt: new Date(),
    });
  }
}

// --- lifecycle ---

async function tickOnce(): Promise<void> {
  const rt = runtime();
  if (!rt.enabled || rt.running) {
    if (rt.running) rt.ticksSkippedBusy += 1;
    return;
  }
  rt.running = true;
  try {
    const result = await runSchedulerTick({
      now: new Date(),
      maxRuns: MAX_RUNS_PER_TICK,
      listCandidates,
      claim,
      evaluate,
      recordOutcome,
      isInFlight: (w) => inFlight.has(w.id),
    });
    rt.lastTickAt = new Date();
    rt.lastTick = result;
    rt.ticksFired += 1;
    if (result.runs.some((r) => !r.ok)) {
      console.warn(`[scheduler] tick at ${result.tickAt} recorded ${result.runs.filter((r) => !r.ok).length} failed run(s)`);
    }
  } catch (err) {
    rt.lastTickAt = new Date();
    console.error('[scheduler] tick failed:', err instanceof Error ? err.message : err);
  } finally {
    rt.running = false;
  }
}

/** Lightweight live state for the SSE digest stream's hello payload (no DB read). */
export function schedulerEnabled(): boolean {
  return runtime().enabled;
}

/** Tick period in seconds (fixed by this module). */
export function schedulerStatusTickSec(): number {
  return TICK_MS / 1_000;
}

/** Readiness heartbeat: is the tick timer alive and current? Pure runtime read. */
export function schedulerHeartbeat(): { enabled: boolean; tickEverySec: number; staleSec: number | null } {
  const rt = runtime();
  return {
    enabled: rt.enabled,
    tickEverySec: TICK_MS / 1_000,
    staleSec: rt.lastTickAt ? (Date.now() - rt.lastTickAt.getTime()) / 1000 : null,
  };
}

/**
 * Watchdog restart (called from instrumentation's process watchdog): if the
 * timer is enabled but the last tick is stale beyond 3 periods (a hung or
 * cleared interval — dev HMR can do this), restart it. Idempotent and cheap.
 */
export function ensureSchedulerAlive(): boolean {
  const rt = runtime();
  if (!rt.enabled) return false;
  if (rt.running) return true; // mid-tick: alive by definition
  const staleMs = rt.lastTickAt ? Date.now() - rt.lastTickAt.getTime() : Infinity;
  if (staleMs > TICK_MS * 3) {
    console.warn(`[scheduler] watchdog: last tick ${Math.round(staleMs / 1000)}s ago — restarting timer`);
    if (rt.timer) clearInterval(rt.timer);
    rt.timer = setInterval(() => void tickOnce(), TICK_MS);
    rt.timer.unref?.();
    void tickOnce();
    return true;
  }
  return true;
}

/** Start the interval timer (idempotent; no-op when WATCH_SCHEDULER_OFF=1). */
export function startScheduler(): void {
  const rt = runtime();
  if (process.env.WATCH_SCHEDULER_OFF === '1') {
    rt.enabled = false;
    console.log('[scheduler] disabled by WATCH_SCHEDULER_OFF=1 — watchlists re-evaluate on demand only');
    return;
  }
  if (rt.timer) return; // already started (dev HMR / double register)
  rt.enabled = true;
  rt.startedAt = new Date();
  rt.timer = setInterval(() => void tickOnce(), TICK_MS);
  rt.timer.unref?.(); // never hold the process open just for the scheduler
  console.log(`[scheduler] started — in-process watchlist re-evaluation, tick ${TICK_MS / 1000}s, max ${MAX_RUNS_PER_TICK} run(s)/tick`);
}

/** Diagnostics for /api/v1/system/status (one cheap DB aggregate included). */
export async function schedulerStatus() {
  const rt = runtime();
  const [scheduledCount, nextDue, dueNowRows] = await Promise.all([
    db.fireWatchlist.count({ where: { reevaluateIntervalMin: { not: null } } }),
    db.fireWatchlist.aggregate({ where: { reevaluateIntervalMin: { not: null }, nextReevaluateAt: { not: null } }, _min: { nextReevaluateAt: true } }),
    db.fireWatchlist.findMany({
      where: { reevaluateIntervalMin: { not: null } },
      select: { id: true, name: true, reevaluateIntervalMin: true, nextReevaluateAt: true },
    }),
  ]);
  const now = new Date();
  const dueNow = selectDueWatchlists(dueNowRows, now, MAX_RUNS_PER_TICK);
  return {
    kind: 'in-process' as const,
    enabled: rt.enabled,
    disabledByEnv: process.env.WATCH_SCHEDULER_OFF === '1',
    tickEverySec: TICK_MS / 1000,
    maxRunsPerTick: MAX_RUNS_PER_TICK,
    running: rt.running,
    startedAt: rt.startedAt ? rt.startedAt.toISOString() : null,
    lastTickAt: rt.lastTickAt ? rt.lastTickAt.toISOString() : null,
    lastTick: rt.lastTick
      ? { tickAt: rt.lastTick.tickAt, ran: rt.lastTick.ran, dueCount: rt.lastTick.dueCount, runs: rt.lastTick.runs }
      : null,
    ticksFired: rt.ticksFired,
    ticksSkippedBusy: rt.ticksSkippedBusy,
    consecutiveFailedRuns: rt.consecutiveFailedRuns,
    scheduledWatchlists: scheduledCount,
    nextDueAt: nextDue._min.nextReevaluateAt ? nextDue._min.nextReevaluateAt.toISOString() : null,
    dueNow: dueNow.map((w) => ({ id: w.id, name: w.name })),
    note: 'Scheduled re-evaluation runs inside the single Next.js runtime (no broker/worker tier). Cadences are opt-in per watchlist; every run is recorded in the audit ledger.',
  };
}
