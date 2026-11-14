/**
 * Real local HTTP receiver for the digest webhook exit's e2e check.
 *
 * Listens on 127.0.0.1:<port>, accepts POST /digest, records every request
 * (receivedAt, headers, raw body, parsed summary, HMAC verification result)
 * to a JSONL log file, and answers 204. GET /health answers 200 so the
 * harness can wait for readiness. Kills itself after --idle-timeout-ms of
 * total silence (default 5 min) so no receiver is left running.
 *
 * Usage: node scripts/webhook-receiver.mjs <port> <logPath> [idleTimeoutMs]
 */
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';

const port = Number(process.argv[2] ?? 4317);
const logPath = process.argv[3] ?? '/tmp/webhook-receiver.jsonl';
const idleTimeoutMs = Number(process.argv[4] ?? 300_000);

// Secret must match DIGEST_WEBHOOK_SECRET used by the app for HMAC verification.
const SECRET = process.env.RECEIVER_SECRET ?? 'e2e-demo-secret';
writeFileSync(logPath, '');

let lastTraffic = Date.now();
const server = createServer((req, res) => {
  lastTraffic = Date.now();
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const receivedAt = new Date().toISOString();
    let parsed = null;
    let parseError = null;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }
    const receivedSig = req.headers['x-terrafield-signature'] ?? null;
    const expectedMac = createHmac('sha256', SECRET).update(raw, 'utf8').digest('hex');
    const signatureValid =
      typeof receivedSig === 'string' && receivedSig === `sha256=${expectedMac}`;

    const entry = {
      receivedAt,
      method: req.method,
      url: req.url,
      contentType: req.headers['content-type'] ?? null,
      userAgent: req.headers['user-agent'] ?? null,
      signatureHeader: receivedSig,
      signatureValid,
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
    console.log(`[receiver] ${req.method} ${req.url} → 204 (sig ${signatureValid ? 'VALID' : typeof receivedSig === 'string' ? 'INVALID' : 'absent'})`);
    res.writeHead(204).end();
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[receiver] listening on http://127.0.0.1:${port}/digest — logging to ${logPath}`);
});

const watchdog = setInterval(() => {
  if (Date.now() - lastTraffic > idleTimeoutMs) {
    clearInterval(watchdog);
    server.close(() => process.exit(0));
  }
}, 5_000);
watchdog.unref();
