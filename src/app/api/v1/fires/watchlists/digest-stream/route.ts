import { NextResponse, type NextRequest } from 'next/server';
import { clientKey, errorResponse, rateLimit } from '@/lib/api/helpers';
import { getCorrelationId } from '@/lib/correlation';
import {
  formatSseComment,
  formatSseMessage,
  formatSseRetry,
  KEEPALIVE_MS,
  SSE_RETRY_MS,
  buildHelloPayload,
  type DigestSink,
} from '@/lib/fires/digest-push';
import { digestChannel, digestChannelStatus } from '@/lib/fires/digest-channel';
import { schedulerEnabled, schedulerStatusTickSec } from '@/lib/scheduler';

/**
 * GET /api/v1/fires/watchlists/digest-stream — the push-style digest delivery
 * channel (Server-Sent Events).
 *
 * This is the channel the topology previously lacked: a real server-push
 * stream on the ONE exposed HTTP port, same-origin, through the same gateway
 * as every /api/v1 route — no broker, no extra port, no second process.
 *
 * Wire contract (frames in order):
 *
 *   retry: 5000                  reconnect hint, once per connection
 *   event: channel.hello        subscription confirmation + channel facts
 *   : keepalive                 comment heartbeat every 25 s (idle-safe)
 *   event: watchlist.digest     pushed cadence-aware digests — recomputed the
 *                               moment an evaluation event lands (manual,
 *                               backtest or scheduled) or a scheduled run
 *                               fails, and written to EVERY open console
 *
 * Semantics, honestly stated:
 *   - No replay buffer. A reconnect starts a fresh hello and receives only
 *     events published after it; anything missed while offline is always
 *     available from GET /api/v1/fires/watchlists/{id}/digest.
 *   - DIGEST_PUSH_OFF=1 → the route opens, sends `event: channel.disabled`
 *     and closes, so clients stop reconnecting immediately.
 *   - Over the client cap (12) → 503 CHANNEL_FULL with Retry-After 5 s.
 *   - One rate-limited token per CONNECT — generous refill, because the
 *     browser's EventSource reconnects on its own.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const encoder = new TextEncoder();

export async function GET(req: NextRequest) {
  const correlationId = getCorrelationId(req.headers.get('x-correlation-id'));

  // Connection-storm guard: one token per CONNECT (events afterwards are
  // pushed by the server, never requested).
  const rl = rateLimit(clientKey(req, 'watchlists:digest-stream'), { capacity: 30, refillPerMinute: 12 });
  if (!rl.allowed) {
    const res = errorResponse(429, 'RATE_LIMITED', `too many stream connections; retry after ${rl.retryAfterSec}s`, correlationId);
    res.headers.set('Retry-After', String(rl.retryAfterSec));
    return res;
  }

  const hub = digestChannel();
  const status = digestChannelStatus();

  if (status.disabledByEnv) {
    // Disabled honestly: open the stream, say so, close. The client stops
    // reconnecting on this event instead of looping against a 503.
    const preamble =
      formatSseRetry(SSE_RETRY_MS) +
      formatSseMessage({ id: 0, event: 'channel.disabled', data: { type: 'disabled', note: 'digest push channel disabled by DIGEST_PUSH_OFF=1' } });
    return sseResponse(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(preamble));
          controller.close();
        },
      }),
      correlationId,
    );
  }

  if (hub.subscriberCount() >= status.maxClients) {
    const res = errorResponse(503, 'CHANNEL_FULL', `digest stream at capacity (${status.maxClients} open connections); retry shortly`, correlationId);
    res.headers.set('Retry-After', '5');
    return res;
  }

  const connectionId = crypto.randomUUID();
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let sinkRegistered = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Preamble: reconnect hint, then the per-connection hello. Hello uses
      // id 0; broadcast digests carry the hub's process-wide ids from 1 up,
      // so per-stream ids stay monotonically increasing on the wire.
      controller.enqueue(encoder.encode(formatSseRetry(SSE_RETRY_MS)));
      const hello = buildHelloPayload({
        connectionId,
        now: new Date(),
        subscribers: hub.subscriberCount() + 1, // this connection included
        maxClients: status.maxClients,
        schedulerEnabled: schedulerEnabled(),
        schedulerTickEverySec: schedulerStatusTickSec(),
      });
      controller.enqueue(encoder.encode(formatSseMessage({ id: 0, event: 'channel.hello', data: hello })));

      // Register this connection as a hub sink. If capacity raced past the
      // check above, say so and close instead of silently dropping events.
      const sink: DigestSink = {
        clientId: connectionId,
        send(chunk) {
          controller.enqueue(encoder.encode(chunk));
        },
      };
      const registered = hub.register(sink);
      if (!registered.ok) {
        controller.enqueue(encoder.encode(formatSseMessage({ id: 0, event: 'channel.full', data: { type: 'full', retryAfterSec: 5 } })));
        controller.close();
        return;
      }
      sinkRegistered = true;

      const cleanup = () => {
        if (keepaliveTimer) clearInterval(keepaliveTimer);
        keepaliveTimer = null;
        if (sinkRegistered) hub.unregister(connectionId);
        try {
          controller.close();
        } catch {
          // already closed — nothing to do
        }
      };

      // Comment heartbeat: keeps proxies from idling the stream out and
      // carries no data. Timer is unref'd — it never holds the process open.
      keepaliveTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(formatSseComment('keepalive')));
        } catch {
          cleanup(); // stream already dead — drop the timer and the slot
        }
      }, KEEPALIVE_MS);
      keepaliveTimer.unref?.();

      // Client went away (tab closed, navigate, network drop): free the slot.
      req.signal.addEventListener('abort', cleanup);
    },
    cancel() {
      // The consumer released the stream (browser closed the EventSource).
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      keepaliveTimer = null;
      if (sinkRegistered) hub.unregister(connectionId);
    },
  });

  return sseResponse(stream, correlationId);
}

function sseResponse(stream: ReadableStream<Uint8Array>, correlationId: string): NextResponse {
  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no', // never let a proxy buffer the stream
      'X-Correlation-Id': correlationId,
    },
  });
}
