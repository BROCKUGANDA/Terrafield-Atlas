import { expect, test } from 'bun:test';
import { publicSchedulerDiagnostics } from '@/lib/public-diagnostics';

test('public scheduler diagnostics use an allowlist, not private run metadata', () => {
  const result = publicSchedulerDiagnostics({
    kind: 'in-process', enabled: true, disabledByEnv: false,
    tickEverySec: 60, maxRunsPerTick: 5, running: false,
    startedAt: null, lastTickAt: null, ticksFired: 1, ticksSkippedBusy: 0,
    consecutiveFailedRuns: 1, scheduledWatchlists: 2, nextDueAt: null,
    dueNow: [{ id: 'secret-id', name: 'secret farm' }],
    lastTick: { tickAt: '2026-11-19', ran: 1, dueCount: 1, runs: [{ error: 'secret location' }] },
    futureDiagnostic: 'private-provider-url',
  });
  expect(result.enabled).toBe(true);
  expect(result.lastTick).toEqual({ tickAt: '2026-11-19', ran: 1, dueCount: 1, runs: [] });
  expect(result.dueNow).toEqual([]);
  expect(JSON.stringify(result)).not.toMatch(/secret|private-provider/);
  expect('futureDiagnostic' in result).toBe(false);
});