'use client';

/**
 * HUD skeleton primitives — every loading state in the console uses these,
 * so async surfaces never render blank flashes.
 */

export function SkeletonBlock({ className }: { className?: string }) {
  return <div aria-hidden className={`skeleton-mc ${className ?? ''}`} />;
}

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  const widths = ['100%', '82%', '91%', '64%', '88%', '74%', '95%', '70%'];
  return (
    <div aria-hidden className="grid gap-2.5">
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonBlock key={i} className={`h-3 ${widths[i % widths.length]} max-w-full`} />
      ))}
    </div>
  );
}

/** Console panel skeleton: kicker line, title block, sweeping scan, rows. */
export function SkeletonPanel({ rows = 4, label = 'Acquiring telemetry' }: { rows?: number; label?: string }) {
  return (
    <div aria-hidden className="hud hud-calm relative overflow-hidden p-4">
      <div className="sweep-mc" />
      <SkeletonBlock className="h-2 w-28" />
      <SkeletonBlock className="mt-3 h-4 w-2/5" />
      <div className="mt-4">
        <SkeletonRows rows={rows} />
      </div>
      <p className="mt-4 font-mono text-[10px] uppercase tracking-wide-mc text-faint">{label}…</p>
    </div>
  );
}

/** Telemetry stat skeleton: label, big numeral, delta bar. */
export function StatSkeleton() {
  return (
    <div aria-hidden className="hud hud-calm p-4">
      <SkeletonBlock className="h-2 w-20" />
      <SkeletonBlock className="mt-3 h-7 w-24" />
      <SkeletonBlock className="mt-3 h-1.5 w-full" />
    </div>
  );
}

/** Grid of stat skeletons for dashboard-like headers. */
export function StatSkeletonRow({ count = 4 }: { count?: number }) {
  return (
    <div className={`grid gap-3 sm:grid-cols-2 ${count > 2 ? 'lg:grid-cols-4' : ''}`}>
      {Array.from({ length: count }).map((_, i) => (
        <StatSkeleton key={i} />
      ))}
    </div>
  );
}

/** Big centered sweep loader for full-view waits (ingest jobs, report builds). */
export function SweepLoader({ label = 'Processing' }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="hud hud-calm relative overflow-hidden p-6">
      <div className="sweep-mc" />
      <div className="flex items-center gap-3">
        <span className="anim-blink h-2 w-2 rounded-full bg-signal" aria-hidden />
        <p className="font-mono text-xs uppercase tracking-wide-mc text-dim">{label}…</p>
      </div>
      <div className="mt-4">
        <SkeletonRows rows={3} />
      </div>
    </div>
  );
}
