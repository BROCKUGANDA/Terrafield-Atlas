'use client';

import { useQuery } from '@tanstack/react-query';
import { ShieldAlert, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api-client';
import { logEvent } from '@/components/state/log-store';
import { useSession } from '@/components/state/store';

/**
 * Global operations banner. Critical-infrastructure behavior: when any data
 * provider is degraded, unreachable, or short-circuited, a persistent caution
 * strip appears above the console; users can dismiss it for this page view,
 * and it re-appears whenever the condition changes or worsens.
 */
export function DegradedBanner() {
  const [dismissedSignature, setDismissedSignature] = useState<string | null>(null);
  const health = useQuery({
    queryKey: ['health-banner'],
    queryFn: api.health,
    refetchInterval: 90_000,
    retry: 1,
  });

  const degradedSources = (health.data?.dataSources ?? []).filter((s) => s.status !== 'operational');
  const linkLost = health.isError;
  const signature = linkLost
    ? 'link-lost'
    : degradedSources.map((s) => s.datasetName).sort().join('|');
  const active = (linkLost || degradedSources.length > 0) && signature !== dismissedSignature;

  // Critical-infra auditing: every distinct degradation state is written to the
  // mission log exactly once (re-appearing after dismissal re-logs it).
  const loggedSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    if (!active || loggedSignatureRef.current === signature) return;
    loggedSignatureRef.current = signature;
    logEvent({
      severity: 'warn',
      category: 'SYSTEM',
      title: linkLost ? 'Operations link degraded' : `Partial telemetry — ${degradedSources.length} provider${degradedSources.length > 1 ? 's' : ''} degraded`,
      detail: linkLost
        ? 'Console API unreachable; automatic retries in flight. Data shown may be stale — no substitution.'
        : `${degradedSources.map((s) => s.datasetName.split('(')[0].trim()).join(', ')} degraded. Affected views show real data only; no substitution and no fabricated fallbacks.`,
      view: useSession.getState().view,
    });
  }, [active, signature, linkLost, degradedSources]);

  if (!active) return null;

  return (
    <div role="status" aria-live="polite" className="anim-fade-up sticky top-14 z-40">
      <div className="border-b border-caution/30 bg-caution/10 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-2 sm:px-6 lg:px-8">
          <ShieldAlert className="h-4 w-4 shrink-0 text-caution" aria-hidden />
          <p className="min-w-0 flex-1 truncate text-xs text-caution">
            {linkLost ? (
              <>
                <span className="font-semibold uppercase tracking-wide-mc">Operations link degraded</span>
                <span className="text-dim"> — console API unreachable; retrying automatically. Data below may be stale.</span>
              </>
            ) : (
              <>
                <span className="font-semibold uppercase tracking-wide-mc">Partial telemetry</span>
                <span className="text-dim">
                  {' '}— {degradedSources.length} source{degradedSources.length > 1 ? 's' : ''} degraded:{' '}
                  {degradedSources.map((s) => s.datasetName.split('(')[0].trim()).join(', ')}. Affected views show real data only; no substitution.
                </span>
              </>
            )}
          </p>
          <button
            type="button"
            onClick={() => setDismissedSignature(signature)}
            aria-label="Dismiss degraded-operations notice"
            className="shrink-0 rounded-sm p-1 text-caution/80 transition-colors hover:text-caution focus-visible:outline-2 focus-visible:outline-offset-2"
            style={{ outlineColor: 'var(--caution)' }}
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}
