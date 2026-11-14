/**
 * Real local HTTP receiver for the digest webhook exit — LIVE verification
 * harness for receivers written against the project's OWASP signature scheme.
 *
 * Verifies the TIMESTAMPED scheme the docs tell receivers to check:
 *   x-terrafield-signature: t=<unix-sec>,v1=hex(HMAC-SHA256(secret, "<t>.<raw body>"))
 * with the ±300 s anti-replay window, constant-time comparison, and secret
 * rotation (RECEIVER_SECRET primary + RECEIVER_SECRET_PREVIOUS). The legacy
 * body-only MAC (x-terrafield-signature-sha256) is also checked and reported
 * separately, so a delivery is only "valid" when at least one scheme
 * verifies — and the log names WHICH one.
 *
 * Listens on 127.0.0.1:<port>, accepts POST /digest, records every request
 * (receivedAt, headers, raw body, parsed summary, per-scheme verification)
 * to a JSONL log, answers 204 (or 401 when nothing verifies — a real
 * receiver's behavior), GET /health answers 200. Kills itself after
 * idleTimeoutMs of silence.
 *
 * Usage: RECEIVER_SECRET=… node scripts/webhook-receiver.mjs <port> <logPath> [idleTimeoutMs]
 */
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';

const port = Number(process.argv[2] ?? 4317);
const logPath = process.argv[3] ?? '/tmp/webhook-receiver.jsonl';
const idleTimeoutMs = Number(process.argv[4] ?? 300_000);
const TOLERANCE_SEC = Number(process.env.RECEIVER_TOLERANCE_SEC ?? 300);

// Rotation order: primary first, then previous — mirrors verifyWebhookSignature.
const SECRETS = [process.env.RECEIVER_SECRET, process.env.RECEIVER_SECRET_PREVIOUS]
  .filter((s) => s && s.length > 0);

const mac = (secret, data) => createHmac('sha256', secret).update(data, 'utf8').digest('hex');
const safeEq = (a, b) =>
  a.length === b.length && (() => { try { return timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; } })();

writeFileSync(logPath, '');

let lastTraffic = Date.now();
const server = createServer((req, res) => {
  lastTraffic = Date.now();
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, receiver: 'terrafield-digest-webhook', schemes: ['v1', 'legacy'] }));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const receivedAt = new Date().toISOString();
    const nowSec = Math.floor(Date.now() / 1000);

    let parsed = null;
    let parseError = null;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }

    // ---- Scheme 1: timestamped v1 (the one receivers SHOULD verify) ----
    const v1Header = typeof req.headers['x-terrafield-signature'] === 'string'
      ? req.headers['x-terrafield-signature'] : null;
    const m = v1Header ? /^\s*t=(\d{1,12})\s*,\s*v1=([0-9a-f]{64})\s*$/i.exec(v1Header) : null;
    let v1 = { present: Boolean(v1Header), wellFormed: Boolean(m), verified: false, reason: null, timestampSec: null, sigAgeSec: null, replayRefused: false, matchedSecretIndex: null };
    if (v1Header && !m) {
      v1.reason = 'malformed';
    } else if (m) {
      const t = Number(m[1]);
      const macHex = m[2].toLowerCase();
      v1.timestampSec = t;
      v1.sigAgeSec = nowSec - t;
      if (Math.abs(nowSec - t) > TOLERANCE_SEC) {
        v1.reason = 'replay-window';
        v1.replayRefused = true;
      } else {
        const idx = SECRETS.findIndex((s) => safeEq(mac(s, `${t}.${raw}`), macHex));
        if (idx >= 0) {
          v1.verified = true;
          v1.matchedSecretIndex = idx;
        } else {
          v1.reason = 'signature-mismatch';
        }
      }
    } else if (v1Header) {
      // header present but regex failed on shape — keep malformed above
    }

    // ---- Scheme 2: legacy body-only MAC (kept for first-gen receivers) ----
    const legacyHeader = typeof req.headers['x-terrafield-signature-sha256'] === 'string'
      ? req.headers['x-terrafield-signature-sha256'] : null;
    const legacyMac = legacyHeader && /^sha256=([0-9a-f]{64})$/i.exec(legacyHeader)?.[1]?.toLowerCase() ?? null;
    let legacy = { present: Boolean(legacyHeader), verified: false, matchedSecretIndex: null };
    if (legacyMac) {
      const idx = SECRETS.findIndex((s) => safeEq(mac(s, raw), legacyMac));
      if (idx >= 0) {
        legacy.verified = true;
        legacy.matchedSecretIndex = idx;
      }
    }

    const schemeVerified = v1.verified ? 'v1' : legacy.verified ? 'legacy' : 'none';
    const signatureValid = schemeVerified !== 'none';

    const entry = {
      receivedAt,
      method: req.method,
      url: req.url,
      contentType: req.headers['content-type'] ?? null,
      userAgent: req.headers['user-agent'] ?? null,
      topic: req.headers['x-terrafield-topic'] ?? null,
      signatureHeader: v1Header,
      signatureTimestamp: v1.timestampSec,
      sigAgeSec: v1.sigAgeSec,
      replayRefused: v1.replayRefused,
      legacyHeader,
      schemeVerified,
      signatureValid,
      v1Verify: v1.reason ? { verified: v1.verified, reason: v1.reason, matchedSecretIndex: v1.matchedSecretIndex } : { verified: v1.verified, matchedSecretIndex: v1.matchedSecretIndex },
      legacyVerify: { verified: legacy.verified, matchedSecretIndex: legacy.matchedSecretIndex },
      parseError,
      summary:
        parsed && typeof parsed === 'object'
          ? {
              type: parsed.type ?? null,
              reason: parsed.reason ?? null,
              trigger: parsed.trigger ?? null,
              watchlistId: parsed.watchlistId ?? null,
              watchlistName: parsed.watchlistName ?? null,
              correlationId: parsed.correlationId ?? null,
              digestHours: parsed.digest?.hours ?? null,
              digestFirstLine: Array.isArray(parsed.digest?.digest) ? (parsed.digest.digest[0] ?? null) : null,
              lastStatus: parsed.digest?.current?.last?.status ?? null,
            }
          : null,
      rawBytes: raw.length,
    };
    appendFileSync(logPath, JSON.stringify(entry) + '\n');
    console.log(`[receiver] ${req.method} ${req.url} → ${signatureValid ? 204 : 401} (scheme ${schemeVerified}, sigAge ${v1.sigAgeSec ?? 'n/a'}s)`);
    res.writeHead(signatureValid ? 204 : 401, {
      'x-terrafield-receiver-ack': signatureValid ? `verified:${schemeVerified}` : 'rejected',
    }).end();
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[receiver] listening on http://127.0.0.1:${port}/digest — verifying v1 (t=,v1=, ±${TOLERANCE_SEC}s) + legacy over ${SECRETS.length} secret(s) — logging to ${logPath}`);
});

const watchdog = setInterval(() => {
  if (Date.now() - lastTraffic > idleTimeoutMs) {
    clearInterval(watchdog);
    server.close(() => process.exit(0));
  }
}, 5_000);
watchdog.unref();
