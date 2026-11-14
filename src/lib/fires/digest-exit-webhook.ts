import { db } from '@/lib/db';
import { isTransient } from '@/lib/http';
import { createHmac, timingSafeEqual } from 'node:crypto';
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
 *   DIGEST_WEBHOOK_SECRET  — HMAC-SHA256 signing secret (≥32 bytes recommended)
 *   DIGEST_WEBHOOK_SECRET_PREVIOUS — optional; the PREVIOUS secret, still
 *                            accepted by `verifyWebhookSignature` during
 *                            zero-downtime rotation on the RECEIVER side
 *   DIGEST_WEBHOOK_OFF=1   — hard disable, surfaced in /api/v1/system/status
 *
 * SIGNATURE SCHEME (OWASP-aligned, Stripe-compatible shape):
 *   x-terrafield-signature: t=<unix-seconds>,v1=hex(HMAC-SHA256(secret, `${t}.${exactBodyBytes}`))
 *   - The timestamp binds the signature to a moment → a captured request
 *     replayed later fails the receiver's freshness window (default ±300 s).
 *   - The MAC covers the timestamp AND the exact body bytes → no body tamper.
 *   - Receivers verify with `verifyWebhookSignature` (exported): constant-
 *     time compare, replay window, and rotation (primary + previous secret).
 *   - A legacy body-only MAC is ALSO sent as x-terrafield-signature-sha256
 *     for receivers written against the first scheme; the timestamped header
 *     is the one to verify.
 * SSRF GUARD: outbound webhook targets are validated before any POST —
 *   loopback, RFC1918, link-local (incl. the cloud metadata address), CGNAT,
 *   IPv6 ULA/link-local and non-http(s) schemes are refused. A misconfigured
 *   URL can never be used to reach the deployment's own private network.
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
 * signature verification, SSRF checks, retry decision) are unit-tested
 * directly; the impure half is the sender.
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
  /** Signing-secret length in bytes (0 when absent). */
  secretBytes: number;
  /** True when the secret meets the ≥32-byte recommendation. */
  secretAdequate: boolean;
  /** True when a previous (rotation) secret is present for receivers. */
  rotationSecretPresent: boolean;
  /** Null when the URL is absent/invalid, else the SSRF-guard verdict. */
  targetSafe: boolean | null;
  targetUnsafeReason: string | null;
}

/** Parse + validate the webhook exit configuration. Pure. */
export function parseWebhookConfig(env: Record<string, string | undefined>): WebhookConfig {
  const url = env.DIGEST_WEBHOOK_URL?.trim() || null;
  const secrets = secretFacts(env);
  const common = { secretPresent: secrets.present, secretBytes: secrets.bytes, secretAdequate: secrets.adequate, rotationSecretPresent: secrets.rotationPresent };
  if (env.DIGEST_WEBHOOK_OFF === '1') {
    return { enabled: false, state: 'disabled', url, host: hostOf(url), ...common, targetSafe: url ? assertWebhookTargetSafe(url).ok : null, targetUnsafeReason: url ? assertWebhookTargetSafe(url).reason ?? null : null };
  }
  if (!url) {
    return { enabled: false, state: 'not-configured', url: null, host: null, ...common, targetSafe: null, targetUnsafeReason: null };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // An invalid URL would fail every delivery — treat as not configured and
    // say so through the status surface (never silently POST to a bad target).
    return { enabled: false, state: 'not-configured', url, host: null, ...common, targetSafe: null, targetUnsafeReason: null };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { enabled: false, state: 'not-configured', url, host: null, ...common, targetSafe: null, targetUnsafeReason: null };
  }
  const guard = assertWebhookTargetSafe(url);
  return { enabled: true, state: 'configured', url, host: parsed.host, ...common, targetSafe: guard.ok, targetUnsafeReason: guard.ok ? null : guard.reason ?? null };
}

function secretFacts(env: Record<string, string | undefined>) {
  const secret = env.DIGEST_WEBHOOK_SECRET?.trim();
  return {
    present: Boolean(secret && secret.length > 0),
    bytes: secret ? Buffer.byteLength(secret, 'utf8') : 0,
    adequate: Boolean(secret && Buffer.byteLength(secret, 'utf8') >= 32),
    rotationPresent: Boolean(env.DIGEST_WEBHOOK_SECRET_PREVIOUS?.trim()),
  };
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
// Pure: request shape + OWASP signature scheme + SSRF guard
// ---------------------------------------------------------------------------

/** Receiver-side freshness window (OWASP anti-replay): ±5 minutes. */
export const WEBHOOK_SIGNATURE_TOLERANCE_SEC = 300;
export const WEBHOOK_SECRET_RECOMMENDED_BYTES = 32;

/** Signing timestamp for a delivery — unix seconds. Pure. */
export function webhookTimestamp(now: Date = new Date()): number {
  return Math.floor(now.getTime() / 1000);
}

/** HMAC-SHA256(secret, `${timestamp}.${exactBodyBytes}`), hex — the v1 MAC. Pure. */
export function signWebhookV1(secret: string, bodyText: string, timestampSec: number): string {
  return createHmac('sha256', secret).update(`${timestampSec}.${bodyText}`, 'utf8').digest('hex');
}

/** Headers for the outbound POST. Pure — HMACs cover the EXACT body bytes. */
export function buildWebhookHeaders(input: {
  secret: string | null;
  bodyText: string;
  /** Fix for deterministic tests; defaults to the current time. */
  timestampSec?: number;
}): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'terrafield-atlas/digest-exit (+https://github.com/nasa/space-apps-2026)',
    'x-terrafield-topic': 'watchlist.digest',
  };
  if (input.secret) {
    const t = input.timestampSec ?? webhookTimestamp();
    headers['x-terrafield-signature'] = `t=${t},v1=${signWebhookV1(input.secret, input.bodyText, t)}`;
    // Legacy body-only MAC, kept for receivers written against the first
    // scheme. Receivers SHOULD verify the timestamped header instead.
    const legacy = createHmac('sha256', input.secret).update(input.bodyText, 'utf8').digest('hex');
    headers['x-terrafield-signature-sha256'] = `sha256=${legacy}`;
  }
  return headers;
}

function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

export interface WebhookVerifyInput {
  /** RAW request body bytes (as received — never a re-serialized object). */
  rawBody: string;
  /** The x-terrafield-signature header value (null when absent). */
  header: string | null;
  /** Acceptable secrets, in rotation order: [primary, previous, …]. */
  secrets: (string | undefined | null)[];
  nowSec?: number;
  toleranceSec?: number;
}

export interface WebhookVerifyResult {
  valid: boolean;
  reason?: 'missing-header' | 'malformed' | 'replay-window' | 'signature-mismatch' | 'no-secrets-configured';
  /** Index into the provided secrets list of the MAC that matched. */
  matchedSecretIndex?: number;
}

/**
 * Receiver-side verification (exported for webhook consumers; unit-tested).
 * Constant-time compare + anti-replay window + secret rotation.
 */
export function verifyWebhookSignature(input: WebhookVerifyInput): WebhookVerifyResult {
  const secrets = (input.secrets ?? []).filter((s): s is string => Boolean(s && s.length > 0));
  if (secrets.length === 0) return { valid: false, reason: 'no-secrets-configured' };
  if (!input.header) return { valid: false, reason: 'missing-header' };
  const m = /^\s*t=(\d{1,12})\s*,\s*v1=([0-9a-f]{64})\s*$/i.exec(input.header);
  if (!m) return { valid: false, reason: 'malformed' };
  const t = Number(m[1]);
  const mac = m[2].toLowerCase();
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSec ?? WEBHOOK_SIGNATURE_TOLERANCE_SEC;
  if (Math.abs(nowSec - t) > tolerance) return { valid: false, reason: 'replay-window' };
  for (let i = 0; i < secrets.length; i++) {
    if (timingSafeHexEqual(signWebhookV1(secrets[i], input.rawBody, t), mac)) {
      return { valid: true, matchedSecretIndex: i };
    }
  }
  return { valid: false, reason: 'signature-mismatch' };
}

/**
 * SSRF guard for outbound webhook targets. Pure (hostname-literal checks; a
 * deployment that needs DNS-level defense should run the guard in an egress
 * proxy — documented in the README's hardening section).
 */
export function assertWebhookTargetSafe(rawUrl: string): { ok: boolean; reason?: string } {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'unparseable URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: `scheme ${u.protocol} refused (http/https only)` };
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return { ok: false, reason: 'empty hostname' };
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, reason: `hostname ${host} is loopback/internal-only` };
  }
  // IPv4 (incl. IPv4-mapped IPv6) private ranges
  let v4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ? host : null;
  const v4mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host);
  if (!v4 && v4mapped) v4 = v4mapped[1];
  if (v4) {
    const parts = v4.split('.').map(Number);
    if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return { ok: false, reason: `invalid IPv4 literal ${v4}` };
    const [a, b] = parts;
    const privateRanges: { a: number; bMin: number; bMax: number; fullA: boolean; label: string }[] = [
      { a: 0, bMin: 0, bMax: 255, fullA: true, label: 'this-network (0.0.0.0/8)' },
      { a: 10, bMin: 0, bMax: 255, fullA: true, label: 'RFC1918 10/8' },
      { a: 127, bMin: 0, bMax: 255, fullA: true, label: 'loopback 127/8' },
      { a: 169, bMin: 254, bMax: 254, fullA: false, label: 'link-local 169.254/16 (cloud metadata included)' },
      { a: 172, bMin: 16, bMax: 31, fullA: false, label: 'RFC1918 172.16/12' },
      { a: 192, bMin: 168, bMax: 168, fullA: false, label: 'RFC1918 192.168/16' },
      { a: 100, bMin: 64, bMax: 127, fullA: false, label: 'CGNAT 100.64/10' },
    ];
    for (const r of privateRanges) {
      if (a === r.a && (r.fullA || (b >= r.bMin && b <= r.bMax))) {
        return { ok: false, reason: `target falls in ${r.label} — refused (SSRF guard)` };
      }
    }
  }
  if (/^::1$/.test(host) || /^(f[cd])[0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host)) {
    return { ok: false, reason: 'IPv6 loopback/ULA/link-local target refused (SSRF guard)' };
  }
  return { ok: true };
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
  secretBytes: number;
  secretAdequate: boolean;
  rotationSecretPresent: boolean;
  targetSafe: boolean | null;
  targetUnsafeReason: string | null;
  signingScheme: string;
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
  const signingScheme = 'x-terrafield-signature: t=<unix-sec>,v1=hex(HMAC-SHA256(secret, "<t>.<exact body>")) — replay window ±300 s, constant-time verify, rotation via DIGEST_WEBHOOK_SECRET_PREVIOUS';
  return {
    state: cfg.state,
    urlConfigured: Boolean(cfg.url),
    host: cfg.host,
    secretPresent: cfg.secretPresent,
    secretBytes: cfg.secretBytes,
    secretAdequate: cfg.secretAdequate,
    rotationSecretPresent: cfg.rotationSecretPresent,
    targetSafe: cfg.targetSafe,
    targetUnsafeReason: cfg.targetUnsafeReason,
    signingScheme,
    attempts: rt.attempts,
    delivered: rt.delivered,
    failed: rt.failed,
    lastAttemptAt: rt.lastAttemptAt ? rt.lastAttemptAt.toISOString() : null,
    lastDeliveredAt: rt.lastDeliveredAt ? rt.lastDeliveredAt.toISOString() : null,
    lastError: rt.lastError,
    note:
      cfg.state === 'configured'
        ? `Webhook digest exit ARMED: every digest-relevant fact (evaluation or failed scheduled run) is POSTed to the configured URL as the same DigestPushPayload JSON the SSE channel carries — signed (${cfg.secretAdequate ? 'secret ≥32 bytes' : `secret ${cfg.secretBytes} bytes; rotate to ≥32 bytes`}) with timestamped HMAC v1, guarded against SSRF targets, transient-only retry (max 3 attempts) and one provenance row per attempt.${cfg.targetSafe === false ? ' CURRENT TARGET IS REFUSED BY THE SSRF GUARD — delivery will not be attempted.' : ''}`
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
  // SSRF guard BEFORE any outbound work: a loopback/RFC1918/metadata target
  // is refused outright (the status surface names the reason). No request,
  // no signature, no attempt budget burned.
  const guard = assertWebhookTargetSafe(cfg.url);
  if (!guard.ok) {
    const rt = runtime();
    rt.failed += 1;
    rt.lastError = `SSRF guard refused target: ${guard.reason}`;
    await recordAudit('digest.webhook.fail', payload, {
      attempts: 0,
      status: 0,
      error: rt.lastError,
      correlationId: ctx.correlationId,
    }, ctx.now);
    return { delivered: false, attempts: 0, status: 0, error: rt.lastError };
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
