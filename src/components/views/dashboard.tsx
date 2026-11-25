'use client';

import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useSession } from '@/components/state/store';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiRequestError, type IngestOutcome } from '@/lib/api-client';
import { waitForJob } from '@/lib/jobs/client';
import { isRequestContextCurrent, requestContextKey, type RequestContext } from '@/lib/request-context';
import { logEvent } from '@/components/state/log-store';
import { downloadCsv, timestampSlug } from '@/lib/export';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { SectionHeader, StatusPill, TelemetryStat, HudPanel, CoordReadout } from '@/components/ui-mc/kit';
import { QueryState, FaultPanel, EmptyState, LoadingChip } from '@/components/system/query-state';
import { SkeletonPanel, SkeletonRows, StatSkeletonRow, SweepLoader } from '@/components/system/skeletons';
import { Download, MapPin, Database, Loader2, Activity, FileDown } from 'lucide-react';

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

/** Staggered section entrance (y 12→0, 0.35 s, ~60 ms stagger, once). */
function Reveal({ i = 0, className, children }: { i?: number; className?: string; children: React.ReactNode }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-24px' }}
      transition={{ duration: 0.35, delay: i * 0.06, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

/** Earth Intelligence Dashboard: coverage, indicators, ingestion control. */
export function DashboardView() {
  const { location, setLocation, activeFarmId, setView } = useSession();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const regions = useQuery({ queryKey: ['regions'], queryFn: api.regions });
  const status = useQuery({ queryKey: ['system-status'], queryFn: api.systemStatus, refetchInterval: 60_000 });

  const [ingestProgress, setIngestProgress] = useState<string | null>(null);
  const requestContext: RequestContext = activeFarmId
    ? { farmId: activeFarmId }
    : { farmId: null, lat: location.lat, lon: location.lon };
  const scope = requestContextKey(requestContext);
  const contextRef = useRef(requestContext);
  useEffect(() => {
    contextRef.current = activeFarmId
      ? { farmId: activeFarmId }
      : { farmId: null, lat: location.lat, lon: location.lon };
  }, [activeFarmId, location.lat, location.lon]);

  const ingest = useMutation({
    mutationFn: async () => {
      const submittedContext = contextRef.current;
      const accepted = await api.ingest(activeFarmId ? { farmId: activeFarmId, years: 12 } : { lat: location.lat, lon: location.lon, years: 12 });
      const result = await waitForJob<IngestOutcome>(accepted, {
        timeoutMs: 20 * 60_000,
        onProgress: ({ progressNote }) => setIngestProgress(progressNote),
      });
      return { submittedContext, result };
    },
    onSuccess: ({ submittedContext, result: res }) => {
      if (!isRequestContextCurrent(submittedContext, contextRef.current)) return;
      setIngestProgress(null);
      const idempotent = res.rowsWritten === 0 && res.validPoints > 0;
      toast({
        title: idempotent ? 'POWER record already current' : 'NASA POWER record ingested',
        description: idempotent
          ? `0 new rows — all ${res.validPoints.toLocaleString()} real points for this window are already stored (idempotent upsert on variable+date). Re-verified against POWER ${res.start} → ${res.end}.`
          : `${res.rowsWritten.toLocaleString()} real observations stored (${res.start} → ${res.end}); ${res.missingPoints} missing days reported.`,
      });
      logEvent({
        severity: 'success',
        category: 'INGEST',
        title: idempotent ? 'POWER record already current' : 'NASA POWER record ingested',
        detail: idempotent
          ? `Idempotent re-ingest for ${location.label}: ${res.validPoints.toLocaleString()} real points re-verified from POWER (${res.start} → ${res.end}); 0 new rows because every variable+date is already stored. Nothing duplicated, nothing fabricated.`
          : `${res.rowsWritten.toLocaleString()} real observations for ${location.label} (${res.start} → ${res.end}); ${res.missingPoints} missing days reported as missing.`,
        view: 'dashboard',
      });
      queryClient.invalidateQueries({ queryKey: ['system-status'] });
      queryClient.invalidateQueries({ queryKey: ['observations'] });
    },
    onError: (err) => {
      setIngestProgress(null);
      toast({
        title: 'POWER ingestion failed',
        description: err instanceof ApiRequestError ? err.message : 'Unexpected error. No data fabricated.',
        variant: 'destructive',
      });
      logEvent({
        severity: 'crit',
        category: 'INGEST',
        title: 'POWER ingestion failed',
        detail: err instanceof ApiRequestError ? `${err.code} — ${err.message}` : 'Unexpected error; no data fabricated.',
        correlationId: err instanceof ApiRequestError ? err.correlationId : undefined,
        view: 'dashboard',
      });
    },
  });

  const resetIngest = ingest.reset;
  useEffect(() => {
    resetIngest();
  }, [scope, resetIngest]);

  const obs = useQuery({
    queryKey: ['observations', activeFarmId, location.lat, location.lon],
    queryFn: ({ signal }) => api.observations(activeFarmId ? { farmId: activeFarmId, signal } : { lat: location.lat, lon: location.lon, signal }),
    enabled: !ingest.isPending,
  });

  const recentIngest = obs.data;
  const seriesEntries = Object.entries(obs.data?.series ?? {});

  const exportObservations = () => {
    if (!obs.data) return;
    const rows: unknown[][] = [];
    for (const [variable, s] of seriesEntries) {
      for (const p of s.points) rows.push([variable, p.date, p.value === null ? '' : p.value, s.unit]);
    }
    downloadCsv(`terrafield-observations-${timestampSlug()}`, ['variable', 'date', 'value', 'unit'], rows);
    logEvent({
      severity: 'info',
      category: 'EXPORT',
      title: 'Observations exported as CSV',
      detail: `${rows.length.toLocaleString()} stored rows for ${location.label} — missing days exported as empty cells, never substituted.`,
      view: 'dashboard',
    });
    toast({ title: 'Observations exported', description: `${rows.length.toLocaleString()} stored rows written to CSV (${obs.data.datasetVersions.join(', ') || 'source version pending'}).` });
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      {/* View header — geography controls live in the actions rail */}
      <Reveal>
        <SectionHeader
          kicker="Mission console · Earth intelligence"
          title="Earth Intelligence"
          description="Real NASA POWER meteorology for the selected geography. Every stored number is traceable to its source and retrieval time; missing days are reported as missing, never fabricated."
          actions={
            <div className="flex flex-wrap items-center gap-2.5">
              <Select
                value={location.label}
                onValueChange={(v) => {
                  const r = regions.data?.regions.find((x) => `${x.name}` === v);
                  if (r) setLocation({ lat: r.lat, lon: r.lon, label: r.name, country: r.country, context: r.croppingContext });
                }}
              >
                <SelectTrigger
                  className="h-9 w-full max-w-full border-edge bg-panel text-xs text-dim sm:w-72"
                  aria-label="Select demo region"
                  disabled={regions.isLoading}
                >
                  <SelectValue placeholder={regions.isLoading ? 'Loading presets…' : 'Choose a region preset'} />
                </SelectTrigger>
                <SelectContent className="max-h-72 border-edge bg-popover text-dim">
                  {(regions.data?.regions ?? []).map((r) => (
                    <SelectItem key={r.key} value={r.name} className="text-xs">
                      {r.name} · {r.country}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <CoordReadout lat={location.lat} lon={location.lon} />
              {activeFarmId && (
                <StatusPill status="farm-linked" pulse={false} className="border-signal/40 text-signal" />
              )}
              {regions.isLoading && <LoadingChip label="loading presets" />}
            </div>
          }
        />
      </Reveal>

      {/* Geography context */}
      <Reveal i={1}>
        <HudPanel calm className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <MapPin className="h-4 w-4 text-aqua" aria-hidden />
            <h3 className="font-display text-sm font-semibold uppercase tracking-wide-mc text-ink">Selected geography</h3>
          </div>
          {regions.isError ? (
            <FaultPanel error={regions.error} onRetry={() => regions.refetch()} label="Region presets" />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <p className="text-sm text-ink">{location.label}</p>
                {location.country && (
                  <span className="font-mono text-[10px] uppercase tracking-wide-mc text-faint">{location.country}</span>
                )}
              </div>
              {location.context && <p className="max-w-3xl text-xs leading-relaxed text-dim">{location.context}</p>}
              <p className="max-w-3xl text-[11px] text-faint">
                Curated real-region presets for the public demo; the map in the Geospatial Explorer lets you pick any coordinate.
              </p>
            </>
          )}
        </HudPanel>
      </Reveal>

      {/* Ingestion control */}
      <Reveal i={2}>
        <HudPanel calm className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Download className="h-4 w-4 text-nasa" aria-hidden />
            <h3 className="font-display text-sm font-semibold uppercase tracking-wide-mc text-ink">
              Environmental record ingestion
            </h3>
          </div>
          <p className="max-w-3xl text-xs leading-relaxed text-dim">
            Fetches the real NASA POWER daily record (precipitation, min/mean/max temperature, solar radiation,
            humidity, root-zone wetness) for the selected coordinate in 5-year chunks, and stores it with full
            provenance. Runs ~10–30 s.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={() => ingest.mutate()}
              disabled={ingest.isPending}
              data-tour="dash-ingest"
              className="h-9 font-mono text-xs uppercase tracking-wide-mc"
            >
              {ingest.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
                  Processing POWER…
                </>
              ) : (
                'Ingest 12-year record'
              )}
            </Button>
            {!ingest.isPending && !ingest.isError && (
              <span className="font-mono text-[10px] uppercase tracking-wide-mc text-faint">
                power · daily · provenance logged
              </span>
            )}
          </div>
          {ingest.isPending && (
            <div className="flex flex-col gap-2" role="status" aria-live="polite">
              <SweepLoader label="Processing durable POWER ingestion" />
              <p className="font-mono text-[10px] uppercase tracking-wide-mc text-faint">
                {ingestProgress ?? 'queued · 5-year chunks · progress is read from the durable job ledger'}
              </p>
            </div>
          )}
          {ingest.isError && (
            <FaultPanel error={ingest.error} onRetry={() => ingest.mutate()} label="POWER ingestion" />
          )}
        </HudPanel>
      </Reveal>

      {/* Coverage telemetry */}
      <Reveal i={3}>
        <QueryState
          isLoading={status.isLoading}
          isError={status.isError}
          error={status.error}
          onRetry={() => status.refetch()}
          label="System telemetry"
          skeleton={<StatSkeletonRow count={4} />}
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <TelemetryStat
              label="Stored observations"
              value={(status.data?.database.observations ?? 0).toLocaleString()}
              hint="real NASA POWER values"
            />
            <TelemetryStat
              label="Fire detections"
              value={(status.data?.database.fireDetections ?? 0).toLocaleString()}
              hint="VIIRS 375 m, 2015→present"
            />
            <TelemetryStat
              label="Record start"
              value={recentIngest?.series?.PRECTOTCORR?.points?.[0]?.date?.slice(0, 4) ?? null}
              hint={recentIngest?.datasetVersions?.[0] ?? 'no record yet'}
            />
            <TelemetryStat
              label="Farms configured"
              value={String(status.data?.database.farms ?? 0)}
              hint="profiles with soil + scenarios"
            />
          </div>
        </QueryState>
      </Reveal>

      {/* Source register status */}
      <Reveal i={4}>
        <HudPanel calm className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-aqua" aria-hidden />
            <h3 className="font-display text-sm font-semibold uppercase tracking-wide-mc text-ink">
              Data-source status
            </h3>
          </div>
          {status.isLoading ? (
            <SkeletonRows rows={3} />
          ) : status.data ? (
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {Object.entries(status.data.providers).map(([provider, info]) => (
                <li
                  key={provider}
                  className="flex flex-col gap-1.5 rounded-sm border border-edge bg-panel-2/50 px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[11px] uppercase tracking-wide-mc text-ink">{provider}</span>
                    <StatusPill status={info.status} />
                  </div>
                  {info.note && <p className="text-[11px] leading-relaxed text-faint">{info.note}</p>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="font-mono text-[11px] text-caution">source status unavailable — see telemetry fault above</p>
          )}
        </HudPanel>
      </Reveal>

      {/* Recent observations & data coverage */}
      <Reveal i={5}>
        <HudPanel calm className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Database className="h-4 w-4 text-aqua" aria-hidden />
            <h3 className="font-display text-sm font-semibold uppercase tracking-wide-mc text-ink">
              Recent observations &amp; data coverage
            </h3>
            <Button
              variant="outline"
              size="sm"
              onClick={exportObservations}
              disabled={!obs.data || seriesEntries.length === 0}
              className="ml-auto h-7 gap-1.5 border-edge bg-transparent font-mono text-[10px] uppercase tracking-wide-mc text-dim hover:border-aqua/50 hover:text-aqua"
              aria-label="Export stored observations as CSV"
              title="Export the stored real observations (with missing days as empty cells) as CSV"
            >
              <FileDown className="h-3 w-3" aria-hidden />
              Export CSV
            </Button>
          </div>
          <QueryState
            isLoading={obs.isLoading}
            isError={obs.isError}
            error={obs.error}
            onRetry={() => obs.refetch()}
            label="Observation coverage"
            skeleton={<SkeletonPanel rows={6} label="Loading observation coverage" />}
            isEmpty={obs.data ? seriesEntries.length === 0 : false}
            empty={
              <EmptyState
                label="Observation store"
                hint="No observations stored for this location yet — run the ingestion above, then head to Environmental Analysis to detect trends."
                action={
                  <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
                    <Button
                      onClick={() => ingest.mutate()}
                      disabled={ingest.isPending}
                      className="h-8 font-mono text-[11px] uppercase tracking-wide-mc"
                    >
                      {ingest.isPending ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
                          Processing POWER…
                        </>
                      ) : (
                        'Ingest POWER record'
                      )}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => setView('analysis')}
                      className="h-8 border-edge bg-transparent font-mono text-[11px] uppercase tracking-wide-mc text-dim hover:text-ink"
                    >
                      Open analysis
                    </Button>
                  </div>
                }
              />
            }
          >
            <div className="max-h-96 overflow-x-auto overflow-y-auto rounded-sm border border-edge">
              <table className="mc-table w-full">
                <thead className="sticky top-0 z-10 bg-panel">
                  <tr className="border-b border-edge">
                    <th className="px-3 py-2 text-left">Variable</th>
                    <th className="px-3 py-2 text-right">Days</th>
                    <th className="px-3 py-2 text-right">Latest value</th>
                    <th className="px-3 py-2 text-left">Unit</th>
                    <th className="px-3 py-2 text-left">Latest date</th>
                  </tr>
                </thead>
                <tbody>
                  {seriesEntries.map(([variable, s]) => {
                    const last = [...s.points].reverse().find((p) => p.value !== null);
                    return (
                      <tr key={variable} className="border-b border-edge/60 last:border-0 hover:bg-panel-2/40">
                        <td className="px-3 py-2 font-mono text-[11px] uppercase tracking-wide-mc text-aqua">{variable}</td>
                        <td className="telemetry px-3 py-2 text-right text-dim">{s.points.length}</td>
                        <td className="telemetry px-3 py-2 text-right text-ink">
                          {last && last.value !== null ? (
                            last.value.toFixed(1)
                          ) : (
                            <span className="text-caution">n/a</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-faint">{s.unit}</td>
                        <td className="telemetry px-3 py-2 text-faint">{last?.date ?? 'no valid value'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-faint">
              Latest valid (non-missing) daily value per variable. Missing points lower confidence and are counted —
              never substituted.
            </p>
          </QueryState>
        </HudPanel>
      </Reveal>
    </div>
  );
}
