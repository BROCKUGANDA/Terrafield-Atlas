'use client';

import { useEffect } from 'react';
import { useUiStore } from '@/components/state/ui-store';
import { useSession, type ViewKey } from '@/components/state/store';
import { useTourStore } from '@/components/state/tour-store';

/**
 * Global console hotkeys.
 *
 *  - ⌘K / Ctrl+K → command palette (works everywhere, even while typing)
 *  - ?            → shortcuts overlay
 *  - t            → start/restart the guided first-run tour
 *  - o d e a f w r b p s → jump between console modules
 *
 * Single-key jumps are suppressed while the operator is typing in any input,
 * textarea, select or contenteditable element, and whenever a modifier is
 * held, so they never collide with normal text entry.
 */

const VIEW_KEYS: Record<string, ViewKey> = {
  o: 'landing',
  d: 'dashboard',
  e: 'explorer',
  a: 'analysis',
  f: 'fire',
  w: 'farm',
  r: 'rotation',
  b: 'reports',
  p: 'provenance',
  s: 'settings',
};

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export function useConsoleHotkeys(enabled: boolean): void {
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);
  const setHelpOpen = useUiStore((s) => s.setHelpOpen);
  const setView = useSession((s) => s.setView);
  const startTour = useTourStore((s) => s.start);

  useEffect(() => {
    if (!enabled) return undefined;

    const onKeyDown = (e: KeyboardEvent) => {
      // Palette is available even mid-typing — it is the master escape hatch.
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }

      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;

      if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
        e.preventDefault();
        setHelpOpen(true);
        return;
      }

      if (e.key.toLowerCase() === 't') {
        e.preventDefault();
        startTour();
        return;
      }

      const view = VIEW_KEYS[e.key.toLowerCase()];
      if (view) {
        e.preventDefault();
        setView(view);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, setPaletteOpen, setHelpOpen, setView, startTour]);
}
