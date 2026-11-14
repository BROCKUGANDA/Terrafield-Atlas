import { REEVALUATE_LABELS, type ReevaluateIntervalMin } from '@/lib/schedule-core';
import type { ParsedSchedulerRun } from '@/lib/fires/watchlist-runs';

/**
 * Cadence-aware alert digests — pure engine + line composer (no I/O).
 *
 * A digest summarizes ONE watchlist's alert activity over a time window that
 * DERIVES from the watchlist's own re-evaluation cadence when one is set:
 * a 6 h / 12 h / 24 h list gets a 6 h / 12 h / 24 h digest. Manual lists
 * default to 24 h. A request may override the window (1–720 h) — the response
 * always says which source produced the window.
 *
 * The digest compares the current window against the EQUAL-LENGTH window
 * immediately before it: status trajectory, peak qualifying detections, alert
 * entries/exits, failed scheduled runs (from the audit ledger — failed runs
 * write no evaluation event) and archive-gap days. Boundary rule: windows are
 * start-inclusive; the previous window is summarized END-EXCLUSIVE (its end
 * equals the current window's start), so no evaluation is ever counted twice.
 *
 * Like everything in this console the digest reports only what is recorded —
 * it never interpolates, extrapolates or zero-fills. Delivery is BOTH
 * on-demand (GET …/digest) and push-style: the digest-stream channel
 * (lib/fires/digest-push.ts + digest-channel.ts) recomputes this exact
 * digest and writes it onto every open console the moment an evaluation
 * event lands or a scheduled run fails.
 */

export const DEFAULT_DIGEST_HOURS = 24;

/** Digest window for a watchlist: its cadence in hours, else the default. */
export function digestHoursFor(w: { reevaluateIntervalMin: number | null }): number {
  return w.reevaluateIntervalMin !== null ? w.reevaluateIntervalMin / 60 : DEFAULT_DIGEST_HOURS;
}

export interface DigestWindow {
  start: string; // ISO
  end: string; // ISO
}

export function digestWindows(now: Date, hours: number): { current: DigestWindow; previous: DigestWindow } {
  const endMs = now.getTime();
  const startMs = endMs - hours * 3_600_000;
  const prevStartMs = startMs - hours * 3_600_000;
  return {
    current: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() },
    previous: { start: new Date(prevStartMs).toISOString(), end: new Date(startMs).toISOString() },
  };
}

/** Minimal event shape needed for summarizing (serializeEvent output satisfies it). */
export interface DigestEventLike {
  evaluatedAt: string; // ISO
  status: string; // unverified | clear | watch | alert
  detectionCount: number;
  daysNoDataList: string[];
  daysChecked: number;
  trigger: 'manual' | 'backtest' | 'scheduled';
}

export interface DigestSummary {
  evaluations: number;
  byTrigger: { manual: number; backtest: number; scheduled: number };
  /** Chronological status sequence, oldest → newest (one entry per evaluation). */
  statusPath: string[];
  /** Status changes only (consecutive duplicates collapsed). */
  transitions: { from: string; to: string; at: string }[];
  alertingEvaluations: number;
  clearEvaluations: number;
  /** Highest qualifying-detection count in the window and when it was seen. */
  peak: { detectionCount: number; at: string } | null;
  last: { status: string; detectionCount: number; at: string } | null;
  /** Union of archive-gap days across the window's evaluations (sorted). */
  noDataDays: string[];
  daysCheckedTotal: number;
}

/**
 * Summarize the evaluations that fall in `window`. Windows are start-inclusive;
 * pass `{ endExclusive: true }` for the previous window so an evaluation exactly
 * at the shared boundary is counted in the CURRENT window only. The route
 * fetches both windows' events in one query; this function filters/sorts them —
 * pure and deterministic.
 */
export function summarizeWindow(
  events: DigestEventLike[],
  window: DigestWindow,
  opts?: { endExclusive?: boolean },
): DigestSummary {
  const startT = Date.parse(window.start);
  const endT = Date.parse(window.end);
  const endOk = (t: number) => (opts?.endExclusive ? t < endT : t <= endT);
  const inWindow = events
    .map((e) => ({ e, t: Date.parse(e.evaluatedAt) }))
    .filter(({ t }) => Number.isFinite(t) && t >= startT && endOk(t))
    .sort((a, b) => a.t - b.t)
    .map(({ e }) => e);

  const statusPath = inWindow.map((e) => e.status);
  const transitions: DigestSummary['transitions'] = [];
  for (let i = 1; i < statusPath.length; i++) {
    if (statusPath[i] !== statusPath[i - 1]) {
      transitions.push({ from: statusPath[i - 1], to: statusPath[i], at: inWindow[i].evaluatedAt });
    }
  }
  const peak = inWindow.reduce<DigestSummary['peak']>((acc, e) => {
    if (acc === null || e.detectionCount > acc.detectionCount) {
      return { detectionCount: e.detectionCount, at: e.evaluatedAt };
    }
    return acc;
  }, null);
  const lastEvent = inWindow.length > 0 ? inWindow[inWindow.length - 1] : null;
  const noData = new Set<string>();
  for (const e of inWindow) for (const d of e.daysNoDataList) noData.add(d);

  return {
    evaluations: inWindow.length,
    byTrigger: {
      manual: inWindow.filter((e) => e.trigger === 'manual').length,
      backtest: inWindow.filter((e) => e.trigger === 'backtest').length,
      scheduled: inWindow.filter((e) => e.trigger === 'scheduled').length,
    },
    statusPath,
    transitions,
    alertingEvaluations: inWindow.filter((e) => e.status === 'alert').length,
    clearEvaluations: inWindow.filter((e) => e.status === 'clear').length,
    peak,
    last: lastEvent
      ? { status: lastEvent.status, detectionCount: lastEvent.detectionCount, at: lastEvent.evaluatedAt }
      : null,
    noDataDays: [...noData].sort(),
    daysCheckedTotal: inWindow.reduce((s, e) => s + e.daysChecked, 0),
  };
}

export interface DigestComparison {
  evaluationsDelta: number;
  /** current peak − previous peak; null when either window has no evaluations. */
  peakDelta: number | null;
  /** Last recorded status differs between the two windows. */
  statusChanged: boolean;
  /** Previous window had no alerting evaluation, current window does. */
  alertEntered: boolean;
  /** Previous window had alerting evaluations, current window has none. */
  alertCleared: boolean;
  previousLast: DigestSummary['last'];
}

export function compareWindows(current: DigestSummary, previous: DigestSummary): DigestComparison {
  const peakDelta =
    current.peak !== null && previous.peak !== null
      ? current.peak.detectionCount - previous.peak.detectionCount
      : null;
  return {
    evaluationsDelta: current.evaluations - previous.evaluations,
    peakDelta,
    statusChanged: (current.last?.status ?? null) !== (previous.last?.status ?? null),
    alertEntered: previous.alertingEvaluations === 0 && current.alertingEvaluations > 0,
    alertCleared: previous.alertingEvaluations > 0 && current.alertingEvaluations === 0,
    previousLast: previous.last,
  };
}

export interface DigestFailure {
  at: string; // ISO
  error: string;
  correlationId: string | null;
}

/** Narrow parsed scheduler audit rows to failed runs (used by the route). */
export function failuresFromParsed(rows: (ParsedSchedulerRun | null)[]): DigestFailure[] {
  return rows
    .filter((r): r is ParsedSchedulerRun & { kind: 'fail' } => r !== null && r.kind === 'fail')
    .map((r) => ({ at: r.at, error: r.error ?? 'unknown error', correlationId: r.correlationId }));
}

export type DigestWindowSource = 'cadence' | 'request' | 'default';

export interface DigestInput {
  name: string;
  now: Date;
  hours: number;
  cadenceMin: number | null;
  windowSource: DigestWindowSource;
  /** Events since previous.start (both windows), serialized. */
  events: DigestEventLike[];
  failures: DigestFailure[];
  nextRunAt: Date | null;
  truncated: boolean;
}

export interface Digest {
  hours: number;
  cadenceMin: number | null;
  windowSource: DigestWindowSource;
  window: { current: DigestWindow; previous: DigestWindow };
  current: DigestSummary;
  previous: DigestSummary;
  comparison: DigestComparison;
  failures: DigestFailure[];
  /** Human-readable digest lines, in reading order. */
  digest: string[];
  truncated: boolean;
}

/** UTC minute stamp used in digest prose, e.g. "2026-11-14 08:05Z". */
function fmt(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'unknown-time';
  return new Date(t).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

/**
 * Assemble the full digest for one watchlist — pure: windows, both window
 * summaries, comparison, and the plain-language lines. The route passes
 * already-fetched events + failures; this function does NO I/O.
 */
export function buildDigest(input: DigestInput): Digest {
  const { name, now, hours, cadenceMin, windowSource, events, failures, nextRunAt, truncated } = input;
  const window = digestWindows(now, hours);
  const current = summarizeWindow(events, window.current);
  // End-exclusive: the previous window's end IS the current window's start.
  const previous = summarizeWindow(events, window.previous, { endExclusive: true });
  const comparison = compareWindows(current, previous);
  const cadenceHours = cadenceMin !== null ? cadenceMin / 60 : null;
  const cadenceLabel = cadenceMin !== null ? (REEVALUATE_LABELS[cadenceMin as ReevaluateIntervalMin] ?? `every ${cadenceHours} h`) : null;

  const lines: string[] = [];

  // Window provenance.
  const sourcePhrase =
    windowSource === 'cadence'
      ? `derived from the re-evaluation cadence (${cadenceLabel})`
      : windowSource === 'request'
        ? 'as requested'
        : `default (${DEFAULT_DIGEST_HOURS} h — no re-evaluation cadence is set on “${name}”)`;
  lines.push(
    `Digest window: last ${hours} h ending ${fmt(window.current.end)} — ${sourcePhrase}.`,
  );

  // Evaluation coverage in the window.
  if (current.evaluations === 0) {
    if (failures.length > 0) {
      lines.push(
        `No evaluations completed in this window — ${failures.length} scheduled run(s) failed (see below); the scheduler retries at the next claimed slot.`,
      );
    } else if (cadenceMin !== null) {
      lines.push(
        `No evaluations ran in this window. The scheduler has not fired inside it${nextRunAt ? ` — next run claimed for ${fmt(nextRunAt.toISOString())}` : ''}.`,
      );
    } else {
      lines.push('No evaluations ran in this window — this watchlist is evaluated on demand only (no cadence set).');
    }
  } else {
    lines.push(
      `${current.evaluations} evaluation(s) in window — ${current.byTrigger.scheduled} scheduled, ${current.byTrigger.manual} manual, ${current.byTrigger.backtest} backtest.`,
    );
  }

  // Status trajectory + alert transitions.
  if (current.evaluations > 0 && current.last !== null) {
    const path = current.transitions.length > 0
      ? current.statusPath.join(' → ')
      : `held ${current.last.status}`;
    lines.push(`Status path: ${path}. Last: ${current.last.status.toUpperCase()} at ${fmt(current.last.at)} with ${current.last.detectionCount} qualifying detection(s).`);
    if (comparison.alertEntered) {
      lines.push(`ALERT entered this window (the previous ${hours} h had no alerting evaluation).`);
    } else if (comparison.alertCleared) {
      lines.push(`No ALERT evaluation in this window — the previous ${hours} h had ${previous.alertingEvaluations}.`);
    } else if (current.alertingEvaluations > 0 && previous.alertingEvaluations > 0) {
      lines.push(`ALERTING in both windows — ${current.alertingEvaluations} alert evaluation(s) this window, ${previous.alertingEvaluations} in the previous.`);
    }
  }

  // Peak comparison.
  if (current.peak !== null) {
    const deltaPhrase =
      comparison.peakDelta !== null && comparison.peakDelta !== 0
        ? ` (${signed(comparison.peakDelta)} vs the previous ${hours} h, which peaked at ${previous.peak?.detectionCount ?? 0})`
        : comparison.peakDelta === 0
          ? ` (unchanged vs the previous ${hours} h)`
          : '';
    lines.push(`Peak qualifying detections: ${current.peak.detectionCount} at ${fmt(current.peak.at)}${deltaPhrase}.`);
  } else if (previous.peak !== null) {
    lines.push(`No evaluations in this window; the previous ${hours} h peaked at ${previous.peak.detectionCount} qualifying detection(s).`);
  }

  // Failed scheduled runs.
  if (failures.length > 0) {
    const parts = failures.map((f) => `${fmt(f.at)} — ${f.error}`);
    lines.push(`Failed scheduled run(s) in window: ${parts.join('; ')}. Failures wrote no status — nothing is fabricated.`);
  }

  // Archive gaps reported by the window's evaluations.
  if (current.noDataDays.length > 0) {
    lines.push(`Archive-gap days reported: ${current.noDataDays.join(', ')} (${current.noDataDays.length} day(s) the GIBS archive does not carry — no-data, never zero-filled).`);
  }

  // Cadence state / next run.
  if (cadenceMin !== null) {
    if (current.evaluations > 0 && current.byTrigger.scheduled === 0 && failures.length === 0) {
      lines.push(`No scheduled run inside this window (only manual/backtest activity) — the window is shorter than the ${cadenceLabel} cadence or the run is still claimed for ${nextRunAt ? fmt(nextRunAt.toISOString()) : 'a pending slot'}.`);
    } else if (nextRunAt) {
      lines.push(`Next scheduled run: ${fmt(nextRunAt.toISOString())} (${cadenceLabel}).`);
    }
  } else {
    lines.push(`No cadence set — evaluated on demand only. Set “Auto re-evaluate” in Edit for cadence-aligned digests.`);
  }

  if (truncated) {
    lines.push(`Note: more than 200 evaluations exist since ${fmt(window.previous.start)}; this digest covers the latest 200.`);
  }

  return {
    hours,
    cadenceMin,
    windowSource,
    window,
    current,
    previous,
    comparison,
    failures,
    digest: lines,
    truncated,
  };
}
