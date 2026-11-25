'use client';

import React from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useSession } from '@/components/state/store';
import { useTourStore } from '@/components/state/tour-store';
import { TOUR_STEPS } from '@/lib/tour-steps';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Guided first-run tour overlay.
 *
 * Full implementation notes:
 *  - Steps may switch console views (store-driven); the overlay WAITS for the
 *    target `[data-tour]` element to mount (async data, 0.22 s view swap) by
 *    polling, then scrolls it into view and spotlights it.
 *  - Spotlight = a fixed-position box with a 9999px box-shadow mask + nasa-red
 *    ring; the card positions itself around the target with viewport clamping.
 *  - Keyboard: ←/→ navigate, Esc skips, Enter advances. The card is a
 *    role=dialog with aria-modal.
 *  - Scroll/resize/mutation listeners keep the spotlight glued to the target
 *    (state updates are change-guarded so DOM mutations cannot loop).
 *  - Small screens pin the card bottom-center (targets still scroll into view).
 *  - prefers-reduced-motion disables the spotlight travel transition.
 *  - Hydration and viewport-width probes use useSyncExternalStore (no setState
 *    in render/effect bodies, per the React-compiler lint contract).
 */

const HOLE_PAD = 10;
const POLL_INTERVAL_MS = 120;
const PATIENCE_MS = 6000;

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function rectsEqual(a: Rect | null, b: Rect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

function findTarget(selector: string): HTMLElement | null {
  try {
    return document.querySelector<HTMLElement>(selector);
  } catch {
    return null;
  }
}

const emptySubscribe = () => () => {};
/** Client-true / server-false hydration probe. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
}

const MOBILE_QUERY = '(max-width: 639px)';
function subscribeMobile(cb: () => void): () => void {
  const mq = window.matchMedia(MOBILE_QUERY);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}
function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribeMobile,
    () => window.matchMedia(MOBILE_QUERY).matches,
    () => false,
  );
}

export function GuidedTour() {
  const { view, setView, operator } = useSession();
  const { status, stepIndex, next, prev, goto, finish, skip, start } = useTourStore();
  const hydrated = useHydrated();
  const isMobile = useIsMobile();
  const [targetInfo, setTargetInfo] = useState<{ stepIndex: number; rect: Rect | null } | null>(null);
  const [cardSize, setCardSize] = useState<{ w: number; h: number }>({ w: 400, h: 220 });
  const cardRef = useRef<HTMLDivElement | null>(null);

  const step = TOUR_STEPS[Math.min(stepIndex, TOUR_STEPS.length - 1)];
  const active = status === 'active' && !!operator;
  const isLast = stepIndex >= TOUR_STEPS.length - 1;
  // Resolution is DERIVED: a step without a target resolves instantly; a step
  // with one resolves when the poll finds the element (no sync setState reset
  // needed when the step changes — the stale state simply stops matching).
  const resolved = !step?.target || (targetInfo !== null && targetInfo.stepIndex === stepIndex);
  const rect = resolved ? (targetInfo?.rect ?? null) : null;

  // Auto-start on the operator's first session (and never again until restart).
  useEffect(() => {
    if (hydrated && operator && status === 'unstarted') {
      const t = setTimeout(() => start(), 700);
      return () => clearTimeout(t);
    }
  }, [hydrated, operator, status, start]);

  // Ensure the step's console view is mounted before resolving its target.
  useEffect(() => {
    if (!active || !step?.view) return;
    if (view !== step.view) setView(step.view);
  }, [active, step, view, setView]);

  const publishRect = useCallback(
    (idx: number, r: Rect | null) => {
      setTargetInfo((prev) => {
        if (prev && prev.stepIndex === idx && rectsEqual(prev.rect, r)) return prev; // change-guarded
        return { stepIndex: idx, rect: r };
      });
    },
    [],
  );

  // Resolve the target for the current step: poll until mounted (async data /
  // view swaps), then keep measuring on scroll/resize/DOM mutation.
  useEffect(() => {
    if (!active || !step || !step.target) return undefined;
    const selector = `[data-tour="${CSS.escape(step.target)}"]`;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let raf: number | null = null;
    let cancelled = false;
    const started = Date.now();

    const attempt = () => {
      if (cancelled) return;
      const el = findTarget(selector);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        raf = requestAnimationFrame(() => {
          if (cancelled) return;
          const r = el.getBoundingClientRect();
          publishRect(stepIndex, { left: r.left, top: r.top, width: r.width, height: r.height });
        });
        return;
      }
      if (Date.now() - started > PATIENCE_MS) {
        // Element never appeared — fall back to a centered card, never stall.
        publishRect(stepIndex, null);
        return;
      }
      timer = setTimeout(attempt, POLL_INTERVAL_MS);
    };
    attempt();

    const retrack = () => {
      if (cancelled) return;
      const el = findTarget(selector);
      if (!el) {
        publishRect(stepIndex, null);
        return;
      }
      const r = el.getBoundingClientRect();
      publishRect(stepIndex, { left: r.left, top: r.top, width: r.width, height: r.height });
    };
    window.addEventListener('scroll', retrack, true);
    window.addEventListener('resize', retrack);
    const mo = new MutationObserver(() => retrack());
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (raf !== null) cancelAnimationFrame(raf);
      window.removeEventListener('scroll', retrack, true);
      window.removeEventListener('resize', retrack);
      mo.disconnect();
    };
    // stepIndex (not step identity) drives re-resolution: view swaps land async.
  }, [active, stepIndex, step, publishRect]);

  // Card size tracking (for clamped placement); the observer fires on observe.
  useLayoutEffect(() => {
    if (!active) return undefined;
    const el = cardRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => {
      setCardSize((prev) => {
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        if (prev.w === w && prev.h === h) return prev;
        return { w, h };
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [active, stepIndex, resolved]);

  // Move focus into the modal card and restore it when the tour closes.
  useEffect(() => {
    if (!active || !resolved) return undefined;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cardRef.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [active, resolved]);

  // Keyboard navigation and a strict Tab focus trap while the tour is active.
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (e.key === 'Escape') {
        e.preventDefault();
        skip();
        return;
      }
      if (e.key === 'Tab') {
        const focusable = [...(cardRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])];
        if (focusable.length === 0) {
          e.preventDefault();
          cardRef.current?.focus();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === cardRef.current)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
        return;
      }
      if (typing) return;
      if (e.key === 'ArrowRight' || (e.key === 'Enter' && t && t.closest('[data-tour-card]'))) {
        e.preventDefault();
        next();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        prev();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, next, prev, skip]);

  if (!hydrated || !active || !step || !resolved) return null;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const hole: Rect | null = rect
    ? {
        left: Math.max(6, rect.left - HOLE_PAD),
        top: Math.max(6, rect.top - HOLE_PAD),
        width: Math.min(rect.width + HOLE_PAD * 2, vw - 12),
        height: rect.height + HOLE_PAD * 2,
      }
    : null;

  // --- card placement ---
  let cardStyle: React.CSSProperties;
  if (isMobile) {
    cardStyle = { position: 'fixed', left: 12, right: 12, bottom: 12, width: 'auto' };
  } else if (!hole) {
    const w = Math.min(420, vw - 32);
    cardStyle = {
      position: 'fixed',
      width: w,
      left: Math.round((vw - w) / 2),
      top: Math.round(vh * 0.34),
    };
  } else {
    const w = Math.min(400, vw - 24);
    const h = cardSize.h || 220;
    let top: number;
    const below = hole.top + hole.height + 14;
    const above = hole.top - h - 14;
    if (below + h <= vh - 10) top = below;
    else if (above >= 10) top = above;
    else top = Math.max(10, Math.min(vh - h - 10, hole.top + hole.height / 2 - h / 2));
    const left = Math.max(12, Math.min(vw - w - 12, hole.left + hole.width / 2 - w / 2));
    cardStyle = { position: 'fixed', width: w, top: Math.round(top), left: Math.round(left) };
  }

  const titleId = `tour-step-${step.id}-title`;

  return (
    <div data-tour-overlay>
      {/* Backdrop / spotlight */}
      {hole ? (
        <div
          className="pointer-events-none fixed z-[70] rounded-sm motion-reduce:transition-none"
          style={{
            left: hole.left,
            top: hole.top,
            width: hole.width,
            height: hole.height,
            boxShadow: '0 0 0 9999px rgba(2, 6, 12, 0.82)',
            border: '2px solid var(--nasa)',
            transition: 'left 200ms ease, top 200ms ease, width 200ms ease, height 200ms ease',
          }}
          aria-hidden
        />
      ) : (
        <div className="pointer-events-none fixed inset-0 z-[70] bg-void/82" aria-hidden />
      )}

      {/* Step card */}
      <div
        ref={cardRef}
        data-tour-card
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={cardStyle}
        className={cn(
          'z-[80] rounded-sm border border-nasa/40 bg-popover p-4 shadow-[0_24px_80px_rgba(0,0,0,0.6)] outline-none',
          'motion-reduce:transition-none',
        )}
      >
        <div className="flex items-center justify-between gap-3">
          <p className="font-mono text-[9px] uppercase tracking-mission text-nasa">
            guided tour · step {stepIndex + 1}/{TOUR_STEPS.length}
          </p>
          <button
            type="button"
            onClick={skip}
            className="rounded-sm px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide-mc text-faint transition-colors hover:text-crit focus-visible:outline-2 focus-visible:outline-offset-2"
            style={{ outlineColor: 'var(--nasa)' }}
            aria-label="Skip the guided tour"
          >
            skip ×
          </button>
        </div>

        <h2
          id={titleId}
          className={cn(
            'mt-2 font-display font-bold uppercase tracking-wide-mc text-ink',
            isMobile ? 'text-sm' : 'text-base',
          )}
        >
          {step.title}
        </h2>

        <div className="mt-2 flex flex-col gap-1.5">
          {step.body.map((p, i) => (
            <p key={i} className="text-xs leading-relaxed text-dim">
              {p}
            </p>
          ))}
        </div>

        {/* Progress dots */}
        <div className="mt-3 flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Tour steps">
          {TOUR_STEPS.map((s, i) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={i === stepIndex}
              aria-label={`Go to step ${i + 1}: ${s.title}`}
              onClick={() => goto(i)}
              className={cn(
                'h-1.5 rounded-full transition-all motion-reduce:transition-none',
                i === stepIndex ? 'w-5 bg-nasa' : 'w-1.5 bg-edge hover:bg-dim',
              )}
            />
          ))}
        </div>

        <div className="mt-3 flex items-center justify-between gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={prev}
            disabled={stepIndex === 0}
            className="h-8 font-mono text-[11px] uppercase tracking-wide-mc text-dim hover:text-ink"
            aria-label="Previous tour step"
          >
            ← back
          </Button>
          <Button
            onClick={isLast ? finish : next}
            className="h-8 font-mono text-[11px] uppercase tracking-wide-mc"
            aria-label={isLast ? 'Finish the guided tour' : 'Next tour step'}
          >
            {isLast ? (
              'finish tour ✓'
            ) : (
              <>
                next <span aria-hidden>→</span>
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
