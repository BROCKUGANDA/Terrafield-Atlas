'use client';

import { create } from 'zustand';
import type { DigestHelloPayload, DigestPushPayload } from '@/lib/api-client';

/**
 * Digest push-channel state — console-wide, written ONLY by the
 * `useDigestStream` hook (the EventSource subscription mounted in the app
 * shell) and read by the Fire Intelligence view and System Health.
 *
 * This store carries connection state and the last pushed digest per
 * watchlist so the UI can PROVE delivery is push-style: the channel chip in
 * the watchlists header shows live/reconnecting/disabled, and every digest
 * popover shows when its list's digest last arrived over the stream.
 *
 * The digest DATA itself is written straight into the TanStack Query cache
 * (key `['watchlist-digest', id, 'cadence']`) by the hook — this store only
 * mirrors the small per-list delivery facts.
 */

export type PushChannelState = 'connecting' | 'open' | 'reconnecting' | 'disabled';

/** Delivery facts for one watchlist's last pushed digest. */
export interface LastPushDigest {
  /** When the channel published it (ISO). */
  pushedAt: string;
  reason: DigestPushPayload['reason'];
  trigger: DigestPushPayload['trigger'];
  /** Last status inside the pushed digest — null when the window had no evaluations. */
  status: string | null;
  /** Watchlist status the push observed (the wire watchlist row). */
  watchlistStatus: string;
}

interface PushState {
  channelState: PushChannelState;
  hello: DigestHelloPayload | null;
  /** `watchlist.digest` events received since this console opened. */
  eventsReceived: number;
  /** When the most recent digest arrived (ISO) — null before the first. */
  lastEventAt: string | null;
  /** Delivery facts per watchlist id. */
  lastDigests: Record<string, LastPushDigest>;
  /** Connection flap counter — surfaces an unstable channel honestly. */
  reconnects: number;

  onOpen: (hello: DigestHelloPayload) => void;
  onDigest: (payload: DigestPushPayload) => void;
  onReconnecting: () => void;
  onDisabled: () => void;
}

const MAX_TRACKED_LISTS = 40;

export const usePushChannel = create<PushState>()((set) => ({
  channelState: 'connecting',
  hello: null,
  eventsReceived: 0,
  lastEventAt: null,
  lastDigests: {},
  reconnects: 0,

  onOpen: (hello) =>
    set((s) => ({
      channelState: 'open',
      hello,
      reconnects: s.channelState === 'reconnecting' ? s.reconnects + 1 : s.reconnects,
    })),
  onDigest: (payload) =>
    set((s) => {
      const lastDigests = { ...s.lastDigests };
      lastDigests[payload.watchlistId] = {
        pushedAt: payload.pushedAt,
        reason: payload.reason,
        trigger: payload.trigger,
        status: payload.digest.current.last?.status ?? null,
        watchlistStatus: payload.watchlist.lastStatus,
      };
      // Bounded map: keep the newest 40 tracked lists (the console renders
      // one card per list; anything beyond that is stale detail).
      const keys = Object.keys(lastDigests);
      if (keys.length > MAX_TRACKED_LISTS) {
        for (const k of keys.slice(0, keys.length - MAX_TRACKED_LISTS)) delete lastDigests[k];
      }
      return { eventsReceived: s.eventsReceived + 1, lastEventAt: payload.pushedAt, lastDigests };
    }),
  onReconnecting: () => set({ channelState: 'reconnecting' }),
  onDisabled: () => set({ channelState: 'disabled' }),
}));
