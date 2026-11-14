'use client';

import { useSession } from '@/components/state/store';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api, ApiRequestError } from '@/lib/api-client';
import type { ObservationPoint } from '@/lib/types';
import { MonthlySeriesChart, ClimatologyChart, AnomalyChart } from '@/components/charts/scientific-charts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, TrendingUp, TrendingDown, Minus, Sigma, Info } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

const SERIES_AGG: Record<string, 'sum' | 'mean'> = { PRECTOTCORR: 'sum' };
const SERIES_COLOR: Record<string, string> = {
  PRECTOTCORR: '#38bdf8',
  T2M: '#fb923c',
  T2M_MAX: '#ef4444',
  T2M_MIN: '#60a5fa',
  ALLSKY_SFC_SW_DWN: '#facc15',
  RH2M: '#a78bfa',
  WS2M: '#94a3b8',
  GWETROOT: '#34d399',
  GWETTOP: '#2dd4bf',
};

/** Environmental Analysis: charts + statistical trend assessment. */
export function AnalysisView() {
  const { activeFarmId, location } = useSession();
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
    <div className="mx-auto max-w-6xl flex flex-col gap-6">
      <Card className="border-slate-800 bg-slate-900/40">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Environmental trend analysis</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-slate-400 max-w-3xl">
            Runs the full pipeline on stored observations: monthly aggregation → seasonal Mann-Kendall → Theil-Sen
            slope with 95% CI → autocorrelation check (Hamed-Rao correction when detected) → Benjamini-Hochberg FDR
            across variables → plain-language interpretation with caveats.
          </p>
          <Button onClick={() => trends.mutate()} disabled={trends.isPending} className="w-fit bg-emerald-600 hover:bg-emerald-500 text-white">
            {trends.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> Computing…
              </>
            ) : (
              'Run trend analysis'
            )}
          </Button>
          {trends.data && (
            <div className="text-xs text-slate-500">
              {trends.data.observationCount.toLocaleString()} observations · {trends.data.period.start} → {trends.data.period.end} ·{' '}
              {trends.data.multipleTesting.testedHypotheses} hypotheses tested (FDR-controlled) ·{' '}
              {trends.data.datasetVersions[0]}
            </div>
          )}
        </CardContent>
      </Card>

      {trends.isPending && <SkeletonGrid />}

      {results.length > 0 && (
        <>
          {results.map((r) => {
            const points = (observations.data?.series?.[r.variable]?.points ?? []) as ObservationPoint[];
            return (
              <Card key={r.variable} className="border-slate-800 bg-slate-900/40">
                <CardHeader className="pb-3">
                  <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                    <DirectionIcon direction={r.direction} significant={r.significant} />
                    {r.label}
                    <Badge
                      variant="outline"
                      className={cn(
                        r.significant ? 'border-emerald-600/40 text-emerald-400' : 'border-slate-700 text-slate-400',
                      )}
                    >
                      {r.significant ? 'significant (p<0.05)' : 'not significant'}
                    </Badge>
                    {r.autocorrelationAdjusted && (
                      <Badge variant="outline" className="border-amber-600/40 text-amber-400">autocorrelation-corrected</Badge>
                    )}
                    {!r.minSampleSatisfied && (
                      <Badge variant="outline" className="border-amber-600/40 text-amber-400">insufficient record</Badge>
                    )}
                    <span className="ml-auto font-mono text-xs text-slate-500">{r.unit}</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <MonthlySeriesChart
                    points={points}
                    aggregation={SERIES_AGG[r.variable] ?? 'mean'}
                    variableLabel={r.label}
                    unit={r.unit}
                    color={SERIES_COLOR[r.variable] ?? '#38bdf8'}
                    trend={r}
                  />
                  <div className="grid gap-4 lg:grid-cols-2">
                    <div>
                      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-300">
                        <Sigma className="h-3.5 w-3.5 text-slate-500" aria-hidden /> Monthly climatology (mean ± 1σ)
                      </div>
                      <ClimatologyChart climatology={r.monthlyClimatology} unit={r.unit} />
                    </div>
                    <div>
                      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-300">
                        <Info className="h-3.5 w-3.5 text-slate-500" aria-hidden /> Final-year anomalies (|z| ≥ 2σ)
                      </div>
                      <AnomalyChart anomalies={r.anomalies} />
                    </div>
                  </div>
                  <TrendStatsGrid result={r} />
                  <ExplanationBlock result={r} />
                </CardContent>
              </Card>
            );
          })}
        </>
      )}

      {!trends.isPending && results.length === 0 && (
        <Card className="border-dashed border-slate-800 bg-slate-900/20">
          <CardContent className="py-10 text-center text-sm text-slate-500">
            Run the analysis to see rainfall, temperature, radiation, humidity and soil-wetness trends with full
            statistics. Requires an ingested POWER record (see Earth Intelligence).
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function TrendStatsGrid({ result }: { result: import('@/lib/types').TrendResult }) {
  const stats: { label: string; value: string }[] = [
    { label: 'direction', value: result.direction },
    { label: 'Theil-Sen slope', value: result.slopePerYear !== null ? `${result.slopePerYear.toFixed(3)} ${result.unit}/yr` : 'n/a' },
    { label: '95% CI', value: result.ciLower !== null ? `${result.ciLower.toFixed(2)} … ${result.ciUpper?.toFixed(2)}` : 'n/a' },
    { label: 'Mann-Kendall Z', value: result.zValue?.toFixed(2) ?? 'n/a' },
    { label: 'p-value', value: result.pValue?.toExponential(2) ?? 'n/a' },
    { label: 'FDR-adjusted p', value: result.multipleTestingAdjustedP?.toExponential(2) ?? 'not applied' },
    { label: 'usable months (n)', value: String(result.sampleCount) },
    { label: 'missing days', value: String(result.missingCount) },
    { label: 'method', value: result.method },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
      {stats.map((s) => (
        <div key={s.label} className="rounded border border-slate-800 bg-slate-900/60 px-2.5 py-2">
          <div className="text-[10px] uppercase tracking-wider text-slate-600">{s.label}</div>
          <div className="mt-0.5 font-mono text-slate-200 break-words">{s.value}</div>
        </div>
      ))}
    </div>
  );
}

function ExplanationBlock({ result }: { result: import('@/lib/types').TrendResult }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-[#0a101c] p-3.5">
      <div className="text-sm font-semibold text-slate-100">{result.explanation.headline}</div>
      <p className="mt-1.5 text-xs leading-relaxed text-slate-400">{result.explanation.interpretation}</p>
      {result.explanation.caveats.length > 0 && (
        <ul className="mt-2 text-[11px] text-slate-500 list-disc list-inside space-y-0.5">
          {result.explanation.caveats.map((c, i) => <li key={i}>{c}</li>)}
        </ul>
      )}
      {result.warnings.length > 0 && (
        <ul className="mt-2 text-[11px] text-amber-400/90 list-disc list-inside space-y-0.5">
          {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}
    </div>
  );
}

function DirectionIcon({ direction, significant }: { direction: string; significant: boolean }) {
  if (!significant || direction === 'no trend') return <Minus className="h-4 w-4 text-slate-500" aria-hidden />;
  return direction === 'increasing' ? (
    <TrendingUp className="h-4 w-4 text-emerald-400" aria-hidden />
  ) : (
    <TrendingDown className="h-4 w-4 text-sky-400" aria-hidden />
  );
}

function SkeletonGrid() {
  return (
    <div className="grid gap-4" aria-busy="true">
      {[1, 2].map((i) => (
        <Card key={i} className="border-slate-800 bg-slate-900/40">
          <CardContent className="py-10 flex items-center justify-center gap-2 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> analysing variable set…
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
