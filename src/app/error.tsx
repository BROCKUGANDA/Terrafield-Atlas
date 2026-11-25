'use client';

import { useEffect } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

/**
 * Route-segment error boundary (SSR + client render faults for this route).
 * Themed like the console's fault panels; offers a real reset (re-render)
 * plus a full reload. Renders INSIDE the root layout so navigation stays
 * possible even when the page body faulted.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[route-fault]', error);
  }, [error]);

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="anim-fade-up mx-auto my-10 w-full max-w-2xl hud p-6"
      style={{ borderColor: 'rgba(255, 93, 93, 0.4)' }}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border border-crit/40 bg-crit/10" aria-hidden>
          <AlertTriangle className="h-5 w-5 text-crit" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="kicker" style={{ color: 'var(--crit)' }}>
            Page fault — SSR boundary
          </p>
          <h1 className="mt-1.5 font-display text-lg font-bold uppercase tracking-wide-mc text-ink">
            This view hit a server-side fault
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-dim">
            The server could not render this page. Nothing was fabricated to fill the gap; the rest of the
            console remains reachable from the navigation rail.
          </p>
          <div className="mt-3 grid gap-1 font-mono text-[11px] text-faint">
            <div className="break-words">
              {error.name}: <span className="text-dim">{error.message.slice(0, 200)}</span>
            </div>
            {error.digest && (
              <div>
                digest: <span className="text-aqua">{error.digest}</span>
              </div>
            )}
          </div>
          <div className="mt-4 flex flex-wrap gap-2.5">
            <button
              type="button"
              onClick={reset}
              className="inline-flex h-9 items-center gap-2 rounded-sm border border-nasa/50 bg-nasa/10 px-3.5 text-xs font-semibold uppercase tracking-wide-mc text-ink transition-colors hover:bg-nasa/20 focus-visible:outline-2 focus-visible:outline-offset-2"
              style={{ outlineColor: 'var(--nasa)' }}
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Re-render view
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex h-9 items-center gap-2 rounded-sm border border-edge bg-panel-2 px-3.5 text-xs font-semibold uppercase tracking-wide-mc text-dim transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2"
              style={{ outlineColor: 'var(--nasa)' }}
            >
              Reload console
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
