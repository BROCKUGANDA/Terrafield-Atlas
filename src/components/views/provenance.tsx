'use client';

import { useState } from 'react';
import { motion, type Variants } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/components/state/store';
import { api } from '@/lib/api-client';
import { logEvent } from '@/components/state/log-store';
import { downloadCsv, timestampSlug } from '@/lib/export';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { Kicker, SectionHeader, StatusPill, TelemetryStat, HudPanel } from '@/components/ui-mc/kit';
import { QueryState, EmptyState, FaultPanel } from '@/components/system/query-state';
import { SkeletonPanel, StatSkeletonRow } from '@/components/system/skeletons';
import { ScrollText, Database, RefreshCw, CheckCircle2, XCircle, FileDown } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Staggered section entrance (y:12→0, 0.35s, ~60ms stagger, once). */
const RISE: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: (i: number = 0) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.35, delay: Math.min(i, 6) * 0.06, ease: [0.22, 1, 0.36, 1] },
  }),
};

const MONO_BTN = 'font-mono text-[11px] uppercase tracking-wide-mc';

/** Status-code tone: 2xx/3xx signal · 4xx caution · 5xx/0 crit. */
function statusTone(code: number): string {
  if (code >= 500 || code === 0) return 'text-crit';
  if (code >= 400) return 'text-caution';
  return 'text-signal';
}

/** Derived provider health from the last logged status. */
function providerStatus(last: number | null): string {
  if (last === null) return 'unconfigured';
  if (last >= 500 || last === 0) return 'error';
  if (last >= 400) return 'degraded';
  return 'operational';
}

/** Evidence & Provenance: request ledger, source register, methodology pointer. */
export function ProvenanceView() {
  const { setView } = useSession();
  const { toast } = useToast();
  const [provider, setProvider] = useState<string>('all');
  const provenance = useQuery({
    queryKey: ['provenance', provider],
    queryFn: () => api.provenance(120),
    refetchInterval: 30_000,
  });

  const logs = (provenance.data?.requestLog ?? []).filter((l) => provider === 'all' || l.provider === provider);
  const providers = [...new Set((provenance.data?.requestLog ?? []).map((l) => l.provider))];

  const exportLedger = () => {
    const d = provenance.data;
    if (!d) return;
    const rows = d.requestLog.map((l) => [
      l.retrievedAt,
      l.provider,
      l.datasetId ?? '',
      l.operation,
      l.status,
      l.ok ? 'ok' : 'failed',
      l.latencyMs,
      l.responseBytes ?? '',
      l.correlationId ?? '',
      l.errorDetail ?? '',
    ]);
    downloadCsv(
      `terrafield-provenance-ledger-${timestampSlug()}`,
      ['retrievedAt', 'provider', 'dataset', 'operation', 'httpStatus', 'result', 'latencyMs', 'responseBytes', 'correlationId', 'errorDetail'],
      rows,
    );
    logEvent({
      severity: 'info',
      category: 'EXPORT',
      title: 'Provenance ledger exported as CSV',
      detail: `${rows.length} provider requests incl. failures — status, latency, response size, correlation ID and retrieval timestamp.`,
      view: 'provenance',
    });
    toast({ title: 'Provenance exported', description: `${rows.length} ledger rows written to CSV — failures included, nothing filtered.` });
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <motion.div variants={RISE} custom={0} initial="hidden" whileInView="show" viewport={{ once: true }}>
        <SectionHeader
          kicker="Trust Ledger // Request Provenance"
          title="Evidence & Provenance"
          description="Every external request this platform has made, successful or not, with status, latency, response size, correlation ID and retrieval timestamp. This is the evidence chain behind every number shown elsewhere."
          actions={
            <div className="flex flex-wrap items-center gap-2.5">
              <Button
                variant="outline"
                size="sm"
                className={cn('h-8 uppercase', MONO_BTN)}
                onClick={() => provenance.refetch()}
                disabled={provenance.isFetching}
              >
                {provenance.isFetching ? (
                  <>
                    <span className="anim-blink h-1.5 w-1.5 rounded-full bg-aqua" aria-hidden /> Syncing…
                  </>
                ) : (
                  <>
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Refresh ledger
                  </>
                )}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={exportLedger}
                disabled={!provenance.data || provenance.data.requestLog.length === 0}
                className={cn('h-8 uppercase', MONO_BTN)}
                aria-label="Export the provider request ledger as CSV"
              >
                <FileDown className="h-3.5 w-3.5" aria-hidden /> Export CSV
              </Button>
            </div>
          }
        />
      </motion.div>

      <QueryState
        isLoading={provenance.isPending}
        isError={provenance.isError}
        error={provenance.error}
        onRetry={() => provenance.refetch()}
        label="Provenance ledger"
        skeleton={
          <div className="flex flex-col gap-4" role="status" aria-live="polite">
            <StatSkeletonRow count={3} />
            <SkeletonPanel label="Reading request ledger" rows={6} />
          </div>
        }
        isEmpty={!!provenance.data && provenance.data.requestLog.length === 0}
        empty={
          <EmptyState
            label="Request ledger"
            hint="No external provider requests have been logged yet. Ingest real telemetry to open the evidence chain — nothing is pre-seeded."
            action={
              <Button variant="outline" size="sm" className={cn('mt-2 uppercase', MONO_BTN)} onClick={() => setView('dashboard')}>
                <Database className="h-3.5 w-3.5" aria-hidden /> Ingest telemetry from Earth Intelligence
              </Button>
            }
          />
        }
      >
        {provenance.data && (
          <>
            {/* Ledger summary */}
            <motion.section variants={RISE} custom={1} initial="hidden" whileInView="show" viewport={{ once: true }} aria-label="Ledger summary">
              <div className="grid gap-3 sm:grid-cols-3">
                <TelemetryStat label="Requests logged" value={provenance.data.summary.requestsLogged.toLocaleString()} hint="success or failure" />
                <TelemetryStat label="Succeeded" value={provenance.data.summary.ok.toLocaleString()} delta="2xx/3xx" deltaTone="flat" hint="signal responses" />
                <TelemetryStat label="Failed" value={provenance.data.summary.failed.toLocaleString()} delta="4xx/5xx" deltaTone="flat" hint="logged, never hidden" />
              </div>

              {/* Provider summary cards */}
              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {Object.entries(provenance.data.summary.byProvider).map(([name, p]) => {
              const ratio = p.total > 0 ? p.ok / p.total : 0;
              return (
                <HudPanel key={name} className="flex flex-col gap-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-display text-sm font-bold uppercase tracking-wide-mc text-ink">{name}</span>
                    <StatusPill status={providerStatus(p.lastStatus)} pulse={providerStatus(p.lastStatus) !== 'operational'} />
                  </div>
                  <div>
                    <div className="flex justify-between font-mono text-[10px] uppercase tracking-wide-mc text-faint">
                      <span>success ratio</span>
                      <span className="telemetry text-dim">{p.ok}/{p.total} · {Math.round(ratio * 100)}%</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full border border-edge bg-panel-2" role="presentation">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${Math.round(ratio * 100)}%` }}
                        transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
                        className="h-full rounded-full bg-gradient-to-r from-nasa to-signal"
                      />
                    </div>
                  </div>
                  <p className="telemetry text-[10px] text-faint">
                    last {p.lastRetrievedAt ? new Date(p.lastRetrievedAt).toISOString().slice(0, 19).replace('T', ' ') : '—'} · status {p.lastStatus ?? '—'}
                  </p>
                </HudPanel>
              );
            })}
          </div>
        </motion.section>

        {/* Request ledger table */}
        <motion.section variants={RISE} custom={2} initial="hidden" whileInView="show" viewport={{ once: true }} aria-label="API request ledger" className="mt-6">
          <HudPanel>
            <div className="flex flex-wrap items-center gap-2">
              <ScrollText className="h-4 w-4 text-signal" aria-hidden />
              <h3 className="font-display text-sm font-bold uppercase tracking-wide-mc text-ink">API request ledger</h3>
              <span className="telemetry text-[10px] uppercase tracking-wide-mc text-faint">live · auto-refresh 30s</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <div className="flex flex-wrap gap-2 text-xs">
                {providers.map((p) => (
                  <button
                    key={p}
                    onClick={() => setProvider(provider === p ? 'all' : p)}
                    className={cn(
                      'rounded-sm border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide-mc transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-2',
                      provider === p ? 'border-nasa/50 bg-nasa/10 text-ink' : 'border-edge bg-panel-2/50 text-dim hover:border-iris/40 hover:bg-panel-2',
                    )}
                    style={{ outlineColor: 'var(--nasa)' }}
                    aria-pressed={provider === p}
                  >
                    {p}
                  </button>
                ))}
                {provider !== 'all' && (
                  <button
                    onClick={() => setProvider('all')}
                    className="rounded-sm border border-edge bg-panel-2/50 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide-mc text-faint transition-colors hover:text-ink"
                    aria-label="Clear provider filter"
                  >
                    clear filter ×
                  </button>
                )}
              </div>
            </div>
            <div className="mt-3 max-h-[28rem] overflow-x-auto overflow-y-auto rounded-sm border border-edge">
              <table className="mc-table w-full min-w-[52rem]">
                <thead className="sticky top-0 z-10 bg-panel">
                  <tr className="border-b border-edge">
                    <th className="px-2.5 py-2 text-left">Time</th>
                    <th className="px-2.5 py-2 text-left">Provider</th>
                    <th className="px-2.5 py-2 text-left">Operation</th>
                    <th className="px-2.5 py-2 text-left">Status</th>
                    <th className="px-2.5 py-2 text-left">Latency</th>
                    <th className="px-2.5 py-2 text-left">Bytes</th>
                    <th className="px-2.5 py-2 text-left">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((l) => (
                    <tr key={l.id} className="border-b border-edge/60 transition-colors last:border-b-0 hover:bg-panel-2/50">
                      <td className="telemetry whitespace-nowrap px-2.5 py-1.5 text-[10px]">{new Date(l.retrievedAt).toISOString().slice(11, 19)}</td>
                      <td className="px-2.5 py-1.5 text-dim">{l.provider}</td>
                      <td className="telemetry px-2.5 py-1.5 text-[10px]">{l.operation}</td>
                      <td className="px-2.5 py-1.5">
                        <span className="inline-flex items-center gap-1">
                          {l.ok ? <CheckCircle2 className="h-3 w-3 text-signal" aria-hidden /> : <XCircle className={cn('h-3 w-3', statusTone(l.status))} aria-hidden />}
                          <span className={cn('telemetry', statusTone(l.status))}>{l.status}</span>
                        </span>
                      </td>
                      <td className="telemetry px-2.5 py-1.5">{l.latencyMs} ms</td>
                      <td className="telemetry px-2.5 py-1.5">{l.responseBytes ? `${(l.responseBytes / 1024).toFixed(1)} kB` : '—'}</td>
                      <td className="max-w-[16rem] truncate px-2.5 py-1.5 text-[10px] text-faint" title={l.errorDetail ?? l.requestUrl}>
                        {l.errorDetail ?? l.requestUrl.slice(0, 80)}
                      </td>
                    </tr>
                  ))}
                  {logs.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-3 py-6 text-center text-faint">No requests logged for this filter.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </HudPanel>
        </motion.section>
          </>
        )}
      </QueryState>

      {/* Data-source register */}
      <motion.section variants={RISE} custom={3} initial="hidden" whileInView="show" viewport={{ once: true }} aria-label="Data-source register">
        <QueryState
          isLoading={provenance.isPending}
          isError={provenance.isError}
          error={provenance.error}
          onRetry={() => provenance.refetch()}
          label="Data-source register"
          skeleton={<SkeletonPanel label="Reading data-source register" rows={5} />}
          isEmpty={!!provenance.data && provenance.data.sources.length === 0}
          empty={<EmptyState label="Data-source register" hint="No sources registered." />}
        >
          <HudPanel>
            <div className="flex flex-wrap items-center gap-2">
              <Database className="h-4 w-4 text-aqua" aria-hidden />
              <h3 className="font-display text-sm font-bold uppercase tracking-wide-mc text-ink">Data-source register</h3>
              <span className="telemetry text-[10px] uppercase tracking-wide-mc text-faint">{provenance.data?.sources.length} datasets · full metadata</span>
            </div>
            <div className="mt-3 flex flex-col gap-3">
              {(provenance.data?.sources ?? []).map((s) => (
                <div key={s.id} className="rounded-sm border border-edge bg-panel-2/40 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-display text-sm font-semibold uppercase tracking-wide-mc text-ink">{s.datasetName}</span>
                    <StatusPill status={s.status} />
                    {s.authRequired && (
                      <span className="rounded-sm border border-caution/40 bg-caution/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide-mc text-caution">auth required</span>
                    )}
                  </div>
                  <dl className="mc-table mt-2 grid gap-x-6 gap-y-1 text-[11px] sm:grid-cols-2 lg:grid-cols-3">
                    <Row k="Provider" v={s.provider} />
                    <Row k="Product" v={s.productId ?? '—'} />
                    <Row k="Format" v={s.dataFormat} />
                    <Row k="Coverage" v={s.temporalCoverage} />
                    <Row k="Resolution" v={s.spatialResolution} />
                    <Row k="Units" v={s.units ?? '—'} />
                    <Row k="License" v={s.license} />
                    <Row k="Attribution" v={s.attribution} />
                    <Row k="Rate limits" v={s.rateLimit ?? '—'} />
                  </dl>
                  <p className="mt-2 text-[11px] leading-relaxed text-faint"><span className="text-dim">Limitations:</span> {s.limitations}</p>
                  <p className="telemetry mt-1 break-all text-[10px] text-faint">{s.endpointTemplate}</p>
                </div>
              ))}
            </div>
          </HudPanel>
        </QueryState>
      </motion.section>

      {/* Methodology pointer */}
      {provenance.data?.methodologyPointer && (
        <motion.section variants={RISE} custom={4} initial="hidden" whileInView="show" viewport={{ once: true }} aria-label="Methodology pointer">
          <HudPanel calm>
            <Kicker>Methodology</Kicker>
            <p className="mt-2 text-xs leading-relaxed text-dim">{provenance.data.methodologyPointer}</p>
          </HudPanel>
        </motion.section>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-faint">{k}</dt>
      <dd className="text-dim">{v}</dd>
    </div>
  );
}
