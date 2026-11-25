import { MAX_STREAM_CLIENTS, buildDigestPushPayload, type DigestHub, type DigestHubStatus, type DigestPushReason } from '@/lib/fires/digest-push';
import { createRedisDigestHub } from '@/lib/fires/redis-digest-hub';
import { computeWatchlistDigest } from '@/lib/fires/watchlist-digest-service';
import { parseWebhookConfig, webhookExitStatus, deliverDigestWebhook, type WebhookExitStatus } from '@/lib/fires/digest-exit-webhook';
import { parseEmailConfig, emailExitStatus, deliverDigestEmail, shouldEmailDigest, type EmailExitStatus } from '@/lib/fires/digest-exit-email';
import { db } from '@/lib/db';

/**
 * Digest push channel — the RUNTIME half (process-wide singleton + publish
 * entry point). The pure wire/hub/payload engine is `lib/fires/digest-push.ts`;
 * the SSE route is `app/api/v1/fires/watchlists/digest-stream/route.ts`.
 *
 * The singleton lives on globalThis exactly like the scheduler runtime —
 * dev HMR re-imports must never fork the channel or double-register sinks.
 *
 * Publishing is fire-and-forget by contract: callers `void` it and the
 * function never throws. With ZERO open connections it does no database
 * work at all (an idle deployment pays nothing). DIGEST_PUSH_OFF=1 disables
 * the channel entirely (surfaced in /api/v1/system/status).
 */

interface DigestChannelRuntime {
  hub: DigestHub;
  disabledByEnv: boolean;
}

const runtimeHost = globalThis as unknown as { __terraDigestChannel?: DigestChannelRuntime };

function runtime(): DigestChannelRuntime {
  if (!runtimeHost.__terraDigestChannel) {
    runtimeHost.__terraDigestChannel = {
      hub: createRedisDigestHub(),
      disabledByEnv: process.env.DIGEST_PUSH_OFF === '1',
    };
  }
  return runtimeHost.__terraDigestChannel;
}

/** The process-wide channel hub (the SSE route registers/unregisters its sinks here). */
export function digestChannel(): DigestHub {
  return runtime().hub;
}

/** Diagnostics for /api/v1/system/status — cheap, no DB. */
export function digestChannelStatus(): DigestHubStatus & {
  kind: 'sse';
  enabled: boolean;
  disabledByEnv: boolean;
  maxClients: number;
  exits: { webhook: WebhookExitStatus; email: EmailExitStatus };
  note: string;
} {
  const rt = runtime();
  return {
    kind: 'sse',
    enabled: !rt.disabledByEnv,
    disabledByEnv: rt.disabledByEnv,
    maxClients: MAX_STREAM_CLIENTS,
    ...rt.hub.status(),
    exits: { webhook: webhookExitStatus(), email: emailExitStatus() },
    note: 'Push-style digest delivery over Server-Sent Events (GET /api/v1/fires/watchlists/digest-stream) — one channel on the single exposed HTTP port, no broker or extra port. Public digests reach every open console; private digests reach only revalidated owner sessions. With zero subscribers and no armed exits the channel does no database work. Missed events remain available from the per-watchlist digest endpoint. Public-demo-only delivery exits (env-gated): a webhook POST (DIGEST_WEBHOOK_URL) and SMTP email for scheduler facts (DIGEST_SMTP_*).',
  };
}

export async function publishDigestToSse(payload: import('@/lib/fires/digest-push').DigestPushPayload, ownerId: string | null): Promise<number> {
  const rt = runtime();
  if (rt.disabledByEnv) return 0;
  const hub = rt.hub;
  if (ownerId) return (await hub.publishPrivate('watchlist.digest', payload, ownerId)).delivered;
  return hub.publish('watchlist.digest', payload).delivered;
}

export type DigestPublishOutcome = {
  published: number; // connections the digest was written to
  skipped: boolean;
  skipReason?: 'disabled' | 'no-subscribers' | 'watchlist-gone' | 'no-exits' | 'private-watchlist';
  /** Webhook exit result — null when the exit was not armed. */
  webhook: { delivered: boolean; attempts: number; status: number; error: string | null } | null;
  /** Email exit result — null when the exit was not armed or the fact was not scheduler activity. */
  email: { sent: boolean; error: string | null } | null;
};

/**
 * Recompute the cadence-aware digest for one watchlist and fan it out over
 * EVERY armed delivery exit. Fire-and-forget by contract — NEVER throws.
 *
 * Exits, in firing order (one digest computation shared by all of them):
 *  1. SSE channel — skipped with zero work when disabled or no consoles.
 *  2. Webhook exit — POSTs the identical payload to DIGEST_WEBHOOK_URL when
 *     armed (any digest-relevant fact).
 *  3. Email exit — SMTP send for SCHEDULER facts only, when DIGEST_SMTP_* is
 *     configured (manual/backtest feedback already exists at the console).
 *
 * When NO exit is armed, this resolves without touching the DB. A watchlist
 * deleted between its run and this push → skipped honestly.
 *
 * The digest is computed with the watchlist's own window (cadence or the 24 h
 * default) — exactly what the Digest popover shows by default — so a pushed
 * payload can drop straight into the client's digest cache.
 */
export async function publishDigestForWatchlist(
  watchlistId: string,
  reason: DigestPushReason,
  ctx: { correlationId: string | null; triggeredAt: Date; now?: Date; triggeringEventId?: string | null },
): Promise<DigestPublishOutcome> {
  try {
    const rt = runtime();
    const webhookCfg = parseWebhookConfig(process.env as Record<string, string | undefined>);
    const emailCfg = parseEmailConfig(process.env as Record<string, string | undefined>);
    const sseActive = !rt.disabledByEnv && rt.hub.subscriberCount() > 0;

    if (!sseActive && !webhookCfg.enabled && !emailCfg.enabled) {
      return {
        published: 0,
        skipped: true,
        skipReason: rt.disabledByEnv ? 'disabled' : 'no-exits',
        webhook: null,
        email: null,
      };
    }

    // Global webhook and SMTP destinations are public-demo exits only.
    const watchlist = await db.fireWatchlist.findUnique({ where: { id: watchlistId }, select: { ownerId: true } });
    if (!watchlist) return { published: 0, skipped: true, skipReason: 'watchlist-gone', webhook: null, email: null };
    const privateOwner = watchlist.ownerId;
    if (privateOwner !== null && !sseActive) return { published: 0, skipped: true, skipReason: 'no-subscribers', webhook: null, email: null };
    const computed = await computeWatchlistDigest(watchlistId, {
      now: ctx.now,
      ownerId: privateOwner,
      triggeringEventId: ctx.triggeringEventId,
    });
    if (!computed.ok) {
      return { published: 0, skipped: true, skipReason: 'watchlist-gone', webhook: null, email: null };
    }

    const now = ctx.now ?? new Date();
    const payload = buildDigestPushPayload({
      eventId: ctx.triggeringEventId ?? computed.result.triggeringEventId ?? `digest:${watchlistId}:${ctx.triggeredAt.toISOString()}`,
      reason,
      // After an evaluation event lands, it is the newest evaluation in the
      // window — the digest reports its trigger. Scheduled failures wrote no
      // evaluation, so the payload honestly carries null.
      trigger: reason === 'evaluation' ? computed.result.newestEventTrigger : null,
      correlationId: ctx.correlationId,
      triggeredAt: ctx.triggeredAt,
      now,
      watchlistId: computed.result.watchlist.id,
      watchlistName: computed.result.watchlist.name,
      watchlist: computed.result.watchlist,
      digest: computed.result.digest,
    });

    const published = sseActive ? await publishDigestToSse(payload, privateOwner) : 0;

    // Exit 2 — outbound webhook POST (any digest-relevant fact when armed).
    let webhook: DigestPublishOutcome['webhook'] = null;
    if (privateOwner === null && webhookCfg.enabled) {
      const outcome = await deliverDigestWebhook(payload, { correlationId: ctx.correlationId, now });
      webhook = { delivered: outcome.delivered, attempts: outcome.attempts, status: outcome.status, error: outcome.error };
    }

    // Exit 3 — SMTP email (scheduler facts only when armed).
    let email: DigestPublishOutcome['email'] = null;
    if (privateOwner === null && emailCfg.enabled && shouldEmailDigest(payload)) {
      const outcome = await deliverDigestEmail(payload, { correlationId: ctx.correlationId, now });
      email = { sent: outcome.sent, error: outcome.error };
    }

    return { published, skipped: false, webhook, email };
  } catch (err) {
    // Delivery must never take anything else down (the REST digest and the
    // runs history remain the durable records).
    console.error('[digest-push] publish failed:', err instanceof Error ? err.message : err);
    return { published: 0, skipped: true, webhook: null, email: null };
  }
}
