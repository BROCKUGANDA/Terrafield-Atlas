import { describe, test, expect } from 'bun:test';
import {
  formatSseMessage,
  formatSseComment,
  formatSseRetry,
  buildDigestPushPayload,
  buildHelloPayload,
  createDigestHub,
  KEEPALIVE_MS,
  MAX_STREAM_CLIENTS,
  SSE_RETRY_MS,
  type DigestSink,
} from '@/lib/fires/digest-push';

/**
 * Push-style digest delivery — pure channel-engine unit tests.
 * No DB, no network, no real streams: sinks are recording fakes, so the
 * exact wire bytes, delivery/eviction/cap semantics and payload shapes the
 * SSE route and the publishers compose with are exercised directly.
 */

/** Fake sink: records frames, throws once told to (simulates a dead stream). */
function fakeSink(id: string, opts: { dead?: boolean } = {}): DigestSink & { frames: string[]; kill: () => void } {
  const frames: string[] = [];
  let dead = opts.dead ?? false;
  return {
    clientId: id,
    frames,
    kill: () => {
      dead = true;
    },
    send(chunk: string) {
      if (dead) throw new Error('stream closed');
      frames.push(chunk);
    },
  };
}

describe('SSE wire formatting', () => {
  test('a message frame is id/event/data lines terminated by a blank line', () => {
    const frame = formatSseMessage({ id: 7, event: 'watchlist.digest', data: { hello: 'world' } });
    expect(frame).toBe('id: 7\nevent: watchlist.digest\ndata: {"hello":"world"}\n\n');
  });

  test('newlines inside payload strings stay escaped — the data line is single-line', () => {
    const frame = formatSseMessage({ id: 1, event: 'watchlist.digest', data: { prose: 'line one\nline two' } });
    const lines = frame.split('\n');
    // id, event, data, trailing empty, trailing empty
    expect(lines).toHaveLength(5);
    expect(lines[2]).toBe('data: {"prose":"line one\\nline two"}');
    expect(lines[2].includes('\n')).toBe(false); // no RAW newline inside the data line
  });

  test('non-JSON-serializable data is rejected, never silently mangled', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => formatSseMessage({ id: 1, event: 'e', data: circular })).toThrow();
  });

  test('comment and retry frames follow the SSE comment/retry syntax', () => {
    expect(formatSseComment('keepalive')).toBe(': keepalive\n\n');
    expect(() => formatSseComment('a\nb')).toThrow(); // multi-line comments would corrupt the frame
    expect(formatSseRetry(5000)).toBe('retry: 5000\n\n');
    expect(SSE_RETRY_MS).toBe(5000);
    expect(KEEPALIVE_MS).toBe(25_000);
    expect(MAX_STREAM_CLIENTS).toBe(12);
  });
});

describe('push payload builders', () => {
  const digest = { hours: 6, digest: ['line 1', 'line 2'], current: { evaluations: 1, last: { status: 'alert' } } };
  const watchlist = { id: 'wl-1', name: 'Nakuru — dry-season fire watch', lastStatus: 'alert' };

  test('evaluation pushes carry the triggering evaluation’s trigger', () => {
    const p = buildDigestPushPayload({
      reason: 'evaluation',
      trigger: 'scheduled',
      correlationId: 'sched-abc-12345678',
      triggeredAt: new Date('2026-11-14T08:05:00Z'),
      now: new Date('2026-11-14T08:05:00.400Z'),
      watchlistId: 'wl-1',
      watchlistName: 'Nakuru — dry-season fire watch',
      watchlist,
      digest,
    });
    expect(p.type).toBe('digest');
    expect(p.reason).toBe('evaluation');
    expect(p.trigger).toBe('scheduled');
    expect(p.correlationId).toBe('sched-abc-12345678');
    expect(p.triggeredAt).toBe('2026-11-14T08:05:00.000Z');
    expect(p.pushedAt).toBe('2026-11-14T08:05:00.400Z');
    expect(p.watchlistId).toBe('wl-1');
    expect(p.watchlistName).toBe('Nakuru — dry-season fire watch');
    expect(p.digest).toBe(digest);
  });

  test('scheduled-failure pushes never claim an evaluation trigger', () => {
    const p = buildDigestPushPayload({
      reason: 'scheduled-failure',
      trigger: 'scheduled', // even if a caller passes one, failures write no evaluation
      correlationId: null,
      triggeredAt: new Date('2026-11-14T09:05:00Z'),
      now: new Date('2026-11-14T09:05:00.250Z'),
      watchlistId: 'wl-1',
      watchlistName: 'Nakuru — dry-season fire watch',
      watchlist,
      digest,
    });
    expect(p.reason).toBe('scheduled-failure');
    expect(p.trigger).toBeNull(); // forced null for failures
    expect(p.correlationId).toBeNull();
  });

  test('hello payload reports channel + scheduler facts the route sends', () => {
    const h = buildHelloPayload({
      connectionId: 'conn-1',
      now: new Date('2026-11-14T08:00:00Z'),
      subscribers: 1,
      maxClients: 12,
      schedulerEnabled: true,
      schedulerTickEverySec: 60,
    });
    expect(h.type).toBe('hello');
    expect(h.connectionId).toBe('conn-1');
    expect(h.connectedAt).toBe('2026-11-14T08:00:00.000Z');
    expect(h.subscribers).toBe(1);
    expect(h.maxClients).toBe(12);
    expect(h.schedulerEnabled).toBe(true);
    expect(h.schedulerTickEverySec).toBe(60);
    expect(typeof h.note).toBe('string');
    expect(h.note.length).toBeGreaterThan(0);
  });
});

describe('digest hub: delivery, eviction, caps, counters', () => {
  test('publish reaches every registered sink with increasing event ids', () => {
    const hub = createDigestHub();
    const a = fakeSink('a');
    const b = fakeSink('b');
    expect(hub.register(a).ok).toBe(true);
    expect(hub.register(b).ok).toBe(true);

    const r1 = hub.publish('watchlist.digest', { n: 1 });
    const r2 = hub.publish('watchlist.digest', { n: 2 });
    expect(r1.delivered).toBe(2);
    expect(r2.delivered).toBe(2);
    expect(r1.evicted).toBe(0);
    expect(r1.message).toBe('id: 1\nevent: watchlist.digest\ndata: {"n":1}\n\n');
    expect(r2.message.startsWith('id: 2\n')).toBe(true);
    expect(a.frames).toHaveLength(2);
    expect(b.frames).toHaveLength(2);
  });

  test('a dead sink is evicted on publish and delivery to the rest continues', () => {
    const hub = createDigestHub();
    const alive = fakeSink('alive');
    const dead = fakeSink('dead');
    hub.register(alive);
    hub.register(dead);
    dead.kill();

    const r = hub.publish('watchlist.digest', { n: 1 });
    expect(r.delivered).toBe(1);
    expect(r.evicted).toBe(1);
    expect(alive.frames).toHaveLength(1);

    const r2 = hub.publish('watchlist.digest', { n: 2 });
    expect(r2.delivered).toBe(1);
    expect(r2.evicted).toBe(0); // already evicted — not retried, not re-thrown
    expect(hub.subscriberCount()).toBe(1);
  });

  test('unregister stops delivery without touching other sinks', () => {
    const hub = createDigestHub();
    const a = fakeSink('a');
    const b = fakeSink('b');
    hub.register(a);
    hub.register(b);
    hub.unregister('a');
    const r = hub.publish('watchlist.digest', { n: 1 });
    expect(r.delivered).toBe(1);
    expect(a.frames).toHaveLength(0);
    expect(b.frames).toHaveLength(1);
  });

  test('the client cap is enforced with a retry hint, and slots free up', () => {
    const hub = createDigestHub(2);
    const a = fakeSink('a');
    const b = fakeSink('b');
    const c = fakeSink('c');
    expect(hub.register(a).ok).toBe(true);
    expect(hub.register(b).ok).toBe(true);
    const rejected = hub.register(c);
    if (rejected.ok) throw new Error('third connection must be rejected');
    expect(rejected.code).toBe('CHANNEL_FULL');
    expect(rejected.retryAfterSec).toBeGreaterThan(0);
    expect(c.frames).toHaveLength(0);

    hub.unregister('a');
    expect(hub.register(c).ok).toBe(true); // freed slot is usable again
  });

  test('status counters track connections, delivered events and last event time', () => {
    const hub = createDigestHub();
    const before = hub.status();
    expect(before.subscribers).toBe(0);
    expect(before.connectionsOpened).toBe(0);
    expect(before.eventsDelivered).toBe(0);
    expect(before.lastEventAt).toBeNull();

    // publishing with no subscribers must not count as an event
    const empty = hub.publish('watchlist.digest', { n: 0 });
    expect(empty.delivered).toBe(0);
    expect(hub.status().eventsDelivered).toBe(0);
    expect(hub.status().lastEventAt).toBeNull();

    const a = fakeSink('a');
    hub.register(a);
    hub.publish('watchlist.digest', { n: 1 });
    hub.publish('watchlist.digest', { n: 2 });
    const st = hub.status();
    expect(st.subscribers).toBe(1);
    expect(st.connectionsOpened).toBe(1);
    expect(st.eventsDelivered).toBe(2);
    expect(st.lastEventAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(st.lastEventAt!))).toBe(false);
  });
});
