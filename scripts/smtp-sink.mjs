/**
 * Real local SMTP sink — LIVE verification harness for the digest email exit.
 *
 * Implements the SMTP dialogue nodemailer speaks (RFC 5321 subset): 220
 * greeting, EHLO/HELO with capability lines, MAIL FROM / RCPT TO, DATA with
 * dot-stuffing and CRLF.CRLF termination, RSET/NOOP/VRFY, QUIT. NO TLS is
 * advertised (plain-text on the loopback sink — nodemailer with secure:false
 * opportunistically upgrades only when the server offers STARTTLS), and no
 * AUTH is required (the app sends credentials only when DIGEST_SMTP_USER is
 * set; the sink deployment leaves it unset).
 *
 * Every accepted message is recorded to a JSONL log with the SMTP envelope,
 * the parsed headers (message-id, from, to, subject, date) and a body
 * preview — durable, inspectable proof that a REAL SMTP conversation
 * delivered the digest email.
 *
 * Usage: node scripts/smtp-sink.mjs <port> <logPath> [idleTimeoutMs]
 */
import { createServer } from 'node:net';
import { appendFileSync, writeFileSync } from 'node:fs';

const port = Number(process.argv[2] ?? 2525);
const logPath = process.argv[3] ?? '/tmp/smtp-sink.jsonl';
const idleTimeoutMs = Number(process.argv[4] ?? 300_000);

writeFileSync(logPath, '');

const HOSTNAME = 'terrafield-smtp-sink';

/** Unfold + decode a header value enough for logging (RFC 2047 base64/Q). */
function decodeHeader(v) {
  if (!v) return v;
  let out = v.replace(/\r?\n[ \t]+/g, ' '); // unfold folds
  out = out.replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_, b) => {
    try { return Buffer.from(b, 'base64').toString('utf8'); } catch { return _; }
  });
  out = out.replace(/=\?UTF-8\?Q\?([^?]*)\?=/gi, (_, q) => {
    try { return q.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))); } catch { return _; }
  });
  return out;
}

/** Parse DATA payload: headers block, then body. */
function parseMessage(data) {
  const sep = data.indexOf('\r\n\r\n');
  const sep2 = sep === -1 ? data.indexOf('\n\n') : sep;
  const headEnd = sep2 === -1 ? data.length : sep2;
  const headRaw = data.slice(0, headEnd);
  const body = sep2 === -1 ? '' : data.slice(headEnd + (sep === -1 ? 2 : 4));
  const headers = {};
  for (const line of headRaw.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
    if (m) headers[m[1].toLowerCase()] = decodeHeader(m[2]);
  }
  return {
    messageId: headers['message-id'] ?? null,
    from: headers['from'] ?? null,
    to: headers['to'] ?? null,
    subject: headers['subject'] ?? null,
    date: headers['date'] ?? null,
    bodyPreview: body.slice(0, 400),
    bodyBytes: body.length,
  };
}

/** Extract the address from "FROM:<a@b>" / "TO:<a@b>" (angle brackets optional). */
function addrOf(arg) {
  const m = /<([^>]*)>/.exec(arg ?? '');
  return m ? m[1] : (arg ?? '').trim();
}

let lastTraffic = Date.now();
const server = createServer((socket) => {
  lastTraffic = Date.now();
  const state = { helo: null, from: null, to: [], inData: false, dataBuf: '' };
  let buf = '';

  const write = (s) => socket.write(s);
  write(`220 ${HOSTNAME} ESMTP ready (verification sink; no TLS, no AUTH)\r\n`);

  const finishMessage = () => {
    // Undo SMTP dot-stuffing (leading ".." → ".")
    const payload = state.dataBuf.replace(/(^|\r\n)\.\./g, '$1.');
    const parsed = parseMessage(payload);
    const entry = {
      receivedAt: new Date().toISOString(),
      smtp: {
        helo: state.helo,
        from: state.from,
        to: state.to,
        dataBytes: Buffer.byteLength(payload, 'utf8'),
        tls: false,
        auth: 'none-required',
      },
      headers: {
        messageId: parsed.messageId,
        from: parsed.from,
        to: parsed.to,
        subject: parsed.subject,
        date: parsed.date,
      },
      bodyPreview: parsed.bodyPreview,
      bodyBytes: parsed.bodyBytes,
    };
    appendFileSync(logPath, JSON.stringify(entry) + '\n');
    console.log(`[smtp-sink] message accepted: from=${state.from} to=${state.to.join(',')} subject="${parsed.subject}" (${entry.smtp.dataBytes}B)`);
    state.from = null;
    state.to = [];
    state.inData = false;
    state.dataBuf = '';
    write('250 2.0.0 OK: queued as delivery-proof\r\n');
  };

  socket.on('data', (chunk) => {
    lastTraffic = Date.now();
    buf += chunk.toString('utf8');
    if (state.inData) {
      // DATA mode: scan for the CRLF.CRLF terminator across chunk boundaries.
      const termIdx = buf.indexOf('\r\n.\r\n');
      if (termIdx !== -1) {
        state.dataBuf += buf.slice(0, termIdx + 2); // include trailing CRLF
        buf = buf.slice(termIdx + 5); // keep what follows the terminator
        finishMessage();
        // fall through: anything buffered is new commands (pipelining)
        drainCommands();
      }
      return;
    }
    drainCommands();
  });

  const drainCommands = () => {
    let idx;
    while ((idx = buf.indexOf('\r\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (!line) continue;
      handleCommand(line);
      if (socket.destroyed) return;
    }
  };

  const handleCommand = (line) => {
    const verb = (line.split(/[\s:]/, 1)[0] ?? '').toUpperCase();
    const arg = line.slice(verb.length).trim();
    switch (verb) {
      case 'EHLO': {
        state.helo = arg.split(/\s+/)[1] ?? arg;
        write(`250-${HOSTNAME} at your service\r\n250-PIPELINING\r\n250-8BITMIME\r\n250-SIZE 10485760\r\n250-SMTPUTF8\r\n250 OK\r\n`);
        break;
      }
      case 'HELO':
        state.helo = arg.split(/\s+/)[1] ?? arg;
        write(`250 ${HOSTNAME}\r\n`);
        break;
      case 'MAIL':
        if (state.inData) { write('503 nested MAIL\r\n'); break; }
        state.from = addrOf(arg.replace(/^FROM:?/i, ''));
        write('250 2.1.0 OK\r\n');
        break;
      case 'RCPT': {
        if (state.from === null) { write('503 need MAIL first\r\n'); break; }
        state.to.push(addrOf(arg.replace(/^TO:?/i, '')));
        write('250 2.1.5 OK\r\n');
        break;
      }
      case 'DATA': {
        if (state.from === null || state.to.length === 0) { write('503 need MAIL and RCPT first\r\n'); break; }
        state.inData = true;
        state.dataBuf = '';
        write('354 End data with <CR><LF>.<CR><LF>\r\n');
        break;
      }
      case 'RSET':
        state.from = null;
        state.to = [];
        state.inData = false;
        state.dataBuf = '';
        write('250 2.0.0 OK\r\n');
        break;
      case 'NOOP':
        write('250 2.0.0 OK\r\n');
        break;
      case 'VRFY':
        write('252 2.5.2 cannot VRFY, send mail anyway\r\n');
        break;
      case 'STARTTLS':
        write('454 TLS not available on this verification sink\r\n');
        break;
      case 'AUTH':
        write('504 auth not required by this sink\r\n');
        break;
      case 'QUIT':
        write(`221 2.0.0 ${HOSTNAME} closing connection\r\n`);
        socket.end();
        break;
      default:
        write('500 5.5.2 unrecognized command\r\n');
    }
  };

  socket.on('error', () => { /* client hangs up mid-dialogue — sink stays up */ });
  socket.on('close', () => { /* conversation over */ });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[smtp-sink] listening on smtp://127.0.0.1:${port} — logging accepted messages to ${logPath}`);
});

const watchdog = setInterval(() => {
  if (Date.now() - lastTraffic > idleTimeoutMs) {
    clearInterval(watchdog);
    server.close(() => process.exit(0));
  }
}, 5_000);
watchdog.unref();
