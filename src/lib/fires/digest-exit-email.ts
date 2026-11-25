import { db } from '@/lib/db';
import { mailTransport, sendEmail } from '@/lib/mail';
import type { DigestPushPayload } from '@/lib/fires/digest-push';

/**
 * Email digest exit — Resend HTTPS or SMTP delivery of cadence-aware digests.
 *
 * Topology note (same family as lib/scheduler.ts, digest-push.ts and
 * digest-exit-webhook.ts): the runtime is ONE Node process. SMTP is plain
 * OUTBOUND TCP to any mail host, which this topology fully supports; nothing
 * new needs to exist "in the topology" beyond credentials.
 *
 * Honesty contract (identical to the FIRMS_MAP_KEY pattern): when required
 * environment variables are absent, this exit reports state
 * 'not-configured', attempts ZERO sends, and says so through
 * /api/v1/system/status. It never fabricates a "sent" outcome.
 *
 * Firing rule (deliberately narrower than the webhook exit): emails fire ONLY
 * for scheduler activity — a completed scheduled re-evaluation or a failed
 * scheduled run. Manual and backtest evaluations are operator-initiated: the
 * operator already has console feedback, and emailing them their own click
 * would be noise, not a digest. The machine-to-machine facts (a cadence
 * produced a digest unattended) are the ones a mailbox cares about.
 *
 * Configuration (Resend takes precedence when its key is set):
 *   RESEND_API_KEY — HTTPS provider credential
 *   DIGEST_EMAIL_FROM / EMAIL_FROM — sender, falling back to DIGEST_SMTP_FROM
 *   DIGEST_EMAIL_TO — explicit recipients, falling back to DIGEST_SMTP_TO
 *   delivered@resend.dev is a reserved test destination, not a user mailbox.
 *   DIGEST_SMTP_HOST / _PORT (default 587) / _USER / _PASS — relay credentials
 *   DIGEST_SMTP_FROM  — envelope From (e.g. "TerraField Atlas <alerts@example.org>")
 *   DIGEST_SMTP_TO    — comma-separated recipient list
 *   DIGEST_EMAIL_OFF=1 — hard disable, surfaced in /api/v1/system/status
 */

// ---------------------------------------------------------------------------
// Pure: configuration
// ---------------------------------------------------------------------------

export type EmailConfigState = 'configured' | 'not-configured' | 'disabled' | 'incomplete';

export interface EmailConfig {
  transport: 'resend' | 'smtp';
  enabled: boolean;
  state: EmailConfigState;
  host: string | null;
  port: number;
  from: string | null;
  recipients: string[];
  /** Which required variable is missing, for the status surface. */
  missing: string[];
}

const REQUIRED_VARS = ['DIGEST_SMTP_HOST', 'DIGEST_SMTP_FROM', 'DIGEST_SMTP_TO'] as const;

/** Parse + validate the email exit configuration. Pure. */
export function parseEmailConfig(env: Record<string, string | undefined>): EmailConfig {
  const host = env.DIGEST_SMTP_HOST?.trim() || null;
  const transport = mailTransport(env);
  const from = env.DIGEST_EMAIL_FROM?.trim() || env.EMAIL_FROM?.trim() || env.DIGEST_SMTP_FROM?.trim() || null;
  const toRaw = env.DIGEST_EMAIL_TO?.trim() || env.DIGEST_SMTP_TO?.trim() || '';
  const recipients = toRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
  const port = Number.isFinite(Number(env.DIGEST_SMTP_PORT)) && Number(env.DIGEST_SMTP_PORT) > 0
    ? Math.trunc(Number(env.DIGEST_SMTP_PORT))
    : 587;

  if (env.DIGEST_EMAIL_OFF === '1') {
    return { transport, enabled: false, state: 'disabled', host, port, from, recipients, missing: [] };
  }

  const missing: string[] = [];
  if (transport === 'smtp' && !host) missing.push(REQUIRED_VARS[0]);
  if (!from) missing.push(transport === 'resend' ? 'DIGEST_EMAIL_FROM or EMAIL_FROM' : REQUIRED_VARS[1]);
  if (!toRaw) missing.push(transport === 'resend' ? 'DIGEST_EMAIL_TO' : REQUIRED_VARS[2]);
  if (transport === 'smtp' && Boolean(env.DIGEST_SMTP_USER?.trim()) !== Boolean(env.DIGEST_SMTP_PASS?.trim())) missing.push('DIGEST_SMTP_USER / DIGEST_SMTP_PASS');
  if (toRaw && recipients.length === 0) missing.push('DIGEST_SMTP_TO (no valid address parsed)');
  if (missing.length > 0) {
    return { transport, enabled: false, state: 'not-configured', host, port, from, recipients, missing };
  }

  return { transport, enabled: true, state: 'configured', host, port, from, recipients, missing: [] };
}

// ---------------------------------------------------------------------------
// Pure: message rendering
// ---------------------------------------------------------------------------

export interface RenderedEmail {
  subject: string;
  text: string;
}

/** Subject + body for one digest payload. Pure — no secrets, no network. */
export function renderDigestEmail(payload: DigestPushPayload): RenderedEmail {
  const d = payload.digest as {
    digest?: string[];
    failures?: unknown[];
    hours?: number;
    current?: { last?: { status?: string } | null };
  };
  const lines = (d.digest ?? []).slice(0, 4);
  const status = d.current?.last?.status ?? null;
  const subject = `TerraField fire digest — ${payload.watchlistName}${status ? ` — ${status.toUpperCase()}` : ' — digest'}`;

  const parts: string[] = [];
  parts.push(`Cadence-aware fire-alert digest for watchlist "${payload.watchlistName}".`);
  parts.push('');
  if (lines.length === 0) {
    parts.push('No evaluation landed inside this cadence window — nothing to report, nothing interpolated.');
  }
  for (const line of lines) parts.push(line);
  const failures = Array.isArray(d.failures) ? d.failures.length : 0;
  if (failures > 0) parts.push(`Failed scheduled runs reported in this window: ${failures}.`);
  parts.push('');
  parts.push(`Fact that produced this digest: ${payload.reason === 'scheduled-failure' ? 'a FAILED scheduled run' : `a ${payload.trigger} evaluation`}${payload.correlationId ? ` (correlation ${payload.correlationId})` : ''}.`);
  parts.push('The identical digest is available in the console (Fire Intelligence → Digest) and from GET /api/v1/fires/watchlists/{id}/digest — nothing in this email is interpolated.');
  parts.push('');
  parts.push('Recorded evaluations only. Archive-gap days are reported as no-data, never as zero fires.');
  return { subject, text: parts.join('\n') };
}

/**
 * Delivery predicate: scheduler activity ONLY. A manual/backtest evaluation is
 * the operator's own action — its feedback already exists at the console.
 */
export function shouldEmailDigest(payload: DigestPushPayload): boolean {
  return payload.reason === 'scheduled-failure' || payload.trigger === 'scheduled';
}

// ---------------------------------------------------------------------------
// Runtime: sender + status (globalThis singleton, HMR-safe)
// ---------------------------------------------------------------------------

export interface EmailExitStatus {
  transport: 'resend' | 'smtp';
  recipientMode: 'test-only' | 'configured-recipients' | 'none';
  state: EmailConfigState;
  host: string | null;
  port: number;
  recipients: number;
  missing: string[];
  sent: number;
  failed: number;
  lastSentAt: string | null;
  lastError: string | null;
  note: string;
}

interface EmailRuntime {
  sent: number;
  failed: number;
  lastSentAt: Date | null;
  lastError: string | null;
}

const runtimeHost = globalThis as unknown as { __terraDigestEmailExit?: EmailRuntime };

function runtime(): EmailRuntime {
  if (!runtimeHost.__terraDigestEmailExit) {
    runtimeHost.__terraDigestEmailExit = { sent: 0, failed: 0, lastSentAt: null, lastError: null };
  }
  return runtimeHost.__terraDigestEmailExit;
}

export function emailExitStatus(): EmailExitStatus {
  const cfg = parseEmailConfig(process.env as Record<string, string | undefined>);
  const rt = runtime();
  const base = {
    transport: cfg.transport,
    recipientMode: (cfg.recipients.length === 0 ? 'none' : cfg.recipients.every((r) => r.toLowerCase() === 'delivered@resend.dev') ? 'test-only' : 'configured-recipients') as EmailExitStatus['recipientMode'],
    state: cfg.state,
    host: cfg.transport === 'resend' ? 'api.resend.com' : cfg.host,
    port: cfg.transport === 'resend' ? 443 : cfg.port,
    recipients: cfg.recipients.length,
    missing: cfg.missing,
    sent: rt.sent,
    failed: rt.failed,
    lastSentAt: rt.lastSentAt ? rt.lastSentAt.toISOString() : null,
    lastError: rt.lastError,
  };
  return {
    ...base,
    note:
      cfg.state === 'configured'
        ? `Email digest exit ARMED via ${cfg.transport === 'resend' ? 'Resend HTTPS' : 'SMTP'} for scheduler facts only. ${base.recipientMode === 'test-only' ? 'Reserved Resend test destination only; no user mailbox delivery.' : 'Explicitly configured recipients only.'} One audit row per send or failure. Configured does not prove delivery.`
        : cfg.state === 'disabled'
          ? 'Email digest exit disabled by DIGEST_EMAIL_OFF=1 — the SSE channel, webhook exit and on-demand digests remain available.'
          : cfg.state === 'incomplete'
            ? `Email digest exit INCOMPLETE configuration (missing: ${cfg.missing.join(', ')}) — zero sends attempted, nothing fabricated.`
            : `Email digest exit NOT configured (missing: ${cfg.missing.join(', ')}). Zero sends attempted. Set RESEND_API_KEY, DIGEST_EMAIL_FROM or EMAIL_FROM, and DIGEST_EMAIL_TO; legacy SMTP remains supported.`,
  };
}

export type EmailDeliveryOutcome = {
  sent: boolean;
  error: string | null;
};

/**
 * Send one digest email through the configured provider. Fire-and-forget by
 * contract — NEVER throws. The shared sender bounds delivery to ten seconds.
 */
export async function deliverDigestEmail(
  payload: DigestPushPayload,
  ctx: { correlationId: string | null; now: Date },
): Promise<EmailDeliveryOutcome> {
  const cfg = parseEmailConfig(process.env as Record<string, string | undefined>);
  if (!cfg.enabled) {
    return { sent: false, error: 'exit not configured' };
  }
  if (!shouldEmailDigest(payload)) {
    return { sent: false, error: null };
  }

  const rt = runtime();
  const { subject, text } = renderDigestEmail(payload);
  try {
    const info = await sendEmail({
      from: cfg.from as string,
      to: cfg.recipients,
      subject,
      text,
    });
    rt.sent += 1;
    rt.lastSentAt = new Date();
    rt.lastError = null;
    await recordEmailAudit(true, payload, { subject, messageId: info.messageId, correlationId: ctx.correlationId }, ctx.now);
    return { sent: true, error: null };
  } catch {
    const message = `${cfg.transport === 'resend' ? 'Resend' : 'SMTP'} email delivery failed`;
    rt.failed += 1;
    rt.lastError = message;
    await recordEmailAudit(false, payload, { subject, error: message, correlationId: ctx.correlationId }, ctx.now);
    return { sent: false, error: message };
  }
}

async function recordEmailAudit(
  ok: boolean,
  payload: DigestPushPayload,
  detail: Record<string, unknown>,
  now: Date,
): Promise<void> {
  try {
    await db.auditEvent.create({
      data: {
        actor: 'system:digest-email',
        action: ok ? 'digest.email.deliver' : 'digest.email.fail',
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
  } catch {
    console.error('[digest-email] audit log failed');
  }
}
