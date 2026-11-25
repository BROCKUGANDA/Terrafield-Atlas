import { db } from '@/lib/db';

/**
 * Bounded retention for operational ledgers. Runs on the scheduler leader at
 * most once per hour; every delete is time/count bounded so a long outage
 * cannot produce an unbounded statement.
 */
export interface RetentionResult {
  at: string;
  accountVerifications: number;
  passwordResets: number;
  oauthTokens: number;
  rateLimits: number;
  idempotencyRecords: number;
  deliveryReceipts: number;
  usageEvents: number;
  marketIngestions: number;
}

const DAY = 86_400_000;

export async function cleanupRetention(now = new Date()): Promise<RetentionResult> {
  const [accountVerifications, passwordResets, oauthTokens, rateLimits, idempotencyRecords, deliveryReceipts, usageEvents, marketIngestions] = await Promise.all([
    db.accountVerification.deleteMany({ where: { expiresAt: { lt: now } } }),
    db.passwordReset.deleteMany({ where: { expiresAt: { lt: now } } }),
    db.oAuthToken.deleteMany({ where: { expiresAt: { lt: now } } }),
    db.accountRateLimit.deleteMany({ where: { expiresAt: { lt: now } } }),
    db.idempotencyRecord.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 30 * DAY) } } }),
    db.deliveryReceipt.deleteMany({ where: { deliveredAt: { lt: new Date(now.getTime() - 30 * DAY) } } }),
    db.usageEvent.deleteMany({ where: { occurredAt: { lt: new Date(now.getTime() - 730 * DAY) } } }),
    db.marketIngestion.deleteMany({ where: { startedAt: { lt: new Date(now.getTime() - 180 * DAY) } } }),
  ]);
  return {
    at: now.toISOString(),
    accountVerifications: accountVerifications.count,
    passwordResets: passwordResets.count,
    oauthTokens: oauthTokens.count,
    rateLimits: rateLimits.count,
    idempotencyRecords: idempotencyRecords.count,
    deliveryReceipts: deliveryReceipts.count,
    usageEvents: usageEvents.count,
    marketIngestions: marketIngestions.count,
  };
}

/** Scheduler-side guard: one cleanup per hour per process. */
let lastCleanupAt = 0;
export function retentionDue(now = Date.now()): boolean {
  return now - lastCleanupAt >= 60 * 60_000;
}
export function markRetentionRun(now = Date.now()): void {
  lastCleanupAt = now;
}
