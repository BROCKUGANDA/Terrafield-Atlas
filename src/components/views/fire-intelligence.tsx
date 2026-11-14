'use client';

import React from 'react';
import { useState } from 'react';
import { motion } from 'framer-motion';
import { useSession } from '@/components/state/store';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api, ApiRequestError, type FireQueryResponse } from '@/lib/api-client';
import { logEvent } from '@/components/state/log-store';
import { downloadCsv, timestampSlug } from '@/lib/export';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { FireCalendarChart } from '@/components/charts/scientific-charts';
import { SectionHeader, StatusPill, TelemetryStat, HudPanel, CoordReadout } from '@/components/ui-mc/kit';
import { QueryState, FaultPanel, EmptyState } from '@/components/system/query-state';
import { StatSkeletonRow, SkeletonPanel, SweepLoader } from '@/components/system/skeletons';
import { Flame, Loader2, Download, ShieldAlert, MapPin, FileDown } from 'lucide-react';

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

const CONFIDENCE_TONE: Record<string, string> = {
  high: 'border-crit/40 text-crit',
  nominal: 'border-caution/40 text-caution',
};

/** Staggered section entrance (y 12→0, 0.35 s, ~60 ms stagger, once). */
function Reveal({ i = 0, className, children }: { i?: number; className?: string; children: React.ReactNode }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-24px' }}
      transition={{ duration: 0.35, delay: Math.min(i, 8) * 0.06, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[9px] uppercase tracking-wide-mc text-faint">{label}</span>
      {children}
    </label>
  );
}

/** Fire Intelligence: VIIRS 375 m detections (GIBS stream), calendar, confidence. */
export function FireIntelligenceView() {
  const { location, setView, setFireDetectionsGeoJson } = useSession();
  const { toast } = useToast();

  const [range, setRange] = useState(() => {
    const to = new Date('2026-11-01');
    const from = new Date(to.getTime() - 86_400_000 * 30);
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
  });
  const [confidence, setConfidence] = useState<string>('all');
  const [queryKey, setQueryKey] = useState(0);

  const ingest = useMutation({
    mutationFn: () => api.ingestFires({ lat: location.lat, lon: location.lon, from: range.from, to: range.to }),
    onSuccess: (res) => {
      toast({
        title: 'VIIRS fire record ingested',
        description: `${res.totalDetections.toLocaleString()} real detections decoded from GIBS vector tiles (${res.rowsWritten.toLocaleString()} new rows)${res.noDataDays.length ? `; ${res.noDataDays.length} day(s) had no archive data (reported, not fabricated)` : ''}.`,
      });
      logEvent({
        severity: 'success',
        category: 'FIRE',
        title: 'VIIRS fire detections ingested',
        detail: `${res.totalDetections.toLocaleString()} real detections decoded from GIBS vector tiles (${res.rowsWritten.toLocaleString()} new rows) for ${location.label}, ${range.from} → ${range.to}.${res.noDataDays.length ? ` ${res.noDataDays.length} day(s) had no archive data — reported as missing, not fabricated.` : ''}`,
        view: 'fire',
      });
      setQueryKey((k) => k + 1);
    },
    onError: (err) => {
      toast({ title: 'Fire ingestion failed', description: err instanceof ApiRequestError ? err.message : 'error', variant: 'destructive' });
      logEvent({
        severity: 'crit',
        category: 'FIRE',
        title: 'VIIRS fire ingestion failed',
        detail: err instanceof ApiRequestError ? `${err.code} — ${err.message}` : 'Unexpected error; no detections written.',
        correlationId: err instanceof ApiRequestError ? err.correlationId : undefined,
        view: 'fire',
      });
    },
  });

  const fires = useQuery({
    queryKey: ['fires', location.lat, location.lon, range.from, range.to, confidence, queryKey],
    queryFn: () => api.fires({ lat: location.lat, lon: location.lon, from: range.from, to: range.to, confidence: confidence === 'all' ? undefined : confidence }),
  });

  const showOnMap = (data: FireQueryResponse) => {
    setFireDetectionsGeoJson({
      type: 'FeatureCollection',
      features: data.detections.map((d) => ({
        type: 'Feature',
        properties: { confidence: d.confidence, date: d.date, frp: d.frp },
        geometry: { type: 'Point', coordinates: [d.longitude, d.latitude] },
      })),
    });
    setView('explorer');
  };

  const exportDetections = () => {
    const d = fires.data;
    if (!d) return;
    const rows = d.detections.map((det) => [
      det.date,
      det.time,
      det.latitude,
      det.longitude,
      det.confidence,
      det.dayNight === 'D' ? 'day' : 'night',
      det.frp ?? '',
      det.brightTi4 ?? '',
      det.sensor,
    ]);
    downloadCsv(
      `terrafield-fire-detections-${timestampSlug()}`,
      ['date', 'timeUtc', 'latitude', 'longitude', 'confidence', 'dayNight', 'frpMW', 'brightTi4K', 'sensor'],
      rows,
    );
    logEvent({
      severity: 'info',
      category: 'EXPORT',
      title: 'Fire detections exported as CSV',
      detail: `${rows.length} VIIRS 375 m detections for ${location.label}${d.truncated ? ' (API window truncated — the export covers exactly what the ledger shows)' : ''}. Source: ${d.source}.`,
      view: 'fire',
    });
    toast({ title: 'Detections exported', description: `${rows.length} real VIIRS rows written to CSV.` });
  };

  const rangeInvalid = range.to < range.from;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      {/* View header */}
      <Reveal>
        <SectionHeader
          kicker="Mission console · Thermal anomaly surveillance"
          title="Fire Intelligence"
          description="VIIRS 375 m active-fire detections for the selected geography, decoded from the NASA GIBS vector-tile stream. Detections are observations of active thermal anomalies — never presented as agricultural causation."
          actions={
            <div className="flex flex-wrap items-center gap-2.5">
              <MapPin className="h-3.5 w-3.5 text-caution" aria-hidden />
              <span className="font-mono text-[11px] text-dim">{location.label}</span>
              <CoordReadout lat={location.lat} lon={location.lon} />
            </div>
          }
        />
      </Reveal>

      {/* Query controls */}
      <Reveal i={1}>
        <HudPanel calm className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-2.5">
            <Field label="From">
              <Input
                type="date"
                value={range.from}
                min="2015-01-01"
                max="2026-11-14"
                onChange={(e) => setRange({ ...range, from: e.target.value })}
                className="telemetry h-9 w-40 border-edge bg-panel text-xs text-dim"
                aria-label="Range start date"
              />
            </Field>
            <Field label="To">
              <Input
                type="date"
                value={range.to}
                min="2015-01-01"
                max="2026-11-14"
                onChange={(e) => setRange({ ...range, to: e.target.value })}
                className="telemetry h-9 w-40 border-edge bg-panel text-xs text-dim"
                aria-label="Range end date"
              />
            </Field>
            <Field label="Confidence">
              <Select value={confidence} onValueChange={(v) => setConfidence(v)}>
                <SelectTrigger className="h-9 w-36 border-edge bg-panel text-xs text-dim" aria-label="Confidence filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-edge bg-popover text-dim">
                  <SelectItem value="all" className="text-xs">all</SelectItem>
                  <SelectItem value="high" className="text-xs">high</SelectItem>
                  <SelectItem value="nominal" className="text-xs">nominal</SelectItem>
                  <SelectItem value="low" className="text-xs">low</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Button
              onClick={() => ingest.mutate()}
              disabled={ingest.isPending || rangeInvalid}
              className="h-9 font-mono text-xs uppercase tracking-wide-mc"
            >
              {ingest.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
                  Decoding VIIRS tiles…
                </>
              ) : (
                <>
                  <Download className="h-3.5 w-3.5" aria-hidden />
                  Ingest detections (≤ 40 days)
                </>
              )}
            </Button>
          </div>
          {rangeInvalid && (
            <p className="font-mono text-[10px] uppercase tracking-wide-mc text-caution" role="alert">
              range end precedes range start — ingest disabled
            </p>
          )}
          <p className="max-w-3xl text-[11px] leading-relaxed text-faint">
            Detections are decoded server-side from NASA GIBS <span className="font-mono text-dim">VIIRS_SNPP_Thermal_Anomalies_375m_All</span> vector
            tiles — the same VIIRS detection stream NASA FIRMS distributes. The FIRMS CSV API itself is unreachable
            from this deployment sandbox and is health-flagged, never faked.
          </p>
          {ingest.isPending && (
            <div className="flex flex-col gap-2" role="status" aria-live="polite">
              <SweepLoader label="Decoding VIIRS tiles" />
              <p className="font-mono text-[10px] uppercase tracking-wide-mc text-faint">
                gibs vector tiles in flight · archive gaps will be reported, never zero-filled
              </p>
            </div>
          )}
          {ingest.isError && (
            <FaultPanel error={ingest.error} onRetry={() => ingest.mutate()} label="VIIRS ingestion" />
          )}
        </HudPanel>
      </Reveal>

      {/* Results */}
      <Reveal i={2}>
        <QueryState
          isLoading={fires.isLoading}
          isError={fires.isError}
          error={fires.error}
          onRetry={() => fires.refetch()}
          label="Fire detections"
          skeleton={
            <div className="flex flex-col gap-4">
              <StatSkeletonRow count={4} />
              <SkeletonPanel rows={6} label="Loading fire calendar" />
            </div>
          }
          isEmpty={fires.data ? fires.data.count === 0 : false}
          empty={
            <EmptyState
              label="Fire detections"
              hint="No detections stored for this range/location yet. Ingest the range above (fire-prone season and region show real activity, e.g. Southern Africa Jul–Oct, or check the Zambia preset)."
              action={
                <Button
                  onClick={() => ingest.mutate()}
                  disabled={ingest.isPending || rangeInvalid}
                  className="mt-2 h-8 font-mono text-[11px] uppercase tracking-wide-mc"
                >
                  {ingest.isPending ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
                      Decoding VIIRS tiles…
                    </>
                  ) : (
                    'Ingest this range'
                  )}
                </Button>
              }
            />
          }
        >
          {fires.data && (
            <div className="flex flex-col gap-4">
              {/* Distribution telemetry */}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <TelemetryStat
                  label="Detections in range"
                  value={fires.data.count.toLocaleString()}
                  hint="VIIRS 375 m stored rows"
                />
                <TelemetryStat
                  label="High confidence"
                  value={fires.data.confidenceDistribution.high}
                  hint="high-confidence class"
                />
                <TelemetryStat
                  label="Nominal confidence"
                  value={fires.data.confidenceDistribution.nominal}
                  hint="nominal-confidence class"
                />
                <TelemetryStat
                  label="Mean FRP"
                  value={fires.data.frpStats ? fires.data.frpStats.meanMW : null}
                  unit="MW"
                  hint={fires.data.frpStats ? `min ${fires.data.frpStats.minMW} MW · n ${fires.data.frpStats.count}` : 'no valid FRP rows'}
                />
              </div>
              <p className="telemetry px-1 text-[11px] text-faint">
                confidence distribution — low {fires.data.confidenceDistribution.low} · nominal{' '}
                {fires.data.confidenceDistribution.nominal} · high {fires.data.confidenceDistribution.high} · source{' '}
                {fires.data.source}
              </p>

              {/* Fire calendar */}
              <HudPanel calm className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <Flame className="h-4 w-4 text-caution" aria-hidden />
                  <h3 className="font-display text-sm font-semibold uppercase tracking-wide-mc text-ink">
                    Fire calendar — detections per month
                  </h3>
                </div>
                <FireCalendarChart counts={fires.data.monthlyCounts} />
              </HudPanel>

              {/* Detections ledger */}
              <HudPanel calm className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-display text-sm font-semibold uppercase tracking-wide-mc text-ink">
                    Detection ledger
                  </h3>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 border-edge bg-transparent font-mono text-[11px] uppercase tracking-wide-mc text-dim hover:text-ink"
                    onClick={() => showOnMap(fires.data)}
                  >
                    <MapPin className="h-3.5 w-3.5" aria-hidden />
                    Show on map
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={exportDetections}
                    className="h-8 border-edge bg-transparent font-mono text-[11px] uppercase tracking-wide-mc text-dim hover:border-aqua/50 hover:text-aqua"
                    aria-label="Export fire detections as CSV"
                  >
                    <FileDown className="h-3.5 w-3.5" aria-hidden />
                    Export CSV
                  </Button>
                </div>
                <div className="max-h-96 overflow-y-auto overflow-x-auto rounded-sm border border-edge">
                  <table className="mc-table w-full">
                    <thead className="sticky top-0 z-10 bg-panel">
                      <tr className="border-b border-edge">
                        <th className="px-2.5 py-2 text-left">Date</th>
                        <th className="px-2.5 py-2 text-left">Time (UTC)</th>
                        <th className="px-2.5 py-2 text-left">Latitude</th>
                        <th className="px-2.5 py-2 text-left">Longitude</th>
                        <th className="px-2.5 py-2 text-left">Confidence</th>
                        <th className="px-2.5 py-2 text-left">Day/Night</th>
                        <th className="px-2.5 py-2 text-right">FRP (MW)</th>
                        <th className="px-2.5 py-2 text-right">TI4 (K)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fires.data.detections.slice(0, 200).map((d, i) => (
                        <tr key={i} className="border-b border-edge/60 last:border-0 hover:bg-panel-2/40">
                          <td className="telemetry px-2.5 py-1.5 text-ink">{d.date}</td>
                          <td className="telemetry px-2.5 py-1.5">{d.time}</td>
                          <td className="telemetry px-2.5 py-1.5">{d.latitude.toFixed(4)}</td>
                          <td className="telemetry px-2.5 py-1.5">{d.longitude.toFixed(4)}</td>
                          <td className="px-2.5 py-1.5">
                            <StatusPill status={d.confidence} pulse={false} className={CONFIDENCE_TONE[d.confidence] ?? undefined} />
                          </td>
                          <td className="telemetry px-2.5 py-1.5">{d.dayNight === 'D' ? 'day' : 'night'}</td>
                          <td className="telemetry px-2.5 py-1.5 text-right text-ink">{d.frp?.toFixed(1) ?? '—'}</td>
                          <td className="telemetry px-2.5 py-1.5 text-right">{d.brightTi4?.toFixed(0) ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {fires.data.truncated && (
                  <p className="font-mono text-[10px] uppercase tracking-wide-mc text-caution">
                    ledger truncated to first 200 rows — the full detection set remains stored and counted above
                  </p>
                )}
              </HudPanel>
            </div>
          )}
        </QueryState>
      </Reveal>

      {/* Limitations — always visible once a real response exists */}
      {fires.data && (
        <Reveal i={3}>
          <div className="hud p-3.5" style={{ borderColor: 'rgba(255, 178, 36, 0.32)' }}>
            <div className="flex items-start gap-2.5 text-[11px] leading-relaxed text-caution/90">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-caution" aria-hidden />
              <div>{fires.data.limitations} Archive gap days are reported as no-data, never zero.</div>
            </div>
          </div>
        </Reveal>
      )}
    </div>
  );
}
