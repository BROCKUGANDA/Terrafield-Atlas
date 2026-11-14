'use client';

import React from 'react';
import { AlertTriangle, RotateCcw, ClipboardCopy } from 'lucide-react';

/**
 * Mission-grade error boundary.
 * Catches render faults in any console module and shows a SYSTEM FAULT panel
 * instead of a white crash — with a digest, copyable diagnostics, and a
 * reset action. Never swallows the error: it is printed to console.error.
 */
interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Module label, e.g. "Rotation Planner". */
  label?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
  digest: string;
}

function digestOf(err: Error): string {
  const raw = `${err.name}:${err.message}:${err.stack?.length ?? 0}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, digest: '' };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error, digest: digestOf(error) };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error(`[fault] ${this.props.label ?? 'module'} render fault:`, error, info.componentStack);
  }

  private reset = () => this.setState({ error: null, digest: '' });

  private copyDiagnostics = async () => {
    const { error, digest } = this.state;
    if (!error) return;
    const text = [
      'TERRAFIELD ATLAS — FAULT DIAGNOSTIC',
      `module: ${this.props.label ?? 'console'}`,
      `digest: FAULT-${digest}`,
      `error: ${error.name}: ${error.message}`,
      `stack: ${error.stack?.slice(0, 1200) ?? 'unavailable'}`,
      `at: ${new Date().toISOString()}`,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard may be denied; diagnostics remain on screen */
    }
  };

  render() {
    const { error, digest } = this.state;
    const label = this.props.label ?? 'console module';
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        aria-live="assertive"
        aria-label={`${label} fault`}
        className="anim-fade-up hud p-5 sm:p-6"
        style={{ borderColor: 'rgba(255, 93, 93, 0.4)' }}
      >
        <div className="flex items-start gap-3">
          <span
            className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border border-crit/40 bg-crit/10"
            aria-hidden
          >
            <AlertTriangle className="h-5 w-5 text-crit" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="kicker" style={{ color: 'var(--crit)' }}>
              System fault
            </p>
            <h2 className="mt-1.5 font-display text-lg font-bold uppercase tracking-wide-mc text-ink">
              {label} module failed to render
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-dim">
              The module crashed during render and was isolated so the rest of the console keeps operating.
              No data was fabricated or substituted while this module is down.
            </p>
            <div className="mt-3 grid gap-1.5 font-mono text-[11px] text-faint">
              <div>
                FAULT-<span className="text-caution">{digest || '00000000'}</span> · module: <span className="text-dim">{label}</span>
              </div>
              <div className="truncate" title={String(error.message)}>
                {String(error.name)}: {String(error.message).slice(0, 180)}
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2.5">
              <button
                type="button"
                onClick={this.reset}
                className="inline-flex h-9 items-center gap-2 rounded-sm border border-nasa/50 bg-nasa/10 px-3.5 text-xs font-semibold uppercase tracking-wide-mc text-ink transition-colors hover:bg-nasa/20 focus-visible:outline-2 focus-visible:outline-offset-2"
                style={{ outlineColor: 'var(--nasa)' }}
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Reset module
              </button>
              <button
                type="button"
                onClick={this.copyDiagnostics}
                className="inline-flex h-9 items-center gap-2 rounded-sm border border-edge bg-panel-2 px-3.5 text-xs font-semibold uppercase tracking-wide-mc text-dim transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2"
                style={{ outlineColor: 'var(--nasa)' }}
              >
                <ClipboardCopy className="h-3.5 w-3.5" aria-hidden /> Copy diagnostics
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
