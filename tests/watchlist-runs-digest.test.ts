import { describe, test, expect } from 'bun:test';
import {
  parseSchedulerAuditRow,
  buildRunHistory,
  type SchedulerAuditRow,
} from '@/lib/fires/watchlist-runs';
import {
  DEFAULT_DIGEST_HOURS,
  digestHoursFor,
  digestWindows,
  summarizeWindow,
  compareWindows,
  failuresFromParsed,
  buildDigest,
  type DigestEventLike,
} from '@/lib/fires/watchlist-digest';
import type { ParsedSchedulerRun } from '@/lib/fires/watchlist-runs';

/**
 * Scheduler-run history + cadence-aware digest — pure-logic unit tests.
 * No DB, no network: the same functions the routes compose with Prisma reads.
 */

const RUN_DETAIL = {
  status: 'alert',
  detectionCount: 14,
  nextReevaluateAt: '2026-11-14T14:05:00.000Z',
  correlationId: 'sched-m1a2b3c-12345678',
};

function auditRow(action: string, at: string, detail: unknown | string | null): SchedulerAuditRow {
  return {
    action,
    createdAt: new Date(at),
    detail: detail === null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail),
  };
}

function ev(
  at: string,
  status: string,
  detectionCount: number,
  trigger: DigestEventLike['trigger'] = 'scheduled',
  noData: string[] = [],
  daysChecked = 7,
): DigestEventLike {
  // Normalize like the wire does (serializeEvent → toISOString).
  return { evaluatedAt: new Date(at).toISOString(), status, detectionCount, daysNoDataList: noData, daysChecked, trigger };
}

describe('scheduler audit-ledger parsing', () => {
  test('run rows parse status, count, claim and correlationId', () => {
    const p = parseSchedulerAuditRow(auditRow('watchlist.schedule.run', '2026-11-14T08:05:00Z', RUN_DETAIL));
    expect(p).not.toBeNull();
    expect(p!.kind).toBe('run');
    expect(p!.status).toBe('alert');
    expect(p!.detectionCount).toBe(14);
    expect(p!.claimedNextAt).toBe('2026-11-14T14:05:00.000Z');
    expect(p!.correlationId).toBe('sched-m1a2b3c-12345678');
    expect(p!.error).toBeNull();
    expect(p!.at).toBe('2026-11-14T08:05:00.000Z');
  });

  test('fail rows parse the error and never a status', () => {
    const p = parseSchedulerAuditRow(
      auditRow('watchlist.schedule.fail', '2026-11-14T09:05:00Z', {
        error: 'GIBS tile fetch failed after retries',
        nextReevaluateAt: '2026-11-14T15:05:00.000Z',
        correlationId: 'sched-m1a2b3d-12345678',
      }),
    );
    expect(p!.kind).toBe('fail');
    expect(p!.error).toBe('GIBS tile fetch failed after retries');
    expect(p!.status).toBeNull();
    expect(p!.detectionCount).toBeNull();
  });

  test('corrupt detail JSON degrades instead of throwing', () => {
    const runP = parseSchedulerAuditRow(auditRow('watchlist.schedule.run', '2026-11-14T08:05:00Z', '{not json'));
    expect(runP!.kind).toBe('run');
    expect(runP!.correlationId).toBeNull();
    expect(runP!.status).toBeNull();
    expect(runP!.detectionCount).toBeNull();
    const failP = parseSchedulerAuditRow(auditRow('watchlist.schedule.fail', '2026-11-14T08:05:00Z', null));
    expect(failP!.kind).toBe('fail');
    expect(failP!.error).toContain('unknown error');
  });

  test('non-scheduler actions are ignored', () => {
    expect(parseSchedulerAuditRow(auditRow('watchlist.evaluate', '2026-11-14T08:05:00Z', RUN_DETAIL))).toBeNull();
    expect(parseSchedulerAuditRow(auditRow('watchlist.create', '2026-11-14T08:05:00Z', {}))).toBeNull();
  });
});

describe('run-history merge', () => {
  const t = (h: number) => `2026-11-14T${String(h).padStart(2, '0')}:05:00.000Z`;

  test('newest first, capped, failures keep evaluation null', () => {
    const rows: SchedulerAuditRow[] = [
      auditRow('watchlist.schedule.run', t(8), { ...RUN_DETAIL, correlationId: 'c-run-1' }),
      auditRow('watchlist.schedule.fail', t(9), { error: 'boom', correlationId: 'c-fail-1' }),
      auditRow('watchlist.schedule.run', t(2), { ...RUN_DETAIL, correlationId: 'c-run-2', detectionCount: 3, status: 'clear' }),
    ];
    const events = [
      { id: 'e1', correlationId: 'c-run-1', status: 'alert' },
      { id: 'e2', correlationId: 'c-run-2', status: 'clear' },
    ];
    const merged = buildRunHistory(rows, events, 50);
    expect(merged.map((m) => m.at)).toEqual([t(9), t(8), t(2)]);
    expect(merged[0].kind).toBe('fail');
    expect(merged[0].evaluation).toBeNull();
    expect(merged[1].evaluation).not.toBeNull();
    expect((merged[1].evaluation as { id: string }).id).toBe('e1');
    expect(merged[2].status).toBe('clear');
  });

  test('cap keeps only the newest entries', () => {
    const rows = [1, 2, 3, 4, 5].map((h) =>
      auditRow('watchlist.schedule.run', t(h), { ...RUN_DETAIL, correlationId: `c-${h}` }),
    );
    const merged = buildRunHistory(rows, [], 3);
    expect(merged).toHaveLength(3);
    expect(merged[0].at).toBe(t(5));
    expect(merged[2].at).toBe(t(3));
  });

  test('run rows without a matching event degrade to evaluation: null', () => {
    const merged = buildRunHistory([auditRow('watchlist.schedule.run', t(8), RUN_DETAIL)], [], 50);
    expect(merged[0].evaluation).toBeNull();
    expect(merged[0].status).toBe('alert');
  });
});

describe('digest windows', () => {
  test('hours derive from the cadence, default otherwise', () => {
    expect(digestHoursFor({ reevaluateIntervalMin: 360 })).toBe(6);
    expect(digestHoursFor({ reevaluateIntervalMin: 720 })).toBe(12);
    expect(digestHoursFor({ reevaluateIntervalMin: 1440 })).toBe(24);
    expect(digestHoursFor({ reevaluateIntervalMin: null })).toBe(DEFAULT_DIGEST_HOURS);
  });

  test('current and previous windows are equal-length and contiguous', () => {
    const now = new Date('2026-11-14T12:00:00Z');
    const { current, previous } = digestWindows(now, 6);
    expect(current.start).toBe('2026-11-14T06:00:00.000Z');
    expect(current.end).toBe('2026-11-14T12:00:00.000Z');
    expect(previous.start).toBe('2026-11-14T00:00:00.000Z');
    expect(previous.end).toBe('2026-11-14T06:00:00.000Z');
  });
});

describe('window summarization', () => {
  const win = { start: '2026-11-14T06:00:00.000Z', end: '2026-11-14T12:00:00.000Z' };
  test('boundary rule: current window is start-inclusive, previous is end-exclusive', () => {
    const events = [
      ev('2026-11-14T06:00:00.000Z', 'watch', 5), // exactly current.start → CURRENT only
      ev('2026-11-14T12:00:00.000Z', 'alert', 9), // exactly current.end → CURRENT
      ev('2026-11-14T05:59:59.999Z', 'clear', 1), // just before → PREVIOUS
    ];
    const cur = summarizeWindow(events, win);
    expect(cur.evaluations).toBe(2);
    const prev = summarizeWindow(
      events,
      { start: '2026-11-14T00:00:00.000Z', end: win.start },
      { endExclusive: true },
    );
    expect(prev.evaluations).toBe(1);
    expect(prev.last!.status).toBe('clear');
  });

  test('no double counting in buildDigest for an event exactly at the boundary', () => {
    const digest = buildDigest({
      name: 'Boundary watch',
      now: new Date('2026-11-14T12:00:00Z'),
      hours: 6,
      cadenceMin: null,
      windowSource: 'default',
      events: [ev('2026-11-14T06:00:00Z', 'alert', 7)], // exactly current.start
      failures: [],
      nextRunAt: null,
      truncated: false,
    });
    expect(digest.current.evaluations).toBe(1);
    expect(digest.previous.evaluations).toBe(0);
    expect(digest.current.peak!.detectionCount).toBe(7);
    expect(digest.previous.peak).toBeNull();
  });

  test('status path, transitions, peak, last, no-data union and trigger counts', () => {
    const events = [
      ev('2026-11-14T11:00:00Z', 'alert', 9, 'scheduled', ['2026-11-12']),
      ev('2026-11-14T06:10:00Z', 'watch', 5, 'manual'),
      ev('2026-11-14T08:05:00Z', 'alert', 14, 'scheduled', ['2026-11-12', '2026-11-13'], 5),
    ];
    const s = summarizeWindow(events, win);
    expect(s.evaluations).toBe(3);
    expect(s.statusPath).toEqual(['watch', 'alert', 'alert']); // chronological
    expect(s.transitions).toEqual([{ from: 'watch', to: 'alert', at: '2026-11-14T08:05:00.000Z' }]);
    expect(s.peak).toEqual({ detectionCount: 14, at: '2026-11-14T08:05:00.000Z' });
    expect(s.last).toEqual({ status: 'alert', detectionCount: 9, at: '2026-11-14T11:00:00.000Z' });
    expect(s.noDataDays).toEqual(['2026-11-12', '2026-11-13']);
    expect(s.byTrigger).toEqual({ manual: 1, backtest: 0, scheduled: 2 });
    expect(s.daysCheckedTotal).toBe(19);
  });

  test('peak keeps the first maximum on ties; empty window nulls out', () => {
    const events = [ev('2026-11-14T07:00:00Z', 'watch', 5), ev('2026-11-14T09:00:00Z', 'watch', 5)];
    const s = summarizeWindow(events, win);
    expect(s.peak!.at).toBe('2026-11-14T07:00:00.000Z');
    const empty = summarizeWindow([], win);
    expect(empty.evaluations).toBe(0);
    expect(empty.peak).toBeNull();
    expect(empty.last).toBeNull();
    expect(empty.noDataDays).toEqual([]);
  });
});

describe('window comparison', () => {
  const win = { start: '2026-11-14T06:00:00.000Z', end: '2026-11-14T12:00:00.000Z' };
  test('alert entered / cleared / held, peak delta, status change', () => {
    const entered = compareWindows(
      { ...summarizeWindow([ev('2026-11-14T07:00:00Z', 'alert', 10)], { start: win.start, end: win.end }) },
      { ...summarizeWindow([ev('2026-11-14T03:00:00Z', 'clear', 2)], { start: '2026-11-14T00:00:00.000Z', end: win.start }) },
    );
    expect(entered.alertEntered).toBe(true);
    expect(entered.alertCleared).toBe(false);
    expect(entered.statusChanged).toBe(true);
    expect(entered.peakDelta).toBe(8);

    const cleared = compareWindows(
      summarizeWindow([ev('2026-11-14T07:00:00Z', 'clear', 1)], win),
      summarizeWindow([ev('2026-11-14T03:00:00Z', 'alert', 12)], { start: '2026-11-14T00:00:00.000Z', end: win.start }),
    );
    expect(cleared.alertCleared).toBe(true);
    expect(cleared.alertEntered).toBe(false);
    expect(cleared.peakDelta).toBe(-11);

    const held = compareWindows(
      summarizeWindow([ev('2026-11-14T07:00:00Z', 'alert', 6)], win),
      summarizeWindow([ev('2026-11-14T03:00:00Z', 'alert', 6)], { start: '2026-11-14T00:00:00.000Z', end: win.start }),
    );
    expect(held.alertEntered).toBe(false);
    expect(held.alertCleared).toBe(false);
    expect(held.statusChanged).toBe(false);
    expect(held.peakDelta).toBe(0);
  });
});

describe('failure narrowing', () => {
  test('keeps only fail entries with their errors', () => {
    const parsed: (ParsedSchedulerRun | null)[] = [
      parseSchedulerAuditRow(auditRow('watchlist.schedule.run', '2026-11-14T08:05:00Z', RUN_DETAIL)),
      parseSchedulerAuditRow(auditRow('watchlist.schedule.fail', '2026-11-14T09:05:00Z', { error: 'tile fetch failed', correlationId: 'x' })),
      null,
    ];
    const failures = failuresFromParsed(parsed);
    expect(failures).toHaveLength(1);
    expect(failures[0].error).toBe('tile fetch failed');
    expect(failures[0].correlationId).toBe('x');
  });
});

describe('digest composition', () => {
  const NOW = new Date('2026-11-14T12:00:00Z');

  test('full cadence scenario: alert entry, peak delta, failure, archive gaps, next run', () => {
    const digest = buildDigest({
      name: 'Nakuru — dry-season fire watch',
      now: NOW,
      hours: 6,
      cadenceMin: 360,
      windowSource: 'cadence',
      events: [
        ev('2026-11-14T03:00:00Z', 'clear', 2),
        ev('2026-11-14T05:30:00Z', 'clear', 3),
        ev('2026-11-14T06:10:00Z', 'watch', 5, 'manual'),
        ev('2026-11-14T08:05:00Z', 'alert', 14, 'scheduled', ['2026-11-13']),
        ev('2026-11-14T11:00:00Z', 'alert', 9),
      ],
      failures: [{ at: '2026-11-14T07:00:00Z', error: 'GIBS tile fetch failed', correlationId: 'sched-x' }],
      nextRunAt: new Date('2026-11-14T14:05:00Z'),
      truncated: false,
    });

    expect(digest.current.evaluations).toBe(3);
    expect(digest.previous.evaluations).toBe(2);
    expect(digest.comparison.alertEntered).toBe(true);
    expect(digest.comparison.peakDelta).toBe(11);

    const text = digest.digest.join('\n');
    expect(digest.digest[0]).toContain('last 6 h');
    expect(digest.digest[0]).toContain('every 6 h');
    expect(text).toContain('3 evaluation(s) in window — 2 scheduled, 1 manual, 0 backtest');
    expect(text).toContain('watch → alert → alert');
    expect(text).toContain('ALERT entered this window');
    expect(text).toContain('Peak qualifying detections: 14');
    expect(text).toContain('+11 vs the previous 6 h');
    expect(text).toContain('GIBS tile fetch failed');
    expect(text).toContain('nothing is fabricated');
    expect(text).toContain('Archive-gap days reported: 2026-11-13');
    expect(text).toContain('Next scheduled run: 2026-11-14 14:05Z');
    // Honesty guard: no leaked placeholders.
    for (const line of digest.digest) {
      expect(line).not.toContain('undefined');
      expect(line).not.toContain('NaN');
      expect(line).not.toContain('null');
    }
  });

  test('empty window with failures explains the gap without inventing a status', () => {
    const digest = buildDigest({
      name: 'Sud fire watch',
      now: NOW,
      hours: 6,
      cadenceMin: 360,
      windowSource: 'cadence',
      events: [],
      failures: [{ at: '2026-11-14T07:00:00Z', error: 'provider unreachable', correlationId: null }],
      nextRunAt: new Date('2026-11-14T13:00:00Z'),
      truncated: false,
    });
    const text = digest.digest.join('\n');
    expect(text).toContain('No evaluations completed in this window — 1 scheduled run(s) failed');
    expect(text).toContain('provider unreachable');
    expect(text).toContain('Next scheduled run: 2026-11-14 13:00Z');
  });

  test('manual lists default the window and say so', () => {
    const digest = buildDigest({
      name: 'Ad-hoc watch',
      now: NOW,
      hours: DEFAULT_DIGEST_HOURS,
      cadenceMin: null,
      windowSource: 'default',
      events: [ev('2026-11-14T08:00:00Z', 'clear', 0, 'manual')],
      failures: [],
      nextRunAt: null,
      truncated: false,
    });
    const text = digest.digest.join('\n');
    expect(text).toContain(`default (${DEFAULT_DIGEST_HOURS} h — no re-evaluation cadence is set on “Ad-hoc watch”)`);
    expect(text).toContain('Status path: held clear');
    expect(text).toContain('No cadence set — evaluated on demand only');
    expect(text).toContain('Auto re-evaluate');
  });

  test('short override window with only manual activity flags the cadence mismatch', () => {
    const digest = buildDigest({
      name: 'Nakuru — dry-season fire watch',
      now: NOW,
      hours: 6,
      cadenceMin: 1440,
      windowSource: 'request',
      events: [ev('2026-11-14T07:00:00Z', 'watch', 4, 'manual')],
      failures: [],
      nextRunAt: new Date('2026-11-15T10:00:00Z'),
      truncated: false,
    });
    const text = digest.digest.join('\n');
    expect(text).toContain('as requested');
    expect(text).toContain('No scheduled run inside this window');
    expect(text).toContain('every 24 h');
  });

  test('no evaluations at all, manual list: honest empty digest', () => {
    const digest = buildDigest({
      name: 'Quiet watch',
      now: NOW,
      hours: 24,
      cadenceMin: null,
      windowSource: 'default',
      events: [],
      failures: [],
      nextRunAt: null,
      truncated: false,
    });
    const text = digest.digest.join('\n');
    expect(text).toContain('No evaluations ran in this window — this watchlist is evaluated on demand only');
    expect(digest.current.peak).toBeNull();
    expect(digest.previous.peak).toBeNull();
    expect(text).not.toContain('Archive-gap');
  });

  test('window math matches the route read span (previous.start bounds the query)', () => {
    const digest = buildDigest({
      name: 'Span check',
      now: NOW,
      hours: 6,
      cadenceMin: null,
      windowSource: 'default',
      events: [ev('2026-11-13T17:59:00Z', 'clear', 0)], // before previous.start → excluded
      failures: [],
      nextRunAt: null,
      truncated: false,
    });
    expect(digest.window.previous.start).toBe('2026-11-14T00:00:00.000Z');
    expect(digest.previous.evaluations).toBe(0);
    expect(digest.current.evaluations).toBe(0);
  });
});
