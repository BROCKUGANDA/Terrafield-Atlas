import { expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createPostgresTestDatabase, deployMigrations } from './postgres-test-database';

if (process.env.PRIVATE_WATCHLIST_WORKER !== '1') {
  test('private watchlist evaluation and scheduling (isolated process)', () => {
    const result = spawnSync(process.execPath, ['test', 'tests/private-watchlist.test.ts'], {
      env: { ...process.env, PRIVATE_WATCHLIST_WORKER: '1' }, encoding: 'utf8', timeout: 60_000,
    });
    if (result.status !== 0) console.error(result.stdout, result.stderr);
    expect(result.status).toBe(0);
  }, 65_000);
} else {
  const database = await createPostgresTestDatabase('private_watchlist');
  process.env.DATABASE_URL = database.url;
  process.env.DIGEST_PUSH_OFF = '0';
  process.env.DIGEST_WEBHOOK_OFF = '0';
  process.env.DIGEST_WEBHOOK_URL = 'https://receiver.example.test/digest';
  process.env.DIGEST_EMAIL_OFF = '0';
  process.env.DIGEST_SMTP_HOST = 'smtp.example.test';
  process.env.DIGEST_SMTP_FROM = 'sender@example.test';
  process.env.DIGEST_SMTP_TO = 'other-account@example.test';
  process.env.DIGEST_EMAIL_TO = 'other-account@example.test';
  const setup = deployMigrations(database.url);
  if (setup.status !== 0) throw new Error(`${setup.stdout}\n${setup.stderr}`);
  const { db } = await import('@/lib/db');
  const provider = await import('@/lib/adapters/gibsFires');
  const email = await import('@/lib/fires/digest-exit-email');
  const webhook = await import('@/lib/fires/digest-exit-webhook');
  const { runWatchlistEvaluation } = await import('@/lib/fires/watchlist-evaluate');
  const { computeWatchlistDigest } = await import('@/lib/fires/watchlist-digest-service');
  const { digestChannel, publishDigestForWatchlist } = await import('@/lib/fires/digest-channel');
  const scheduler = await import('@/lib/scheduler');

  test('private runs persist owner facts, schedule successfully and never fan out to shared exits', async () => {
    const fetch = spyOn(provider, 'fetchFiresForDate').mockImplementation(async (date) => ({
      date, detections: [], tiles: 1, tilesWithData: 0, dataAvailable: false,
    }));
    const sendEmail = spyOn(email, 'deliverDigestEmail').mockImplementation(async () => { throw new Error('private email must not be attempted'); });
    const sendWebhook = spyOn(webhook, 'deliverDigestWebhook').mockImplementation(async () => { throw new Error('private webhook must not be attempted'); });
    const frames: string[] = [];
    const hub = digestChannel();
    hub.register({ clientId: 'anonymous', send: (frame) => frames.push(frame) });
    try {
      const a = await db.accountUser.create({ data: { email: 'owner@example.test' } });
      const b = await db.accountUser.create({ data: { email: 'other-account@example.test' } });
      hub.register({ clientId: 'other-account', ownerId: b.id, authorizePrivate: async () => true, send: (frame) => frames.push(frame) });
      const ownerFrames: string[] = [];
      hub.register({ clientId: 'owner', ownerId: a.id, authorizePrivate: async () => true, send: (frame) => ownerFrames.push(frame) });
      const watch = await db.fireWatchlist.create({ data: { name: 'private geometry', ownerId: a.id, lat: 1, lon: 2, lookbackDays: 3, reevaluateIntervalMin: 360 } });
      const args = { watchlistId: watch.id, trigger: 'manual' as const, actor: `account:${a.id}`, correlationId: 'private-manual' };
      for (const ownerId of [undefined, null, b.id]) {
        const denied = await runWatchlistEvaluation({ ...args, ownerId });
        expect(denied.ok).toBe(false);
      }
      expect(fetch).not.toHaveBeenCalled();
      expect(await db.processingJob.count()).toBe(0);
      const manual = await runWatchlistEvaluation({ ...args, ownerId: a.id });
      expect(manual.ok).toBe(true);
      if (manual.ok) expect(manual.result.evaluation.daysNoData).toHaveLength(3);
      const backtest = await runWatchlistEvaluation({ ...args, trigger: 'backtest', end: '2026-01-10', ownerId: a.id });
      expect(backtest.ok).toBe(true);
      expect(await db.fireCoverageDay.count()).toBe(0);
      expect(await db.fireObservation.count()).toBe(0);
      expect((await computeWatchlistDigest(watch.id, { ownerId: a.id })).ok).toBe(true);
      for (const ownerId of [undefined, null, b.id]) expect((await computeWatchlistDigest(watch.id, { ownerId })).ok).toBe(false);

      process.env.WATCH_SCHEDULER_OFF = '0';
      scheduler.startScheduler();
      scheduler.ensureSchedulerAlive();
      for (let i = 0; i < 200; i++) {
        if (await db.auditEvent.count({ where: { action: 'watchlist.schedule.run', targetId: watch.id } })) break;
        await sleep(10);
      }
      expect(await db.auditEvent.count({ where: { action: 'watchlist.schedule.run', targetId: watch.id } })).toBe(1);
      expect((await db.fireWatchlist.findUniqueOrThrow({ where: { id: watch.id } })).nextReevaluateAt!.getTime()).toBeGreaterThan(Date.now());
      expect(await db.fireWatchEvent.count({ where: { watchlistId: watch.id } })).toBe(3);
      fetch.mockImplementation(async () => { throw new Error('test provider outage'); });
      await db.fireWatchlist.update({ where: { id: watch.id }, data: { nextReevaluateAt: null } });
      const host = globalThis as unknown as { __terraSchedulerRuntime: { lastTickAt: Date | null; running: boolean } };
      for (let i = 0; i < 200 && host.__terraSchedulerRuntime.running; i++) await sleep(10);
      host.__terraSchedulerRuntime.lastTickAt = null;
      scheduler.ensureSchedulerAlive();
      for (let i = 0; i < 200; i++) {
        if (await db.auditEvent.count({ where: { action: 'watchlist.schedule.fail', targetId: watch.id } })) break;
        await sleep(10);
      }
      expect(await db.auditEvent.count({ where: { action: 'watchlist.schedule.fail', targetId: watch.id } })).toBe(1);
      expect(await db.fireWatchEvent.count({ where: { watchlistId: watch.id } })).toBe(3);
      expect(await db.processingJob.count({ where: { status: 'failed' } })).toBe(1);
      expect((await db.fireWatchlist.findUniqueOrThrow({ where: { id: watch.id } })).nextReevaluateAt!.getTime()).toBeGreaterThan(Date.now());
      for (const reason of ['evaluation', 'scheduled-failure'] as const) {
        const outcome = await publishDigestForWatchlist(watch.id, reason, { correlationId: 'private-delivery', triggeredAt: new Date() });
        expect(outcome.skipped).toBe(false);
        expect(outcome.published).toBe(1);
      }
      expect(ownerFrames.length).toBeGreaterThanOrEqual(2);
      expect(frames).toEqual([]);
      expect(sendEmail).not.toHaveBeenCalled();
      expect(sendWebhook).not.toHaveBeenCalled();
    } finally {
      const host = globalThis as unknown as { __terraSchedulerRuntime?: { timer: ReturnType<typeof setInterval> | null; enabled: boolean } };
      if (host.__terraSchedulerRuntime?.timer) clearInterval(host.__terraSchedulerRuntime.timer);
      if (host.__terraSchedulerRuntime) host.__terraSchedulerRuntime.enabled = false;
      hub.unregister('anonymous');
      hub.unregister('other-account');
      hub.unregister('owner');
      fetch.mockRestore();
      sendEmail.mockRestore();
      sendWebhook.mockRestore();
      await db.$disconnect();
      await database.drop();
    }
  }, 20_000);
}