/**
 * Push-style digest delivery — the pure channel engine.
 *
 * Topology note (mirrors lib/schedule-core.ts): the runtime is ONE Node
 * process behind ONE exposed HTTP port — no broker, no worker tier, no extra
 * ports for stateful services. A real push channel in THIS topology is a
 * Server-Sent Events stream: the server holds an HTTP response open on the
 * existing /api/v1 port and writes each digest onto it the moment a new
 * digest-relevant fact lands (an evaluation event — manual, backtest or
 * scheduled — or a failed scheduled run). The browser's EventSource
 * receives it without asking; the connection is same-origin and goes
 * through the same gateway as every other API route.
 *
 * This module is PURE (no imports, no I/O — unit-tested directly):
 *  - SSE wire formatting (message frames, keepalive comments, retry hint);
 *  - the hub factory (registry of open sinks: delivery, eviction, caps,
 *    counters) — production sinks wrap the route's stream controller;
 *  - payload builders for the pushed digest and the channel hello.
 *
 * The process-wide singleton + publish entry point live in
 * `lib/fires/digest-channel.ts` (they need the digest service/Prisma);
 * the SSE route itself is `app/api/v1/fires/watchlists/digest-stream`.
 */

// ---------------------------------------------------------------------------
// Pure: SSE wire formatting
// ---------------------------------------------------------------------------

export const SSE_RETRY_MS = 5_000;
export const KEEPALIVE_MS = 25_000;
export const MAX_STREAM_CLIENTS = 12;

/** One SSE message as wire text. `data` is JSON — always a single line. */
export function formatSseMessage(opts: { id: number; event: string; data: unknown }): string {
  const json = JSON.stringify(opts.data);
  if (json === undefined) throw new Error('SSE payload is not JSON-serializable');
  if (json.includes('\n')) throw new Error('SSE data must be a single line — check payload encoding');
  return `id: ${opts.id}\nevent: ${opts.event}\ndata: ${json}\n\n`;
}

/** SSE comment frame (keepalive) — ignored by every EventSource, keeps proxies from idling out the stream. */
export function formatSseComment(text: string): string {
  if (text.includes('\n')) throw new Error('SSE comment must be a single line');
  return `: ${text}\n\n`;
}

/** SSE reconnect hint — the browser's EventSource waits this long before retrying. */
export function formatSseRetry(ms: number): string {
  return `retry: ${ms}\n\n`;
}

// ---------------------------------------------------------------------------
// Pure: payload builders
// ---------------------------------------------------------------------------

export type DigestPushReason = 'evaluation' | 'scheduled-failure';

/** What pushed a digest: an evaluation event (any trigger) or a failed scheduled run. */
export interface DigestPushPayload {
  type: 'digest';
  /** Stable triggering identity used by every receiver for deduplication. */
  eventId: string;
  reason: DigestPushReason;
  /** Trigger of the evaluation that landed — null when reason is a scheduled failure. */
  trigger: 'manual' | 'backtest' | 'scheduled' | null;
  /** Correlation ID shared with the evaluation's event/audit rows. */
  correlationId: string | null;
  /** When the triggering fact landed (ISO). */
  triggeredAt: string;
  /** When the channel recomputed + published the digest (ISO). */
  pushedAt: string;
  watchlistId: string;
  watchlistName: string;
  watchlist: unknown; // serializeWatchlist output
  digest: unknown; // full buildDigest output — same shape as GET .../digest
}

export function buildDigestPushPayload(input: {
  eventId: string;
  reason: DigestPushReason;
  trigger: 'manual' | 'backtest' | 'scheduled' | null;
  correlationId: string | null;
  triggeredAt: Date;
  now: Date;
  watchlistId: string;
  watchlistName: string;
  watchlist: unknown;
  digest: unknown;
}): DigestPushPayload {
  return {
    type: 'digest',
    eventId: input.eventId,
    reason: input.reason,
    trigger: input.reason === 'evaluation' ? input.trigger : null,
    correlationId: input.correlationId,
    triggeredAt: input.triggeredAt.toISOString(),
    pushedAt: input.now.toISOString(),
    watchlistId: input.watchlistId,
    watchlistName: input.watchlistName,
    watchlist: input.watchlist,
    digest: input.digest,
  };
}

/** Subscription confirmation sent to each new connection before any digest. */
export interface DigestHelloPayload {
  type: 'hello';
  connectionId: string;
  connectedAt: string;
  subscribers: number;
  maxClients: number;
  schedulerEnabled: boolean;
  schedulerTickEverySec: number | null;
  note: string;
}

export function buildHelloPayload(input: {
  connectionId: string;
  now: Date;
  subscribers: number;
  maxClients: number;
  schedulerEnabled: boolean;
  schedulerTickEverySec: number | null;
}): DigestHelloPayload {
  return {
    type: 'hello',
    connectionId: input.connectionId,
    connectedAt: input.now.toISOString(),
    subscribers: input.subscribers,
    maxClients: input.maxClients,
    schedulerEnabled: input.schedulerEnabled,
    schedulerTickEverySec: input.schedulerTickEverySec,
    note: 'Digest push channel live. A cadence-aware digest is pushed for every evaluation (manual, backtest or scheduled) and every failed scheduled run. Reconnects start a fresh hello; anything missed while offline is always available from GET /api/v1/fires/watchlists/{id}/digest.',
  };
}

// ---------------------------------------------------------------------------
// Pure: hub factory (registry of open sinks; no real streams involved here)
// ---------------------------------------------------------------------------

/** A connected client's write side. `send` MUST throw once the stream is dead — that is the eviction signal. */
export interface DigestSink {
  clientId: string;
  ownerId?: string;
  authorizePrivate?: () => Promise<boolean>;
  close?: () => void;
  send(chunk: string): void;
}

export interface DigestHubStatus {
  subscribers: number;
  connectionsOpened: number;
  eventsDelivered: number;
  lastEventAt: string | null;
}

export interface DigestHub {
  register(sink: DigestSink): { ok: true; clientId: string } | { ok: false; code: 'CHANNEL_FULL'; retryAfterSec: number };
  unregister(clientId: string): void;
  /** Publish one SSE event to every live sink; dead sinks are evicted, never rethrown. */
  publish(event: string, data: unknown): { eventId: number; message: string; delivered: number; evicted: number };
  publishPrivate(event: string, data: unknown, ownerId: string): Promise<{ delivered: number }>;
  subscriberCount(): number;
  status(): DigestHubStatus;
  close?(): Promise<void>;
}

export function createDigestHub(maxClients = MAX_STREAM_CLIENTS): DigestHub {
  const sinks = new Map<string, DigestSink>();
  let connectionsOpened = 0;
  let eventsDelivered = 0;
  let eventIdSeq = 0;
  let lastEventAt: Date | null = null;

  return {
    register(sink) {
      if (sinks.size >= maxClients) {
        return { ok: false, code: 'CHANNEL_FULL', retryAfterSec: 5 };
      }
      sinks.set(sink.clientId, sink);
      connectionsOpened += 1;
      return { ok: true, clientId: sink.clientId };
    },
    unregister(clientId) {
      sinks.delete(clientId);
    },
    async publishPrivate(event, data, ownerId) {
      const id = ++eventIdSeq;
      const message = formatSseMessage({ id, event, data });
      let delivered = 0;
      for (const sink of [...sinks.values()]) {
        if (!ownerId || sink.ownerId !== ownerId) continue;
        try {
          if (!sink.authorizePrivate || !await sink.authorizePrivate()) throw new Error('private session invalid');
          if (sinks.get(sink.clientId) !== sink) continue;
          sink.send(message);
          delivered += 1;
        } catch {
          sinks.delete(sink.clientId);
          try { sink.close?.(); } catch { /* already closed */ }
        }
      }
      if (delivered) {
        eventsDelivered += delivered;
        lastEventAt = new Date();
      }
      return { delivered };
    },
    publish(event, data) {
      eventIdSeq += 1;
      const message = formatSseMessage({ id: eventIdSeq, event, data });
      const dead: string[] = [];
      let delivered = 0;
      for (const sink of sinks.values()) {
        try {
          sink.send(message);
          delivered += 1;
        } catch {
          dead.push(sink.clientId); // stream closed/errored — evict, keep publishing
        }
      }
      for (const id of dead) sinks.delete(id);
      if (delivered > 0 || dead.length > 0) {
        eventsDelivered += delivered;
        lastEventAt = new Date();
      }
      return { eventId: eventIdSeq, message, delivered, evicted: dead.length };
    },
    subscriberCount() {
      return sinks.size;
    },
    status() {
      return {
        subscribers: sinks.size,
        connectionsOpened,
        eventsDelivered,
        lastEventAt: lastEventAt ? lastEventAt.toISOString() : null,
      };
    },
  };
}
