import { db } from '@/lib/db';
import { isTransient } from '@/lib/http';
import { createHmac } from 'node:crypto';
import type { DigestPushPayload } from '@/lib/fires/digest-push';

/**
 * Webhook digest exit — push-style delivery to ONE configured HTTP(S) sink.
 *
 * Topology note (same as lib/scheduler.ts and lib/fires/digest-push.ts): the
 * runtime is ONE Node process behind ONE exposed HTTP port. The SSE channel
 * covers open consoles; THIS exit covers everything else an operator might
 * own — a chat ingest URL, an ops webhook relay, a phone notification bridge —
 * over plain OUTBOUND HTTP, which this topology fully supports.
 *
 * Firing rule: the SAME digest-relevant fact that publishes to the SSE channel
 * (an evaluation event — manual, backtest or scheduled — or a failed scheduled
 * run) is POSTed to the configured URL as the identical DigestPushPayload JSON.
 * A manual evaluation and its webhook delivery arrive together by design; the
 * receiver decides what to do with every fact.
 *
 * Configuration (README documents all of it):
 *   DIGEST_WEBHOOK_URL     — http(s)://… required to arm the exit
 *   DIGEST_WEBHOOK_SECRET  — optional; adds X-Terrafield-Signature: sha256=… (HMAC of the exact body bytes)
 *   DIGEST_WEBHOOK_OFF=1   — hard disable, surfaced in /api/v1/system/status
 *
 * Reliability contract (mirrors lib/http.ts for providers):
 *   - per-attempt provenance row in ApiRequestLog (provider 'DIGEST_WEBHOOK');
 *   - retry ONLY on transient outcomes (network error / timeout / 429 / 5xx),
 *     max 3 attempts with jittered backoff; permanent 4xx fails fast;
 *   - one audit-ledger row per FINAL outcome (deliver / fail);
 *   - never throws — a dead receiver must never take the channel or the
 *     evaluation that triggered it down.
 *
 * This module is split so the PURE halves (config parsing, header building,
 * retry decision) are unit-tested directly; the impure half is the sender.
 */

export const WEBHOOK_TIMEOUT_MS = 8_000;
export const WEBHOOK_MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Pure: configuration
// ---------------------------------------------------------------------------

export type WebhookConfigState = 'configured' | 'not-configured' | 'disabled';

export interface WebhookConfig {
  enabled: boolean;
  state: WebhookConfigState;
  url: string | null;
  /** Parsed URL, for status display (host shown, credentials never logged). */
  host: string | null;
  secretPresent: boolean;
}

/** Parse + validate the webhook exit configuration. Pure. */
export function parseWebhookConfig(env: Record<string, string | undefined>): WebhookConfig {
  const url = env.DIGEST_WEBHOOK_URL?.trim() || null;
  if (env.DIGEST_WEBHOOK_OFF === '1') {
    return { enabled: false, state: 'disabled', url, host: hostOf(url), secretPresent: secretPresent(env) };
  }
  if (!url) {
    return { enabled: false, state: 'not-configured', url: null, host: null, secretPresent: false };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // An invalid URL would fail every delivery — treat as not configured and
    // say so through the status surface (never silently POST to a bad target).
    return { enabled: false, state: 'not-configured', url, host: null, secretPresent: secretPresent(env) };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { enabled: false, state: 'not-configured', url, host: null, secretPresent: secretPresent(env) };
  }
  return { enabled: true, state: 'configured', url, host: parsed.host, secretPresent: secretPresent(env) };
}

function secretPresent(env: Record<string, string | undefined>): boolean {
  return Boolean(env.DIGEST_WEBHOOK_SECRET && env.DIGEST_WEBHOOK_SECRET.length > 0);
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pure: request shape
// ---------------------------------------------------------------------------

/** Headers for the outbound POST. Pure — the HMAC covers the EXACT body bytes. */
export function buildWebhookHeaders(input: { secret: string | null; bodyText: string }): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'terrafield-atlas/digest-exit (+https://github.com/nasa/space-apps-2026)',
  };
  if (input.secret) {
    const mac = createHmac('sha256', input.secret).update(input.bodyText, 'utf8').digest('hex');
    headers['x-terrafield-signature'] = `sha256=${mac}`;
  }
  return headers;
}

/** Retry decision, shared with the provider client's transient-only policy. */
export function shouldRetryWebhookAttempt(attemptOutcome: { ok: boolean; status: number }): boolean {
  if (attemptOutcome.ok) return false;
  return isTransient(attemptOutcome.status) || attemptOutcome.status === 0; // 0 = network error / timeout
}

// ---------------------------------------------------------------------------
// Runtime: sender + status (globalThis singleton, HMR-safe like the others)
// ---------------------------------------------------------------------------

export interface WebhookExitStatus {
  state: WebhookConfigState;
  urlConfigured: boolean;
  host: string | null;
  secretPresent: boolean;
  attempts: number;
  delivered: number;
  failed: number;
  lastAttemptAt: string | null;
  lastDeliveredAt: string | null;
  lastError: string | null;
  note: string;
}

interface WebhookRuntime {
  attempts: number;
  delivered: number;
  failed: number;
  lastAttemptAt: Date | null;
  lastDeliveredAt: Date | null;
  lastError: string | null;
}

const runtimeHost = globalThis as unknown as { __terraDigestWebhookExit?: WebhookRuntime };

function runtime(): WebhookRuntime {
  if (!runtimeHost.__terraDigestWebhookExit) {
    runtimeHost.__terraDigestWebhookExit = {
      attempts: 0, delivered: 0, failed: 0, lastAttemptAt: null, lastDeliveredAt: null, lastError: null,
    };
  }
  return runtimeHost.__terraDigestWebhookExit;
}

export function webhookExitStatus(): WebhookExitStatus {
  const cfg = parseWebhookConfig(process.env as Record<string, string | undefined>);
  const rt = runtime();
  return {
    state: cfg.state,
    urlConfigured: Boolean(cfg.url),
    host: cfg.host,
    secretPresent: cfg.secretPresent,
    attempts: rt.attempts,
    delivered: rt.delivered,
    failed: rt.failed,
    lastAttemptAt: rt.lastAttemptAt ? rt.lastAttemptAt.toISOString() : null,
    lastDeliveredAt: rt.lastDeliveredAt ? rt.lastDeliveredAt.toISOString() : null,
    lastError: rt.lastError,
    note:
      cfg.state === 'configured'
        ? 'Webhook digest exit ARMED: every digest-relevant fact (evaluation or failed scheduled run) is POSTed to the configured URL as the same DigestPushPayload JSON the SSE channel carries, with transient-only retry (max 3 attempts) and one provenance row per attempt. An invalid 4xx from the receiver fails fast and is reported — never retried.'
        : cfg.state === 'disabled'
          ? 'Webhook digest exit disabled by DIGEST_WEBHOOK_OFF=1 — the SSE channel and on-demand digests remain available.'
          : 'Webhook digest exit NOT configured (set DIGEST_WEBHOOK_URL to arm it). Zero outbound work is attempted; the SSE channel remains the push surface.',
  };
}

export type WebhookDeliveryOutcome = {
  delivered: boolean;
  attempts: number;
  status: number;
  error: string | null;
};

/**
 * POST one digest payload to the configured webhook. Fire-and-forget by
 * contract — NEVER throws; the final outcome lands in the audit ledger and
 * the status counters above.
 */
export async function deliverDigestWebhook(
  payload: DigestPushPayload,
  ctx: { correlationId: string | null; now: Date },
): Promise<WebhookDeliveryOutcome> {
  const cfg = parseWebhookConfig(process.env as Record<string, string | undefined>);
  if (!cfg.enabled || !cfg.url) {
    return { delivered: false, attempts: 0, status: 0, error: 'exit not configured' };
  }

  const bodyText = JSON.stringify(payload);
  const headers = buildWebhookHeaders({ secret: process.env.DIGEST_WEBHOOK_SECRET || null, bodyText });
  const rt = runtime();
  let last: { ok: boolean; status: number; error: string | null } = { ok: false, status: 0, error: 'no attempt made' };

  for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      const res = await fetch(cfg.url, {
        method: 'POST',
        headers,
        body: bodyText,
        signal: controller.signal,
        cache: 'no-store',
      });
      const latencyMs = Date.now() - startedAt;
      last = { ok: res.ok, status: res.status, error: res.ok ? null : `HTTP ${res.status} ${res.statusText}`.trim() };
      rt.attempts += 1;
      rt.lastAttemptAt = new Date();
      await logWebhookAttempt({
        url: cfg.url,
        status: res.status,
        latencyMs,
        ok: res.ok,
        errorDetail: last.error,
        correlationId: ctx.correlationId,
        attempt,
      });
      if (res.ok) {
        rt.delivered += 1;
        rt.lastDeliveredAt = new Date();
        rt.lastError = null;
        await recordAudit('digest.webhook.deliver', payload, {
          attempts: attempt,
          status: res.status,
          latencyMs,
          correlationId: ctx.correlationId,
        }, ctx.now);
        return { delivered: true, attempts: attempt, status: res.status, error: null };
      }
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      const detail =
        err instanceof Error
          ? err.name === 'AbortError'
            ? `timeout after ${WEBHOOK_TIMEOUT_MS}ms`
            : err.message
          : 'network error';
      last = { ok: false, status: 0, error: detail };
      rt.attempts += 1;
      rt.lastAttemptAt = new Date();
      await logWebhookAttempt({
        url: cfg.url,
        status: 0,
        latencyMs,
        ok: false,
        errorDetail: detail,
        correlationId: ctx.correlationId,
        attempt,
      });
    } finally {
      clearTimeout(timer);
    }

    // Transient-only retry, with the provider client's jittered backoff shape.
    if (attempt < WEBHOOK_MAX_ATTEMPTS && shouldRetryWebhookAttempt({ ok: last.ok, status: last.status })) {
      const base = 500 * Math.pow(2, attempt - 1);
      const delay = base / 2 + Math.random() * (base / 2);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }
    break; // permanent client error — failing fast is the honest move
  }

  rt.failed += 1;
  rt.lastError = last.error ?? 'unknown error';
  await recordAudit('digest.webhook.fail', payload, {
    attempts: WEBHOOK_MAX_ATTEMPTS,
    status: last.status,
    error: rt.lastError,
    correlationId: ctx.correlationId,
  }, ctx.now);
  return { delivered: false, attempts: WEBHOOK_MAX_ATTEMPTS, status: last.status, error: rt.lastError };
}

/** One provenance row per outbound attempt — the receiver is an external party. */
async function logWebhookAttempt(a: {
  url: string; status: number; latencyMs: number; ok: boolean;
  errorDetail: string | null; correlationId: string | null; attempt: number;
}): Promise<void> {
  try {
    await db.apiRequestLog.create({
      data: {
        provider: 'DIGEST_WEBHOOK',
        datasetId: null,
        operation: 'digest-exit-post',
        requestUrl: a.url.length > 900 ? a.url.slice(0, 900) : a.url,
        paramsHash: null,
        status: a.status,
        latencyMs: Math.round(a.latencyMs),
        responseBytes: null,
        ok: a.ok,
        errorDetail: a.errorDetail ? a.errorDetail.slice(0, 300) : null,
        correlationId: a.correlationId,
      },
    });
  } catch (err) {
    console.error('[digest-webhook] provenance log failed:', err instanceof Error ? err.message : err);
  }
}

async function recordAudit(
  action: 'digest.webhook.deliver' | 'digest.webhook.fail',
  payload: DigestPushPayload,
  detail: Record<string, unknown>,
  now: Date,
): Promise<void> {
  try {
    await db.auditEvent.create({
      data: {
        actor: 'system:digest-webhook',
        action,
        targetId: payload.watchlistId,
        detail: JSON.stringify({
          watchlistName: payload.watchlistName,
          reason: payload.reason,
          trigger: payload.trigger,
          attemptedAt: now.toISOString(),
          ...detail,
        }),
      },
    });
  } catch (err) {
    console.error('[digest-webhook] audit log failed:', err instanceof Error ? err.message : err);
  }
}
