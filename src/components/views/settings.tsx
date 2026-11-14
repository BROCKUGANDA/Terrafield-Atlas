'use client';

import { useEffect, useState } from 'react';
import { motion, type Variants } from 'framer-motion';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { logEvent } from '@/components/state/log-store';
import { downloadCsv, timestampSlug } from '@/lib/export';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { Kicker, SectionHeader, StatusPill, TelemetryStat, HudPanel } from '@/components/ui-mc/kit';
import { QueryState, FaultPanel } from '@/components/system/query-state';
import { SkeletonPanel, StatSkeletonRow } from '@/components/system/skeletons';
import { Settings, Activity, Database, Zap, RefreshCw, ServerCog, ShieldAlert, FileDown, Compass } from 'lucide-react';
import { useTourStore } from '@/components/state/tour-store';
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

/** Live cooldown countdown for an open circuit breaker (mono, ticks down). */
function Cooldown({ provider, ms }: { provider: string; ms: number }) {
  const [s, setS] = useState(() => Math.max(0, Math.ceil(ms / 1000)));
  useEffect(() => {
    const t = setInterval(() => setS((v) => Math.max(0, v - 1)), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span role="status" className="inline-flex items-center gap-2 rounded-sm border border-crit/40 bg-crit/10 px-2 py-1 font-mono text-[10px] uppercase tracking-wide-mc text-crit">
      <ShieldAlert className="h-3 w-3" aria-hidden /> circuit open · {provider} · cooldown <span className="telemetry text-ink">{s}s</span>
    </span>
  );
}

/** Settings & System Health. */
export function SettingsView() {
  const status = useQuery({ queryKey: ['system-status'], queryFn: api.systemStatus, refetchInterval: 30_000 });
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { start: startTour, status: tourStatus } = useTourStore();

  const invalidate = useMutation({
    mutationFn: async () => {
      await fetch('/api/v1/system/status?action=invalidate-cache', { method: 'POST' });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['system-status'] });
      toast({ title: 'Cache invalidated', description: 'Provider responses will be re-fetched on next use.' });
      logEvent({
        severity: 'info',
        category: 'SYSTEM',
        title: 'Provider response cache invalidated',
        detail: 'Operations request accepted — provider responses will be re-fetched with fresh retrieval times on next use.',
        view: 'settings',
      });
    },
    onError: () => {
      toast({ title: 'Cache invalidation failed', description: 'The operations request did not complete.', variant: 'destructive' });
      logEvent({
        severity: 'warn',
        category: 'SYSTEM',
        title: 'Cache invalidation request failed',
        detail: 'The operations request did not complete; cached provider responses remain in force.',
        view: 'settings',
      });
    },
  });

  const exportSystemSnapshot = () => {
    const d = status.data;
    if (!d) return;
    const rows = Object.entries(d.providers).map(([name, info]) => [name, info.status, info.note ?? '']);
    downloadCsv(
      `terrafield-system-snapshot-${timestampSlug()}`,
      ['provider', 'status', 'note'],
      rows,
    );
    logEvent({
      severity: 'info',
      category: 'EXPORT',
      title: 'System health snapshot exported as CSV',
      detail: `Engines: ${d.engines.trendEngine.split(',')[0]}… · providers: ${rows.map((r) => `${r[0]}=${r[1]}`).join(', ')}. Snapshot of a live poll, timestamped in the filename.`,
      view: 'settings',
    });
    toast({ title: 'System snapshot exported', description: 'Provider availability snapshot written to CSV.' });
  };

  const s = status.data;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6" id="system-health">
      <motion.div variants={RISE} custom={0} initial="hidden" whileInView="show" viewport={{ once: true }}>
        <SectionHeader
          kicker="Trust & Systems // Console Status"
          title="System Health"
          description="Engines, database counts, response cache, circuit breakers and provider availability — the operational state behind every number in the console."
          actions={
            <div className="flex flex-wrap items-center gap-2.5">
              <Button
                variant="outline"
                size="sm"
                className={cn('h-8 uppercase', MONO_BTN)}
                onClick={() => status.refetch()}
                disabled={status.isFetching}
              >
                {status.isFetching ? (
                  <>
                    <span className="anim-blink h-1.5 w-1.5 rounded-full bg-aqua" aria-hidden /> Polling…
                  </>
                ) : (
                  <>
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Refresh status
                  </>
                )}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={exportSystemSnapshot}
                disabled={!status.data}
                className={cn('h-8 uppercase', MONO_BTN)}
                aria-label="Export the system health snapshot as CSV"
              >
                <FileDown className="h-3.5 w-3.5" aria-hidden /> Export snapshot
              </Button>
            </div>
          }
        />
      </motion.div>

      <QueryState
        isLoading={status.isPending}
        isError={status.isError}
        error={status.error}
        onRetry={() => status.refetch()}
        label="System status"
        skeleton={
          <div className="flex flex-col gap-4" role="status" aria-live="polite">
            <StatSkeletonRow count={4} />
            <SkeletonPanel label="Polling providers" rows={6} />
          </div>
        }
      >
        {s && (
          <>
            {/* Telemetry: data store + cache */}
            <motion.section variants={RISE} custom={1} initial="hidden" whileInView="show" viewport={{ once: true }} aria-label="Data store telemetry">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <TelemetryStat label="Observations" value={s.database.observations.toLocaleString()} hint="NASA POWER rows stored" />
                <TelemetryStat label="Fire detections" value={s.database.fireDetections.toLocaleString()} hint="VIIRS rows stored" />
                <TelemetryStat label="Farms" value={s.database.farms} hint="operator profiles" />
                <TelemetryStat label="Cache live" value={s.cache.liveEntries} hint={`${s.cache.expiredEntries} expired · max ${s.cache.maxEntries}`} />
              </div>
            </motion.section>

            {/* Engines + reliability */}
            <motion.section variants={RISE} custom={2} initial="hidden" whileInView="show" viewport={{ once: true }} className="grid gap-4 sm:grid-cols-2" aria-label="Engines and reliability controls">
              <HudPanel>
                <div className="flex items-center gap-2">
                  <Database className="h-4 w-4 text-aqua" aria-hidden />
                  <h3 className="font-display text-sm font-bold uppercase tracking-wide-mc text-ink">Engines & data store</h3>
                </div>
                <div className="mt-3 flex flex-col gap-1.5">
                  <Row k="Trend engine" v={s.engines.trendEngine} mono />
                  <Row k="Rotation engine" v={s.engines.rotationEngine} mono />
                  <Row k="Crop catalogue" v={s.engines.cropCatalogue} mono />
                  <Row k="Fire watchlists" v={`${s.database.fireWatchlists} defined · ${s.database.fireWatchEvents} evaluation(s) recorded`} />
                  <Row k="Jobs" v={(s.database.jobCounts ?? []).map((j) => `${j.count} ${j.status}`).join(', ') || 'none'} />
                </div>
              </HudPanel>

              <HudPanel>
                <div className="flex items-center gap-2">
                  <Zap className="h-4 w-4 text-caution" aria-hidden />
                  <h3 className="font-display text-sm font-bold uppercase tracking-wide-mc text-ink">Reliability controls</h3>
                </div>
                <div className="mt-3 flex flex-col gap-1.5">
                  {Object.entries(s.reliability ?? {}).map(([k, v]) => <Row key={k} k={k} v={v} />)}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <span className="telemetry rounded-sm border border-edge bg-panel-2/60 px-2 py-0.5 text-[10px] uppercase tracking-wide-mc text-dim">
                    cache {s.cache.liveEntries} live / {s.cache.expiredEntries} expired
                  </span>
                  {(s.circuitBreakers ?? []).filter((c) => c.open).map((c) => (
                    <Cooldown key={c.provider} provider={c.provider} ms={c.cooldownRemainingMs} />
                  ))}
                  {(s.circuitBreakers ?? []).filter((c) => !c.open && c.consecutiveFailures > 0).map((c) => (
                    <span key={c.provider} className="inline-flex items-center gap-2 rounded-sm border border-caution/40 bg-caution/10 px-2 py-1 font-mono text-[10px] uppercase tracking-wide-mc text-caution">
                      {c.provider}: {c.consecutiveFailures} recent failure(s)
                    </span>
                  ))}
                </div>
              </HudPanel>
            </motion.section>

            {/* Provider availability */}
            <motion.section variants={RISE} custom={3} initial="hidden" whileInView="show" viewport={{ once: true }} aria-label="Provider availability">
              <HudPanel>
                <div className="flex flex-wrap items-center gap-2">
                  <Activity className="h-4 w-4 text-signal" aria-hidden />
                  <h3 className="font-display text-sm font-bold uppercase tracking-wide-mc text-ink">Provider availability</h3>
                  <span className="telemetry text-[10px] uppercase tracking-wide-mc text-faint">polled every 30s</span>
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {Object.entries(s.providers ?? {}).map(([name, p]) => (
                    <div key={name} className="rounded-sm border border-edge bg-panel-2/40 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-display text-sm font-semibold uppercase tracking-wide-mc text-ink">{name}</span>
                        <StatusPill status={p.status.split(' ')[0]} pulse={!p.status.startsWith('operational')} />
                      </div>
                      <p className="mt-1.5 text-[11px] leading-relaxed text-faint">{p.status}{p.note ? ` — ${p.note}` : ''}</p>
                    </div>
                  ))}
                </div>
              </HudPanel>
            </motion.section>

            {/* Failed ingestion jobs — crit */}
            {(s.database.failedJobs.length ?? 0) > 0 && (
              <motion.section variants={RISE} custom={4} initial="hidden" whileInView="show" viewport={{ once: true }} aria-label="Failed ingestion jobs">
                <HudPanel calm={false} className="border-crit/40">
                  <div className="flex items-center gap-2">
                    <ShieldAlert className="h-4 w-4 text-crit" aria-hidden />
                    <h3 className="font-display text-sm font-bold uppercase tracking-wide-mc text-crit">Failed ingestion jobs</h3>
                  </div>
                  <div className="mt-3 flex flex-col gap-1.5">
                    {s.database.failedJobs.map((j) => (
                      <div key={j.id} className="telemetry text-[11px] leading-relaxed text-dim">
                        [{j.type}] <span className="text-crit">{j.error}</span> — {new Date(j.startedAt).toISOString().slice(0, 19).replace('T', ' ')}
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 text-[10px] text-faint">Failures are surfaced, not retried silently or masked with substitute data.</p>
                </HudPanel>
              </motion.section>
            )}

            {/* Operations */}
            <motion.section variants={RISE} custom={5} initial="hidden" whileInView="show" viewport={{ once: true }} aria-label="Operations">
              <HudPanel>
                <div className="flex items-center gap-2">
                  <ServerCog className="h-4 w-4 text-iris" aria-hidden />
                  <h3 className="font-display text-sm font-bold uppercase tracking-wide-mc text-ink">Operations</h3>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" className={cn('h-8 uppercase', MONO_BTN)} onClick={() => invalidate.mutate()} disabled={invalidate.isPending}>
                    {invalidate.isPending ? (
                      <>
                        <span className="anim-blink h-1.5 w-1.5 rounded-full bg-caution" aria-hidden /> Invalidating…
                      </>
                    ) : (
                      <>
                        <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Invalidate response cache
                      </>
                    )}
                  </Button>
                  <Button variant="outline" size="sm" className={cn('h-8 uppercase', MONO_BTN)} onClick={() => queryClient.invalidateQueries()}>
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Refresh all dashboard data
                  </Button>
                </div>
                <div data-tour="settings-tour" className="mt-4 flex flex-wrap items-center gap-3 rounded-sm border border-edge bg-panel-2/40 p-3">
                  <Compass className="h-4 w-4 text-nasa" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-[10px] uppercase tracking-wide-mc text-dim">Guided first-run tour</p>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-faint">
                      Currently: <span className="text-dim">{tourStatus === 'active' ? 'running' : tourStatus}</span>. The 17-step
                      walkthrough of every console module — restart it any time.
                    </p>
                  </div>
                  <Button size="sm" onClick={() => { startTour(); toast({ title: 'Guided tour restarted', description: 'The walkthrough starts at the first step — Esc leaves it at any time.' }); }} className={cn('h-8 uppercase', MONO_BTN)}>
                    <Compass className="h-3.5 w-3.5" aria-hidden /> Restart tour
                  </Button>
                </div>
              </HudPanel>
            </motion.section>

            {/* Methodology (as executed) */}
            <motion.section variants={RISE} custom={6} initial="hidden" whileInView="show" viewport={{ once: true }} aria-label="Methodology">
              <HudPanel>
                <div className="flex items-center gap-2">
                  <Settings className="h-4 w-4 text-dim" aria-hidden />
                  <h3 className="font-display text-sm font-bold uppercase tracking-wide-mc text-ink">Methodology (as executed)</h3>
                </div>
                <div className="mt-3 flex flex-col gap-2">
                  <p className="text-xs leading-relaxed text-dim"><span className="font-medium text-ink">Trend detection:</span> {s.methodology.trend}</p>
                  <p className="text-xs leading-relaxed text-dim"><span className="font-medium text-ink">Rotation scoring:</span> {s.methodology.rotation}</p>
                </div>
              </HudPanel>
            </motion.section>
          </>
        )}
      </QueryState>
    </div>
  );
}

function Row({ k, v, mono = false }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-edge/60 pb-1">
      <span className="font-mono text-[10px] uppercase tracking-wide-mc text-faint">{k}</span>
      <span className={cn('text-right text-xs break-all text-dim', mono && 'telemetry text-[11px]')}>{v}</span>
    </div>
  );
}
