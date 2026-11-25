'use client';

import React from 'react';
import { RotateCcw, Radio } from 'lucide-react';
import { ApiRequestError } from '@/lib/api-client';
import { SkeletonPanel, SkeletonRows } from '@/components/system/skeletons';
import { cn } from '@/lib/utils';

/**
 * Unified async-state contract for every console view.
 * <QueryState> renders HUD skeletons while loading, a TELEMETRY LINK FAULT
 * panel on error (with correlation id + retry), an EMPTY state, or children.
 */
interface QueryStateProps {
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** Optional label shown in skeleton / fault panels. */
  label?: string;
  /** Custom skeleton element (defaults to SkeletonPanel). */
  skeleton?: React.ReactNode;
  /** Trigger for the empty state. */
  isEmpty?: boolean;
  /** Custom empty state element. */
  empty?: React.ReactNode;
  children: React.ReactNode;
}

export function errorHumanization(error: unknown): { message: string; correlationId?: string; provider?: string } {
  if (error instanceof ApiRequestError) {
    return {
      message: error.message || 'Request failed',
      correlationId: error.correlationId,
      provider: error.providerMessage,
    };
  }
  if (error instanceof Error) return { message: error.message };
  return { message: 'Unknown error' };
}

export function QueryState(props: QueryStateProps) {
  if (props.isLoading) {
    return (
      <div role="status" aria-live="polite">
        {props.skeleton ?? <SkeletonPanel label={props.label ?? 'Acquiring telemetry'} />}
      </div>
    );
  }
  if (props.isError) {
    return <FaultPanel error={props.error} onRetry={props.onRetry} label={props.label} />;
  }
  if (props.isEmpty) {
    return props.empty ?? <EmptyState label={props.label} />;
  }
  return <>{props.children}</>;
}

/** Mission-style fault panel for any failed request, with retry affordance. */
export function FaultPanel({
  error,
  onRetry,
  label,
  hint,
  className,
}: {
  error?: unknown;
  onRetry?: () => void;
  label?: string;
  hint?: string;
  className?: string;
}) {
  const { message, correlationId, provider } = errorHumanization(error);
  return (
    <div
      role="alert"
      className={cn('anim-fade-up hud p-4 sm:p-5', className)}
      style={{ borderColor: 'rgba(255, 178, 36, 0.38)' }}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-caution/40 bg-caution/10" aria-hidden>
          <Radio className="h-4 w-4 text-caution" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="kicker" style={{ color: 'var(--caution)' }}>
            Telemetry link fault
          </p>
          <p className="mt-1 text-sm text-ink">
            {label ? `${label} — ` : ''}The request to the console API failed.
          </p>
          <div className="mt-2 grid gap-1 font-mono text-[11px] text-faint">
            <div className="break-words">
              reason: <span className="text-dim">{message}</span>
            </div>
            {provider && (
              <div className="break-words">
                provider: <span className="text-dim">{provider}</span>
              </div>
            )}
            {correlationId && (
              <div>
                correlation: <span className="text-aqua">{correlationId}</span>
              </div>
            )}
          </div>
          <p className="mt-2 text-[11px] text-faint">
            {hint ?? 'No data was fabricated or substituted for the missing telemetry. Retry re-requests the live source.'}
          </p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="mt-3 inline-flex h-8 items-center gap-2 rounded-sm border border-nasa/50 bg-nasa/10 px-3 text-xs font-semibold uppercase tracking-wide-mc text-ink transition-colors hover:bg-nasa/20 focus-visible:outline-2 focus-visible:outline-offset-2"
              style={{ outlineColor: 'var(--nasa)' }}
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Retry request
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function EmptyState({ label, hint, action }: { label?: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="hud hud-calm anim-fade-up flex flex-col items-center gap-2 p-8 text-center">
      <span className="h-2 w-2 rounded-full border border-faint bg-transparent" aria-hidden />
      <p className="font-display text-sm font-semibold uppercase tracking-wide-mc text-dim">
        {label ? `${label} — no data` : 'No data'}
      </p>
      <p className="max-w-md text-xs leading-relaxed text-faint">
        {hint ?? 'Nothing has been ingested for this selection yet. The console never substitutes synthetic values; ingest or query real telemetry first.'}
      </p>
      {action}
    </div>
  );
}

/** Small inline loading chip for compact surfaces (buttons, table cells). */
export function LoadingChip({ label = 'loading' }: { label?: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-wide-mc text-faint">
      <span className="anim-blink h-1.5 w-1.5 rounded-full bg-aqua" aria-hidden />
      {label}
    </span>
  );
}

export { SkeletonPanel, SkeletonRows };
