'use client';

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { DIGEST_STREAM_PATH, type DigestHelloPayload, type DigestPushPayload } from '@/lib/api-client';
import { usePushChannel } from '@/components/state/push-store';
import { logEvent } from '@/components/state/log-store';
import { useToast } from '@/hooks/use-toast';

/**
 * Push-style digest delivery, client half — ONE EventSource subscription
 * mounted console-wide (app shell), exactly like the header alert chip.
 *
 * `watchlist.digest` events carry the ENTIRE cadence-aware digest (the same
 * object GET /digest would return). On arrival the hook:
 *
 *  1. writes it straight into the TanStack Query cache under the popover's
 *     default key (`['watchlist-digest', id, 'cadence']`) — an open Digest
 *     popover repaints without any request;
 *  2. invalidates the watchlist rows + the per-list runs ledger, so the
 *     cards, the console-wide header alert chip and an open Runs panel
 *     refresh within the push latency instead of waiting on their polls;
 *  3. toasts + mission-logs SCHEDULER activity only (trigger='scheduled' or
 *     a failed scheduled run) — manual/backtest pushes are silent, because
 *     the operator who fired them already got their own mutation feedback.
 *
 * Payloads are validated defensively on arrival; anything malformed is
 * ignored and logged, never rendered.
 */

const PUSHED_NOTE =
  'Delivered live over the push channel (GET /api/v1/fires/watchlists/digest-stream) the moment the triggering evaluation or scheduled failure landed — same digest the endpoint computes, nothing interpolated.';

/** Runtime guard: every field the hook and the popover actually consume. */
function isValidDigestPushPayload(x: unknown): x is DigestPushPayload {
  if (x === null || typeof x !== 'object') return false;
  const p = x as Record<string, unknown>;
  if (p.type !== 'digest') return false;
  if (typeof p.eventId !== 'string' || p.eventId.length === 0) return false;
  if (p.reason !== 'evaluation' && p.reason !== 'scheduled-failure') return false;
  if (typeof p.watchlistId !== 'string' || p.watchlistId.length === 0) return false;
  if (typeof p.pushedAt !== 'string' || typeof p.triggeredAt !== 'string') return false;
  const w = p.watchlist as Record<string, unknown> | undefined;
  if (w === null || typeof w !== 'object' || typeof w.id !== 'string' || typeof w.lastStatus !== 'string') return false;
  const d = p.digest as Record<string, unknown> | undefined;
  if (d === null || typeof d !== 'object') return false;
  if (typeof d.hours !== 'number') return false;
  if (!Array.isArray(d.digest) || d.digest.some((l) => typeof l !== 'string')) return false;
  const current = d.current as Record<string, unknown> | undefined;
  if (current === null || typeof current !== 'object' || typeof current.evaluations !== 'number') return false;
  const last = current.last as Record<string, unknown> | null | undefined;
  if (last !== null && last !== undefined && typeof last !== 'object') return false;
  if (last !== null && last !== undefined && typeof (last as Record<string, unknown>).status !== 'string') return false;
  const failures = d.failures as unknown[] | undefined;
  if (failures !== undefined && !Array.isArray(failures)) return false;
  return true;
}

function parseEvent<T>(raw: MessageEvent<string>): T | null {
  try {
    return JSON.parse(raw.data) as T;
  } catch {
    return null;
  }
}

export function useDigestStream(): void {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const fatalLogged = useRef(false);
  const seenEvents = useRef(new Set<string>());
  const newestPushAt = useRef(new Map<string, number>());

  useEffect(() => {
    const es = new EventSource(DIGEST_STREAM_PATH);
    const push = usePushChannel.getState; // stable actions — no shell re-render on events

    const onDigest = async (raw: MessageEvent<string>) => {
      const payload = parseEvent<unknown>(raw);
      if (!isValidDigestPushPayload(payload)) {
        console.warn('[digest-stream] malformed push payload ignored');
        logEvent({
          severity: 'warn',
          category: 'FIRE',
          title: 'Malformed digest push ignored',
          detail: 'The push channel delivered a payload that failed validation; it was dropped — no fabricated digest was rendered.',
        });
        return;
      }
      if (seenEvents.current.has(payload.eventId)) return;
      const pushedAtMs = Date.parse(payload.pushedAt);
      if (pushedAtMs < (newestPushAt.current.get(payload.watchlistId) ?? 0)) return;
      seenEvents.current.add(payload.eventId);
      newestPushAt.current.set(payload.watchlistId, pushedAtMs);
      if (seenEvents.current.size > 500) {
        const keep = [...seenEvents.current].slice(-250);
        seenEvents.current = new Set(keep);
      }

      // Cancel an older in-flight GET before applying pushed data. Otherwise
      // that GET can resolve later and replace a newer server fact.
      await queryClient.cancelQueries({ queryKey: ['watchlist-digest', payload.watchlistId] });

      // 1. Straight into the popover's default cache slot — zero requests.
      queryClient.setQueryData(['watchlist-digest', payload.watchlistId, 'cadence'], {
        ...payload.digest,
        watchlist: payload.watchlist,
        note: PUSHED_NOTE,
      });
      // 2. Bounded invalidation: cards, header alert chip, open Runs panel.
      void queryClient.invalidateQueries({ queryKey: ['fire-watchlists'] });
      void queryClient.invalidateQueries({ queryKey: ['watchlist-runs', payload.watchlistId] });
      // Delivery facts for the UI (channel chip + per-card "last pushed").
      push().onDigest(payload);

      // 3. Scheduler activity only: an operator never asked for this digest —
      //    push delivery is the notification.
      const isSchedulerActivity = payload.reason === 'scheduled-failure' || payload.trigger === 'scheduled';
      if (!isSchedulerActivity) return;

      const status = payload.digest.current.last?.status ?? null;
      const failureCount = payload.digest.failures?.length ?? 0;
      const firstLine = payload.digest.digest[0] ?? 'digest pushed';
      const severity =
        payload.reason === 'scheduled-failure' || status === 'watch'
          ? 'warn'
          : status === 'alert'
            ? 'crit'
            : 'info';
      toast({
        title: `Digest pushed — ${payload.watchlistName}${status ? `: ${status.toUpperCase()}` : ''}`,
        description: `${firstLine}${failureCount > 0 ? ` · ${failureCount} failed scheduled run(s) reported.` : ''}`,
        variant: status === 'alert' ? 'destructive' : undefined,
      });
      logEvent({
        severity,
        category: 'FIRE',
        title: `Digest pushed over the channel — ${payload.watchlistName}${status ? `: ${status.toUpperCase()}` : ' (no evaluation in window)'}`,
        detail:
          payload.reason === 'scheduled-failure'
            ? `A scheduled run FAILED — no status was written; the digest reports the failure from the audit ledger. ${firstLine}`
            : `${payload.digest.digest.slice(0, 2).join(' ')}${failureCount > 0 ? ` ${failureCount} failed scheduled run(s) reported.` : ''}`,
        correlationId: payload.correlationId ?? undefined,
        view: 'fire',
      });
    };

    es.addEventListener('channel.hello', (raw) => {
      const hello = parseEvent<DigestHelloPayload>(raw as MessageEvent<string>);
      if (hello && hello.type === 'hello' && typeof hello.connectionId === 'string') {
        push().onOpen(hello);
      }
    });
    es.addEventListener('channel.disabled', () => {
      push().onDisabled();
      es.close(); // the channel is off by configuration — stop reconnecting
    });
    es.addEventListener('channel.full', () => {
      push().onReconnecting(); // capacity — the browser retries the connection
    });
    es.addEventListener('watchlist.digest', (raw) => { onDigest(raw as MessageEvent<string>); });
    es.onerror = () => {
      push().onReconnecting();
      if (es.readyState === EventSource.CLOSED && !fatalLogged.current) {
        fatalLogged.current = true;
        logEvent({
          severity: 'warn',
          category: 'FIRE',
          title: 'Digest push stream closed',
          detail: 'The browser gave up reconnecting the digest stream. Watchlist data continues via the regular 120 s poll and on-demand digests — push delivery will resume on the next full console reload.',
          view: 'fire',
        });
      }
    };

    return () => {
      es.close();
    };
  }, [queryClient, toast]);
}
