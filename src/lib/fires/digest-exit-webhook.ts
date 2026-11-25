import { db } from '@/lib/db';
import { isTransient } from '@/lib/http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import type { DigestPushPayload } from '@/lib/fires/digest-push';
import { classifyIpLiteral, fetchPinnedPublicUrl } from '@/lib/network-safety';

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
 *   DIGEST_WEBHOOK_ALLOWLIST — optional; comma-separated "host" / "host:port"
 *                            entries that EXPLICITLY allow a target inside a
 *                            refused range (loopback/RFC1918/…). OWASP SSRF
 *                            posture: deny by default, allow by explicit
 *                            operator opt-in — for deployments whose ops
 *                            relay deliberately runs inside the private
 *                            network. Never widens the http(s)-scheme rule.
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
  /** Number of parsed DIGEST_WEBHOOK_ALLOWLIST entries (0 when absent). */
  allowlistCount: number;
  /** Null when the URL is absent/invalid, else the SSRF-guard verdict. */
  targetSafe: boolean | null;
  /** True when the target passed ONLY via an explicit allowlist entry. */
  targetAllowlisted: boolean | null;
  targetUnsafeReason: string | null;
}

/** One parsed allowlist entry: exact host (lowercase) + optional port. */
export interface WebhookAllowlistEntry {
  host: string;
  port: number | null;
}

/**
 * Parse DIGEST_WEBHOOK_ALLOWLIST — comma-separated "host" or "host:port"
 * entries (bracketed IPv6 allowed). Pure. Garbage entries are dropped, never
 * silently broadened: an entry containing "/" or an out-of-range port is
 * ignored, because a mis-parsed entry that matched too much would defeat the
 * guard it exists to narrow.
 */
export function parseWebhookAllowlist(raw: string | undefined | null): WebhookAllowlistEntry[] {
  if (!raw || !raw.trim()) return [];
  const entries: WebhookAllowlistEntry[] = [];
  for (const piece of raw.split(',')) {
    const entry = piece.trim().toLowerCase();
    if (!entry || entry.includes('/')) continue; // no CIDRs, no URLs, no paths
    let host = entry.replace(/^\[/, '');
    let port: number | null = null;
    const m = /^(.+):(\d{1,5})$/.exec(host);
    if (m) {
      host = m[1].replace(/\]$/, '');
      const p = Number(m[2]);
      if (!Number.isInteger(p) || p < 1 || p > 65_535) continue;
      port = p;
    } else {
      host = host.replace(/\]$/, '');
    }
    if (!host) continue;
    entries.push({ host, port });
  }
  return entries;
}

/** Does this URL match an allowlist entry? Pure. Exact host; port when pinned. */
export function webhookTargetAllowlisted(
  url: URL,
  allowlist: WebhookAllowlistEntry[],
): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  return allowlist.some((e) => e.host === host && (e.port === null || e.port === port));
}

/** Parse + validate the webhook exit configuration. Pure. */
export function parseWebhookConfig(env: Record<string, string | undefined>): WebhookConfig {
  const url = env.DIGEST_WEBHOOK_URL?.trim() || null;
  const secrets = secretFacts(env);
  const allowlist = parseWebhookAllowlist(env.DIGEST_WEBHOOK_ALLOWLIST);
  const common = {
    secretPresent: secrets.present,
    secretBytes: secrets.bytes,
    secretAdequate: secrets.adequate,
    rotationSecretPresent: secrets.rotationPresent,
    allowlistCount: allowlist.length,
  };
  const verdict = (u: string) => {
    const guard = assertWebhookTargetSafe(u, allowlist);
    return { targetSafe: guard.ok, targetAllowlisted: guard.ok && guard.allowlisted === true, targetUnsafeReason: guard.ok ? null : guard.reason ?? null };
  };
  if (env.DIGEST_WEBHOOK_OFF === '1') {
    return { enabled: false, state: 'disabled', url, host: hostOf(url), ...common, ...(url ? verdict(url) : { targetSafe: null, targetAllowlisted: null, targetUnsafeReason: null }) };
  }
  if (!url) {
    return { enabled: false, state: 'not-configured', url: null, host: null, ...common, targetSafe: null, targetAllowlisted: null, targetUnsafeReason: null };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // An invalid URL would fail every delivery — treat as not configured and
    // say so through the status surface (never silently POST to a bad target).
    return { enabled: false, state: 'not-configured', url, host: null, ...common, targetSafe: null, targetAllowlisted: null, targetUnsafeReason: null };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { enabled: false, state: 'not-configured', url, host: null, ...common, targetSafe: null, targetAllowlisted: null, targetUnsafeReason: null };
  }
  return { enabled: true, state: 'configured', url, host: parsed.host, ...common, ...verdict(url) };
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
 *
 * `allowlist` (entries or a raw DIGEST_WEBHOOK_ALLOWLIST string) can rescue a
 * target from the PRIVATE-RANGE refusals ONLY, and only on an exact host (or
 * host:port) match — the OWASP "default deny + explicit allow" pattern for
 * deployments whose ops relay deliberately lives inside the private network.
 * The http(s)-only scheme rule and unparseable-URL refusals are absolute and
 * can never be allowlisted.
 */
export function assertWebhookTargetSafe(
  rawUrl: string,
  allowlist?: string | (string | WebhookAllowlistEntry)[] | null,
): { ok: boolean; reason?: string; allowlisted?: boolean } {
  const entries: WebhookAllowlistEntry[] = !allowlist
    ? []
    : typeof allowlist === 'string'
      ? parseWebhookAllowlist(allowlist)
      : allowlist.map((a) => (typeof a === 'string' ? parseWebhookAllowlist(a)[0] : a)).filter((e): e is WebhookAllowlistEntry => Boolean(e));
  const rescued = (): { ok: boolean; allowlisted: boolean } => ({ ok: true, allowlisted: true });
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'unparseable URL' }; // never allowlistable
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: `scheme ${u.protocol} refused (http/https only)` }; // never allowlistable
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return { ok: false, reason: 'empty hostname' };
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    if (webhookTargetAllowlisted(u, entries)) return rescued();
    return { ok: false, reason: `hostname ${host} is loopback/internal-only` };
  }
  const literalVerdict = classifyIpLiteral(host);
  if (literalVerdict && !literalVerdict.ok) {
    if (webhookTargetAllowlisted(u, entries)) return rescued();
    return { ok: false, reason: `${literalVerdict.reason ?? 'non-global address'} — refused (SSRF guard)` };
  }
  return { ok: true };
}

/** Resolve and validate every A/AAAA answer before any outbound request. */
export async function assertResolvedWebhookTargetSafe(
  rawUrl: string,
  allowlist?: string | (string | WebhookAllowlistEntry)[] | null,
): Promise<{ ok: boolean; reason?: string; allowlisted?: boolean }> {
  const initial = assertWebhookTargetSafe(rawUrl, allowlist);
  if (!initial.ok || initial.allowlisted) return initial;
  const url = new URL(rawUrl);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')) return initial;
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    return { ok: false, reason: 'target hostname did not resolve' };
  }
  if (addresses.length === 0) return { ok: false, reason: 'target hostname has no addresses' };
  for (const { address } of addresses) {
    const literal = address.includes(':') ? `[${address}]` : address;
    const verdict = assertWebhookTargetSafe(`${url.protocol}//${literal}`, null);
    if (!verdict.ok) return { ok: false, reason: `resolved address refused: ${verdict.reason}` };
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
  allowlistCount: number;
  targetSafe: boolean | null;
  /** True when the target passed the SSRF guard ONLY via an allowlist entry. */
  targetAllowlisted: boolean | null;
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
    allowlistCount: cfg.allowlistCount,
    targetSafe: cfg.targetSafe,
    targetAllowlisted: cfg.targetAllowlisted,
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
        ? `Webhook digest exit ARMED: every digest-relevant fact (evaluation or failed scheduled run) is POSTed to the configured URL as the same DigestPushPayload JSON the SSE channel carries — signed (${cfg.secretAdequate ? 'secret ≥32 bytes' : `secret ${cfg.secretBytes} bytes; rotate to ≥32 bytes`}) with timestamped HMAC v1, guarded against SSRF targets, transient-only retry (max 3 attempts) and one provenance row per attempt.${cfg.targetAllowlisted ? ` Private target explicitly allowed via DIGEST_WEBHOOK_ALLOWLIST (${cfg.allowlistCount} ${cfg.allowlistCount === 1 ? 'entry' : 'entries'}) — operator opt-in for an internal relay.` : ''}${cfg.targetSafe === false ? ' CURRENT TARGET IS REFUSED BY THE SSRF GUARD — delivery will not be attempted.' : ''}`
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
  // is refused outright unless the operator explicitly allowlisted it
  // (DIGEST_WEBHOOK_ALLOWLIST) — the status surface names the reason either
  // way. No request, no signature, no attempt budget burned on a refusal.
  const guard = await assertResolvedWebhookTargetSafe(cfg.url, process.env.DIGEST_WEBHOOK_ALLOWLIST);
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
  const headers = {
    ...buildWebhookHeaders({ secret: process.env.DIGEST_WEBHOOK_SECRET || null, bodyText }),
    'idempotency-key': payload.eventId,
    'x-terrafield-event-id': payload.eventId,
  };
  const rt = runtime();
  let last: { ok: boolean; status: number; error: string | null } = { ok: false, status: 0, error: 'no attempt made' };

  for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
    const startedAt = Date.now();
    try {
    const res = await fetchPinnedPublicUrl(cfg.url, {
      method: 'POST',
      headers,
      body: bodyText,
      timeoutMs: WEBHOOK_TIMEOUT_MS,
      maxResponseBytes: 64 * 1024,
      allowPrivate: cfg.targetAllowlisted === true,
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
