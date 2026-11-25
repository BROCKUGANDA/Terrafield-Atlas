import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { AccountAccessError } from '@/lib/access-error';
import { writeMutationEffects } from '@/lib/api/helpers';
import { currentSubscription } from '@/lib/commercial';
import type { TenantContext } from '@/lib/tenancy';

/**
 * Manual invoice settlement. There is deliberately no payment-provider adapter:
 * an authorized manager records a bank/cash settlement and the subscription is
 * extended in the same transaction. The `provider` method stays reserved until
 * a reviewed adapter exists.
 */
export const MANUAL_PAYMENT_METHODS = ['manual_bank', 'manual_cash'] as const;
export type ManualPaymentMethod = (typeof MANUAL_PAYMENT_METHODS)[number];

export const BILLING_PAYMENT_NOTE =
  'Settlement is recorded manually by an authorized manager. No card processor or payment provider is connected; the platform never charges a card.';

const paymentSelect = {
  id: true,
  invoiceId: true,
  organizationId: true,
  amountMinor: true,
  currency: true,
  method: true,
  status: true,
  reference: true,
  recordedByUserId: true,
  createdAt: true,
} satisfies Prisma.PaymentSelect;

const invoiceDetailSelect = {
  id: true,
  organizationId: true,
  ownerId: true,
  subscriptionId: true,
  number: true,
  status: true,
  amountMinor: true,
  currency: true,
  periodStart: true,
  periodEnd: true,
  issuedAt: true,
  dueAt: true,
  paidAt: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  payments: { orderBy: { createdAt: 'desc' }, select: paymentSelect },
} satisfies Prisma.InvoiceSelect;

export type InvoiceRecord = Prisma.InvoiceGetPayload<{ select: typeof invoiceDetailSelect }>;
export type PaymentRecord = Prisma.PaymentGetPayload<{ select: typeof paymentSelect }>;

export interface SettleInvoiceInput {
  /** Minor units; defaults to the invoice total when omitted. Mismatches are rejected. */
  amountMinor?: number;
  method: string;
  reference?: string | null;
}

function addMonthsUtc(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const day = date.getUTCDate();
  const target = new Date(Date.UTC(year, month, 1, date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
}

function invoiceNumber(periodStart: Date): string {
  const month = `${periodStart.getUTCFullYear()}${String(periodStart.getUTCMonth() + 1).padStart(2, '0')}`;
  return `TF-${month}-${randomBytes(3).toString('hex')}`;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function requireAccount(context: TenantContext): string {
  if (!context.userId) throw new AccountAccessError(401, 'AUTH_REQUIRED', 'a verified account is required for billing');
  return context.userId;
}

function inScope(invoice: { organizationId: string | null; ownerId: string | null }, context: TenantContext): boolean {
  if (context.organizationId) return invoice.organizationId === context.organizationId;
  return context.userId !== null && invoice.organizationId === null && invoice.ownerId === context.userId;
}

function scopeWhere(context: TenantContext): Prisma.InvoiceWhereInput {
  return context.organizationId ? { organizationId: context.organizationId } : { ownerId: context.userId, organizationId: null };
}

/** Issue (or return) the single non-void invoice for the subscription's current period. */
export async function ensureInvoiceForPeriod(context: TenantContext): Promise<{ invoice: InvoiceRecord; created: boolean }> {
  const userId = requireAccount(context);
  const subscription = await currentSubscription(context);
  if (!subscription.id) {
    throw new AccountAccessError(409, 'NO_SUBSCRIPTION', 'an active subscription is required before an invoice can be issued');
  }
  const now = new Date();
  const periodStart = subscription.currentPeriodStart ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodEnd = subscription.currentPeriodEnd ?? addMonthsUtc(periodStart, 1);
  const scope = subscription.organizationId ? { organizationId: subscription.organizationId } : { ownerId: userId, organizationId: null };

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await db.$transaction(async (tx) => {
        // Serialize concurrent issue attempts for the same subscription period.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invoice:${subscription.id}:${periodStart.toISOString()}`}))`;
        const existing = await tx.invoice.findFirst({
          where: { subscriptionId: subscription.id, periodStart, status: { not: 'void' } },
          select: invoiceDetailSelect,
        });
        if (existing) return { invoice: existing, created: false };
        const invoice = await tx.invoice.create({
          data: {
            ...scope,
            subscriptionId: subscription.id,
            number: invoiceNumber(periodStart),
            status: 'open',
            amountMinor: subscription.plan.monthlyPriceMinor,
            currency: subscription.plan.currency,
            periodStart,
            periodEnd,
            issuedAt: now,
            dueAt: new Date(now.getTime() + 14 * 86_400_000),
          },
          select: invoiceDetailSelect,
        });
        await writeMutationEffects(tx, {
          actor: `account:${userId}`,
          action: 'billing.invoice.issue',
          targetId: invoice.id,
          organizationId: subscription.organizationId,
          aggregateType: 'Invoice',
          aggregateId: invoice.id,
          eventType: 'invoice.issued',
          payload: {
            invoiceId: invoice.id,
            number: invoice.number,
            amountMinor: invoice.amountMinor,
            currency: invoice.currency,
            subscriptionId: subscription.id,
            periodStart,
            periodEnd,
          },
        });
        return { invoice, created: true };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10_000, timeout: 30_000 });
    } catch (error) {
      const code = errorCode(error);
      if ((code === 'P2002' || code === 'P2034') && attempt < 3) continue;
      throw error;
    }
  }
  throw new Error('invoice issue retry exhausted');
}

export async function listInvoices(
  context: TenantContext,
  options: { status?: 'open' | 'paid' | 'void'; limit?: number } = {},
): Promise<InvoiceRecord[]> {
  requireAccount(context);
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
  return db.invoice.findMany({
    where: { ...scopeWhere(context), ...(options.status ? { status: options.status } : {}) },
    orderBy: [{ issuedAt: 'desc' }, { createdAt: 'desc' }],
    take: limit,
    select: invoiceDetailSelect,
  });
}

/**
 * Record one manual settlement. The invoice must be open, the recorded amount
 * must equal the invoice total, and a linked subscription is activated and
 * advanced by one month in the same transaction.
 */
export async function settleInvoice(
  context: TenantContext,
  invoiceId: string,
  input: SettleInvoiceInput,
): Promise<{ invoice: InvoiceRecord; payment: PaymentRecord; subscription: { id: string; status: string; currentPeriodStart: Date | null; currentPeriodEnd: Date | null } | null }> {
  const userId = requireAccount(context);
  if (input.method === 'provider') {
    throw new AccountAccessError(409, 'PAYMENT_PROVIDER_NOT_CONFIGURED', 'no payment provider adapter is configured; record a manual bank or cash settlement');
  }
  if (!MANUAL_PAYMENT_METHODS.some((method) => method === input.method)) {
    throw new AccountAccessError(400, 'INVALID_PAYMENT_METHOD', `payment method must be one of ${MANUAL_PAYMENT_METHODS.join(', ')}`);
  }
  if (input.amountMinor !== undefined && (!Number.isInteger(input.amountMinor) || input.amountMinor < 0)) {
    throw new AccountAccessError(400, 'INVALID_AMOUNT', 'settlement amount must be a non-negative integer in minor units');
  }
  const reference = input.reference?.trim() || null;
  if (reference && reference.length > 200) {
    throw new AccountAccessError(400, 'INVALID_REFERENCE', 'settlement reference must be 200 characters or fewer');
  }

  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invoice-settle:${invoiceId}`}))`;
    const invoice = await tx.invoice.findUnique({ where: { id: invoiceId }, select: invoiceDetailSelect });
    if (!invoice || !inScope(invoice, context)) {
      throw new AccountAccessError(404, 'INVOICE_NOT_FOUND', 'invoice not found');
    }
    if (invoice.status !== 'open') {
      throw new AccountAccessError(409, 'INVOICE_NOT_OPEN', `invoice is ${invoice.status}; only open invoices can be settled`);
    }
    if (input.amountMinor !== undefined && input.amountMinor !== invoice.amountMinor) {
      throw new AccountAccessError(409, 'AMOUNT_MISMATCH', `settlement amount must equal the invoice total of ${invoice.amountMinor} ${invoice.currency} minor units`);
    }

    const now = new Date();
    const payment = await tx.payment.create({
      data: {
        invoiceId: invoice.id,
        organizationId: invoice.organizationId,
        amountMinor: invoice.amountMinor,
        currency: invoice.currency,
        method: input.method,
        status: 'succeeded',
        reference,
        recordedByUserId: userId,
      },
      select: paymentSelect,
    });

    let subscription: { id: string; status: string; currentPeriodStart: Date | null; currentPeriodEnd: Date | null } | null = null;
    if (invoice.subscriptionId) {
      const current = await tx.subscription.findUnique({
        where: { id: invoice.subscriptionId },
        select: { id: true, currentPeriodStart: true, currentPeriodEnd: true, status: true },
      });
      if (current) {
        const baseStart = current.currentPeriodStart ?? invoice.periodStart ?? now;
        const baseEnd = current.currentPeriodEnd ?? invoice.periodEnd ?? addMonthsUtc(baseStart, 1);
        const nextStart = addMonthsUtc(baseStart, 1);
        let nextEnd = addMonthsUtc(baseEnd, 1);
        if (nextEnd <= nextStart) nextEnd = addMonthsUtc(nextStart, 1);
        subscription = await tx.subscription.update({
          where: { id: current.id },
          data: { status: 'active', cancelAt: null, currentPeriodStart: nextStart, currentPeriodEnd: nextEnd },
          select: { id: true, status: true, currentPeriodStart: true, currentPeriodEnd: true },
        });
      }
    }

    const settled = await tx.invoice.update({
      where: { id: invoice.id },
      data: { status: 'paid', paidAt: now },
      select: invoiceDetailSelect,
    });

    await writeMutationEffects(tx, {
      actor: `account:${userId}`,
      action: 'billing.invoice.settle',
      targetId: invoice.id,
      detail: `manual ${input.method}${reference ? ` (${reference})` : ''}`,
      organizationId: invoice.organizationId,
      aggregateType: 'Invoice',
      aggregateId: invoice.id,
      eventType: 'invoice.paid',
      payload: {
        invoiceId: invoice.id,
        paymentId: payment.id,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        method: payment.method,
        reference,
        subscriptionId: invoice.subscriptionId,
        periodStart: subscription?.currentPeriodStart ?? null,
        periodEnd: subscription?.currentPeriodEnd ?? null,
      },
    });

    return { invoice: settled, payment, subscription };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10_000, timeout: 30_000 });
}

/** Void an open invoice. Voided invoices can never be settled. */
export async function voidInvoice(context: TenantContext, invoiceId: string, options: { reason?: string } = {}): Promise<InvoiceRecord> {
  const userId = requireAccount(context);
  const reason = options.reason?.trim() || null;
  if (reason && reason.length > 500) {
    throw new AccountAccessError(400, 'INVALID_REASON', 'void reason must be 500 characters or fewer');
  }

  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invoice-settle:${invoiceId}`}))`;
    const invoice = await tx.invoice.findUnique({ where: { id: invoiceId }, select: invoiceDetailSelect });
    if (!invoice || !inScope(invoice, context)) {
      throw new AccountAccessError(404, 'INVOICE_NOT_FOUND', 'invoice not found');
    }
    if (invoice.status !== 'open') {
      throw new AccountAccessError(409, 'INVOICE_NOT_OPEN', `invoice is ${invoice.status}; only open invoices can be voided`);
    }

    const voided = await tx.invoice.update({
      where: { id: invoice.id },
      data: { status: 'void', notes: reason ? [invoice.notes, reason].filter(Boolean).join('\n') : invoice.notes },
      select: invoiceDetailSelect,
    });

    await writeMutationEffects(tx, {
      actor: `account:${userId}`,
      action: 'billing.invoice.void',
      targetId: invoice.id,
      detail: reason ?? undefined,
      organizationId: invoice.organizationId,
      aggregateType: 'Invoice',
      aggregateId: invoice.id,
      eventType: 'invoice.voided',
      payload: { invoiceId: invoice.id, number: invoice.number, reason },
    });

    return voided;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10_000, timeout: 30_000 });
}
