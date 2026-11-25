'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ViewKey } from '@/components/state/store';

/**
 * Mission log — the console's local event ledger.
 *
 * Every consequential operator action (authentication, ingestion, analysis,
 * rotation comparisons, report generation, exports, provider degradation)
 * is appended here with a UTC timestamp and severity. The ledger is local to
 * this browser and is NOT transmitted anywhere; it exists so an operator can
 * audit what the console did during a session.
 */

export type LogSeverity = 'info' | 'success' | 'warn' | 'crit';
export type LogCategory =
  | 'AUTH'
  | 'INGEST'
  | 'ANALYSIS'
  | 'AI'
  | 'ROTATION'
  | 'REPORT'
  | 'FIRE'
  | 'FARM'
  | 'EXPORT'
  | 'SYSTEM';

export interface MissionEvent {
  id: string;
  /** ISO timestamp (UTC) */
  ts: string;
  severity: LogSeverity;
  category: LogCategory;
  title: string;
  detail?: string;
  correlationId?: string;
  view?: ViewKey;
}

const MAX_EVENTS = 200;

interface LogState {
  events: MissionEvent[];
  unread: number;
  push: (event: Omit<MissionEvent, 'id' | 'ts'> & { ts?: string }) => void;
  markAllRead: () => void;
  clear: () => void;
}

let seq = 0;

export const useMissionLog = create<LogState>()(
  persist(
    (set) => ({
      events: [],
      unread: 0,
      push: (event) =>
        set((state) => {
          const stamped: MissionEvent = {
            ...event,
            id: `EVT-${Date.now().toString(36)}-${(seq += 1).toString(36).padStart(3, '0')}`,
            ts: event.ts ?? new Date().toISOString(),
          };
          return {
            events: [stamped, ...state.events].slice(0, MAX_EVENTS),
            unread: Math.min(state.unread + 1, MAX_EVENTS),
          };
        }),
      markAllRead: () => set({ unread: 0 }),
      clear: () => set({ events: [], unread: 0 }),
    }),
    {
      name: 'terrafield-mission-log',
      version: 1,
      partialize: (s) => ({ events: s.events.slice(0, 50), unread: s.unread }),
    },
  ),
);

/** Fire-and-forget logging from mutation callbacks and non-hook contexts. */
export function logEvent(event: Omit<MissionEvent, 'id' | 'ts'> & { ts?: string }): void {
  useMissionLog.getState().push(event);
}

/** Compact UTC time for ledger rows, e.g. "14:03:22Z". */
export function eventTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--:--Z';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}

/** UTC date for ledger day separators, e.g. "2026-11-14". */
export function eventDate(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return 'unknown-date';
  return d.toISOString().slice(0, 10);
}
