'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { logEvent } from '@/components/state/log-store';
import { TOUR_STEPS, TOUR_VERSION } from '@/lib/tour-steps';

/**
 * Guided first-run tour state.
 *
 * Persisted per browser (like the console session), keyed by a TOUR_VERSION
 * so shipping new steps re-offers the tour once to returning operators. The
 * tour is offered exactly once per operator: the first login after landing
 * auto-starts it unless it was already completed or skipped.
 */

export type TourStatus = 'unstarted' | 'active' | 'completed' | 'skipped';

interface TourState {
  version: number;
  status: TourStatus;
  stepIndex: number;
  /** Start (or restart) the tour from step 0. */
  start: () => void;
  next: () => void;
  prev: () => void;
  goto: (i: number) => void;
  finish: () => void;
  skip: () => void;
}

const initial = {
  version: TOUR_VERSION,
  status: 'unstarted' as TourStatus,
  stepIndex: 0,
};

export const useTourStore = create<TourState>()(
  persist(
    (set, get) => ({
      ...initial,
      start: () => {
        set({ status: 'active', stepIndex: 0 });
        logEvent({
          severity: 'info',
          category: 'SYSTEM',
          title: 'Guided tour started',
          detail: `First-run console tour (${TOUR_STEPS.length} steps). Navigate with ←/→ or the buttons; Esc leaves the tour at any time.`,
        });
      },
      next: () => {
        const { stepIndex } = get();
        if (stepIndex >= TOUR_STEPS.length - 1) {
          get().finish();
          return;
        }
        set({ stepIndex: stepIndex + 1 });
      },
      prev: () => set({ stepIndex: Math.max(0, get().stepIndex - 1) }),
      goto: (i) => set({ stepIndex: Math.max(0, Math.min(TOUR_STEPS.length - 1, i)) }),
      finish: () => {
        set({ status: 'completed', stepIndex: 0 });
        logEvent({
          severity: 'success',
          category: 'SYSTEM',
          title: 'Guided tour completed',
          detail: `Operator walked all ${TOUR_STEPS.length} console steps. Restart any time from System Health → Operations or the command palette.`,
        });
      },
      skip: () => {
        const { status } = get();
        if (status !== 'active') return;
        set({ status: 'skipped', stepIndex: 0 });
        logEvent({
          severity: 'info',
          category: 'SYSTEM',
          title: 'Guided tour skipped',
          detail: 'Operator exited the first-run tour early; it stays available via the command palette and System Health.',
        });
      },
    }),
    {
      name: 'terrafield-guided-tour',
      version: TOUR_VERSION,
      // A version bump (new steps) re-offers the tour once to returning users.
      migrate: (_persisted, _version) => ({ ...initial }),
    },
  ),
);
