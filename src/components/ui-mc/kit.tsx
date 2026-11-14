'use client';

import React from 'react';
import { cn } from '@/lib/utils';

/**
 * Mission-console component kit.
 * Small, composable, opinionated primitives that define the TerraField look:
 * HUD panels, red kickers, telemetry numerals, status pills.
 */

export function Kicker({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn('kicker', className)}>{children}</p>;
}

export function SectionHeader({
  kicker,
  title,
  description,
  actions,
  className,
}: {
  kicker: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-4', className)}>
      <div className="min-w-0 max-w-3xl">
        <Kicker>{kicker}</Kicker>
        <h2 className="mt-2 font-display text-xl font-bold uppercase tracking-wide-mc text-ink sm:text-2xl">{title}</h2>
        {description && <p className="mt-2 text-sm leading-relaxed text-dim">{description}</p>}
      </div>
      {actions && <div className="flex min-w-0 max-w-full shrink-0 flex-wrap items-center gap-2.5">{actions}</div>}
    </div>
  );
}

const PILL_TONES: Record<string, string> = {
  operational: 'text-signal',
  ok: 'text-signal',
  nominal: 'text-signal',
  live: 'text-signal',
  ready: 'text-signal',
  degraded: 'text-caution',
  stale: 'text-caution',
  unconfigured: 'text-caution',
  checking: 'text-caution',
  unavailable: 'text-crit',
  unreachable: 'text-crit',
  error: 'text-crit',
  failed: 'text-crit',
  offline: 'text-crit',
};

const PILL_DOTS: Record<string, string> = {
  operational: 'bg-signal',
  ok: 'bg-signal',
  nominal: 'bg-signal',
  live: 'bg-signal',
  ready: 'bg-signal',
  degraded: 'bg-caution',
  stale: 'bg-caution',
  unconfigured: 'bg-caution',
  checking: 'bg-caution',
  unavailable: 'bg-crit',
  unreachable: 'bg-crit',
  error: 'bg-crit',
  failed: 'bg-crit',
  offline: 'bg-crit',
};

export function StatusPill({ status, pulse = true, className }: { status: string; pulse?: boolean; className?: string }) {
  const tone = PILL_TONES[status.toLowerCase()] ?? 'text-dim';
  const dot = PILL_DOTS[status.toLowerCase()] ?? 'bg-faint';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-sm border border-edge bg-panel-2/60 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide-mc',
        tone,
        className,
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', dot, pulse && 'anim-blink')} aria-hidden />
      {status}
    </span>
  );
}

/** Telemetry readout: mono label, big tabular numeral, unit, optional trend delta. */
export function TelemetryStat({
  label,
  value,
  unit,
  delta,
  deltaTone = 'up' as 'up' | 'down' | 'flat',
  hint,
  className,
}: {
  label: string;
  value: string | number | null;
  unit?: string;
  delta?: string | null;
  deltaTone?: 'up' | 'down' | 'flat';
  hint?: string;
  className?: string;
}) {
  const deltaClass =
    deltaTone === 'up' ? 'text-signal' : deltaTone === 'down' ? 'text-crit' : 'text-faint';
  return (
    <div className={cn('hud hud-calm p-4', className)}>
      <p className="font-mono text-[10px] uppercase tracking-wide-mc text-faint">{label}</p>
      <p className="telemetry mt-2 text-2xl font-medium text-ink">
        {value === null || value === undefined ? (
          <span className="text-faint">—</span>
        ) : (
          <>
            {value}
            {unit && <span className="ml-1 text-xs text-dim">{unit}</span>}
          </>
        )}
      </p>
      {(delta || hint) && (
        <p className="mt-1.5 flex items-center gap-2 font-mono text-[11px]">
          {delta && <span className={deltaClass}>{delta}</span>}
          {hint && <span className="truncate text-faint">{hint}</span>}
        </p>
      )}
    </div>
  );
}

/** Base HUD panel wrapper with sane padding. Forwards div props (incl. data-tour). */
export function HudPanel({
  children,
  className,
  calm = true,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & { calm?: boolean }) {
  return (
    <div className={cn('hud p-4 sm:p-5', calm && 'hud-calm', className)} {...rest}>
      {children}
    </div>
  );
}

/** Mono coordinate readout, e.g. "0.280°S · 36.070°E". */
export function CoordReadout({ lat, lon, className }: { lat: number; lon: number; className?: string }) {
  const latStr = `${Math.abs(lat).toFixed(3)}°${lat >= 0 ? 'N' : 'S'}`;
  const lonStr = `${Math.abs(lon).toFixed(3)}°${lon >= 0 ? 'E' : 'W'}`;
  return (
    <span className={cn('telemetry text-xs text-dim', className)}>
      {latStr} · {lonStr}
    </span>
  );
}
