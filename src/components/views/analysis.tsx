'use client';

import React from 'react';
import { motion } from 'framer-motion';
import { useSession } from '@/components/state/store';
import { useQuery, useMutation } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { api, ApiRequestError, type ObservationsResponse } from '@/lib/api-client';
import type { ObservationPoint, TrendResult } from '@/lib/types';
import { MonthlySeriesChart, ClimatologyChart, AnomalyChart } from '@/components/charts/scientific-charts';
import { Button } from '@/components/ui/button';
import { SectionHeader, StatusPill, HudPanel } from '@/components/ui-mc/kit';
import { FaultPanel, EmptyState } from '@/components/system/query-state';
import { SkeletonPanel, SweepLoader } from '@/components/system/skeletons';
import { Loader2, TrendingUp, TrendingDown, Minus, Sigma, Info } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

const SERIES_AGG: Record<string, 'sum' | 'mean'> = { PRECTOTCORR: 'sum' };
/** Palette hexes mirroring --chart-1..5 / mission tokens (see scientific-charts). */
const SERIES_COLOR: Record<string, string> = {
  PRECTOTCORR: '#4cc3ff', // aqua — water
  T2M: '#ffb224', // caution
  T2M_MAX: '#ff7e6b', // coral
  T2M_MIN: '#8da2ff', // iris
  ALLSKY_SFC_SW_DWN: '#ffb224', // caution — solar
  RH2M: '#4cc3ff', // aqua
  WS2M: '#9aaacd', // dim
  GWETROOT: '#45e39a', // signal
  GWETTOP: '#4cc3ff', // aqua
};

const DIRECTION_TONE: Record<string, string> = {
  increasing: 'border-iris/40 text-iris',
  decreasing: 'border-aqua/40 text-aqua',
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

/** Environmental Analysis: charts + statistical trend assessment. */
export function AnalysisView() {
  const { activeFarmId, location, setView } = useSession();
  const { toast } = useToast();

  const trends = useMutation({
    mutationFn: () => api.trends(activeFarmId ? { farmId: activeFarmId } : { lat: location.lat, lon: location.lon }),
    onError: (err) => {
      toast({
        title: 'Cannot analyse yet',
        description:
          err instanceof ApiRequestError && err.code === 'NO_DATA_INGESTED'
            ? 'No POWER observations stored for this location. Ingest the record from the Earth Intelligence dashboard first.'
            : err instanceof ApiRequestError
              ? err.message
              : 'Unexpected error.',
        variant: 'destructive',
      });
    },
  });

  const observations = useQuery({
    queryKey: ['obs-all', activeFarmId, location.lat, location.lon, trends.isSuccess],
    queryFn: () => api.observations(activeFarmId ? { farmId: activeFarmId } : {}),
    enabled: trends.isSuccess,
  });

  const results = trends.data?.results ?? [];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      {/* View header — the run control is the primary mission action */}
      <Reveal>
        <SectionHeader
          kicker="Mission console · Deterministic statistics"
          title="Environmental Trend Analysis"
          description="Runs the full pipeline on stored observations: monthly aggregation → seasonal Mann-Kendall → Theil-Sen slope with 95% CI → autocorrelation check (Hamed-Rao correction when detected) → Benjamini-Hochberg FDR across variables → plain-language interpretation with caveats."
          actions={
            <Button
              onClick={() => trends.mutate()}
              disabled={trends.isPending}
              className="h-9 font-mono text-xs uppercase tracking-wide-mc"
            >
              {trends.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
                  Computing…
                </>
              ) : (
                'Run trend analysis'
              )}
            </Button>
          }
        />
      </Reveal>

      {/* Run provenance strip */}
      {trends.data && (
        <Reveal i={1}>
          <p className="telemetry px-1 text-[11px] text-faint">
            {trends.data.observationCount.toLocaleString()} observations · {trends.data.period.start} → {trends.data.period.end} ·{' '}
            {trends.data.multipleTesting.testedHypotheses} hypotheses tested (FDR-controlled) ·{' '}
            {trends.data.datasetVersions[0]}
          </p>
        </Reveal>
      )}

      {/* Job surfaces */}
      {trends.isPending && (
        <Reveal i={2}>
          <div role="status" aria-live="polite" className="flex flex-col gap-2">
            <SweepLoader label="Computing trends" />
            <p className="font-mono text-[10px] uppercase tracking-wide-mc text-faint">
              seasonal Mann-Kendall · Theil-Sen · Hamed-Rao · Benjamini-Hochberg FDR
            </p>
          </div>
        </Reveal>
      )}

      {trends.isError && (
        <Reveal i={2}>
          <FaultPanel error={trends.error} onRetry={() => trends.mutate()} label="Trend analysis" />
        </Reveal>
      )}

      {/* Result cards */}
      {results.length > 0 && (
        <>
          {results.map((r, idx) => (
            <Reveal key={r.variable} i={idx + 2}>
              {/* API contract types `variable` as string; the view narrows to the catalogue key set. */}
              <ResultCard result={r as TrendResult} observations={observations} />
            </Reveal>
          ))}
        </>
      )}

      {/* Idle state — analysis not yet run */}
      {!trends.isPending && results.length === 0 && (
        <Reveal i={2}>
          <EmptyState
            label="Trend analysis"
            hint="Run the analysis to see rainfall, temperature, radiation, humidity and soil-wetness trends with full statistics. Requires an ingested POWER record (see Earth Intelligence)."
            action={
              <Button
                variant="outline"
                onClick={() => setView('dashboard')}
                className="mt-2 h-8 border-edge bg-transparent font-mono text-[11px] uppercase tracking-wide-mc text-dim hover:text-ink"
              >
                Open Earth Intelligence
              </Button>
            }
          />
        </Reveal>
      )}
    </div>
  );
}

function ResultCard({
  result: r,
  observations,
}: {
  result: TrendResult;
  observations: UseQueryResult<ObservationsResponse>;
}) {
  const points = (observations.data?.series?.[r.variable]?.points ?? []) as ObservationPoint[];
  return (
    <HudPanel calm className="flex flex-col gap-4">
      {/* Variable header: direction + significance markers */}
      <div className="flex flex-wrap items-center gap-2">
        <DirectionIcon direction={r.direction} significant={r.significant} />
        <h3 className="font-display text-base font-bold uppercase tracking-wide-mc text-ink">{r.label}</h3>
        <StatusPill
          status={r.significant ? 'significant (p<0.05)' : 'not significant'}
          pulse={false}
          className={r.significant ? 'border-signal/40 text-signal' : undefined}
        />
        {r.autocorrelationAdjusted && (
          <StatusPill status="autocorrelation-corrected" pulse={false} className="border-caution/40 text-caution" />
        )}
        {!r.minSampleSatisfied && (
          <StatusPill status="insufficient record" pulse={false} className="border-caution/40 text-caution" />
        )}
        <span className="ml-auto telemetry text-xs text-faint">{r.unit}</span>
      </div>

      {/* Monthly series + trend line (observations-gated) */}
      {observations.isLoading ? (
        <SkeletonPanel rows={4} label="Loading monthly series" />
      ) : observations.isError ? (
        <FaultPanel error={observations.error} onRetry={() => observations.refetch()} label="Observation series" />
      ) : (
        <MonthlySeriesChart
          points={points}
          aggregation={SERIES_AGG[r.variable] ?? 'mean'}
          variableLabel={r.label}
          unit={r.unit}
          color={SERIES_COLOR[r.variable] ?? '#4cc3ff'}
          trend={r}
        />
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-dim">
            <Sigma className="h-3.5 w-3.5 text-faint" aria-hidden /> Monthly climatology (mean ± 1σ)
          </div>
          <ClimatologyChart climatology={r.monthlyClimatology} unit={r.unit} />
        </div>
        <div>
          <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-dim">
            <Info className="h-3.5 w-3.5 text-faint" aria-hidden /> Final-year anomalies (|z| ≥ 2σ)
          </div>
          <AnomalyChart anomalies={r.anomalies} />
        </div>
      </div>

      <TrendStatsGrid result={r} />
      <ExplanationBlock result={r} />
    </HudPanel>
  );
}

function TrendStatsGrid({ result }: { result: TrendResult }) {
  const stats: { label: string; value: React.ReactNode }[] = [
    {
      label: 'direction',
      value: <StatusPill status={result.direction} pulse={false} className={DIRECTION_TONE[result.direction] ?? undefined} />,
    },
    {
      label: 'Theil-Sen slope',
      value: `${result.slopePerYear !== null ? `${result.slopePerYear.toFixed(3)} ${result.unit}/yr` : 'n/a'}`,
    },
    {
      label: '95% CI',
      value: result.ciLower !== null ? `${result.ciLower.toFixed(2)} … ${result.ciUpper?.toFixed(2)} ${result.unit}/yr` : 'n/a',
    },
    { label: 'Mann-Kendall Z', value: result.zValue?.toFixed(2) ?? 'n/a' },
    { label: 'p-value', value: result.pValue?.toExponential(2) ?? 'n/a' },
    { label: 'FDR-adjusted p', value: result.multipleTestingAdjustedP?.toExponential(2) ?? 'not applied' },
    { label: 'usable months (n)', value: String(result.sampleCount) },
    {
      label: 'missing days',
      value: (
        <span className={result.missingCount > 0 ? 'text-caution' : undefined}>
          {String(result.missingCount)}
        </span>
      ),
    },
    { label: 'method', value: result.method },
  ];
  return (
    <div className="overflow-x-auto rounded-sm border border-edge">
      <table className="mc-table w-full">
        <tbody>
          {stats.map((s) => (
            <tr key={s.label} className="border-b border-edge/60 last:border-0">
              <th scope="row" className="w-44 px-3 py-2 text-left">
                {s.label}
              </th>
              <td className="telemetry px-3 py-2 text-ink">{s.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExplanationBlock({ result }: { result: TrendResult }) {
  return (
    <div className="hud hud-calm p-3.5">
      <div className="font-display text-sm font-semibold text-ink">{result.explanation.headline}</div>
      <p className="mt-1.5 text-xs leading-relaxed text-dim">{result.explanation.interpretation}</p>
      {result.explanation.caveats.length > 0 && (
        <ul className="mt-2 list-inside list-disc space-y-0.5 text-[11px] text-faint">
          {result.explanation.caveats.map((c, i) => <li key={i}>{c}</li>)}
        </ul>
      )}
      {result.warnings.length > 0 && (
        <ul className="mt-2 list-inside list-disc space-y-0.5 text-[11px] text-caution/90">
          {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}
    </div>
  );
}

function DirectionIcon({ direction, significant }: { direction: string; significant: boolean }) {
  if (!significant || direction === 'no trend') return <Minus className="h-4 w-4 text-faint" aria-hidden />;
  return direction === 'increasing' ? (
    <TrendingUp className="h-4 w-4 text-iris" aria-hidden />
  ) : (
    <TrendingDown className="h-4 w-4 text-aqua" aria-hidden />
  );
}
