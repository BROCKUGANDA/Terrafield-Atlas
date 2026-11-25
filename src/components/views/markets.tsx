'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Area, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { AlertTriangle, Database, Loader2, RefreshCw, TrendingUp } from 'lucide-react';
import { api, ApiRequestError, type MarketSeriesPoint } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { HudPanel, SectionHeader, StatusPill } from '@/components/ui-mc/kit';
import { EmptyState, FaultPanel } from '@/components/system/query-state';
import { SkeletonPanel } from '@/components/system/skeletons';
import { useToast } from '@/hooks/use-toast';

const SIGNAL = '#45e39a';
const AQUA = '#4cc3ff';
const FAINT = '#627392';
const DIM = '#9aaacd';
const INK = '#eaf0fb';
const GRID_STROKE = 'rgba(151, 174, 224, 0.14)';
const AXIS_STROKE = 'rgba(151, 174, 224, 0.22)';
const TICK = { fill: FAINT, fontSize: 10, fontFamily: 'var(--font-plex-mono), monospace' };

const PRICE_FORMAT = new Intl.NumberFormat('en-UG', { maximumFractionDigits: 0 });
const COMPACT_FORMAT = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

function formatPrice(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? PRICE_FORMAT.format(value) : '—';
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().replace('T', ' ').slice(0, 16) + 'Z' : '—';
}

function MarketPriceChart({
  series,
  unit,
  currency,
}: {
  series: MarketSeriesPoint[];
  unit: string | null;
  currency: string | null;
}) {
  const data = useMemo(() => series.map((point) => ({
    ...point,
    range: [point.min, point.max] as [number, number],
  })), [series]);

  if (data.length === 0) {
    return (
      <EmptyState
        label="Monthly price series"
        hint="No observations match the selected commodity, market and date window. Clear the market filter or ingest the latest HDX/WFP feed — the chart never interpolates a missing month."
      />
    );
  }

  const denomination = `${currency ?? 'local currency'}/${unit ?? 'unit'}`;
  return (
    <div
      role="img"
      aria-label={`Monthly median ${denomination} price with minimum and maximum band, ${data.length} months`}
      className="w-full"
      style={{ height: 300 }}
    >
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
          <XAxis dataKey="month" tick={TICK} stroke={AXIS_STROKE} tickFormatter={(value: string) => value.slice(2)} />
          <YAxis
            tick={TICK}
            stroke={AXIS_STROKE}
            width={82}
            tickFormatter={(value: number) => COMPACT_FORMAT.format(value)}
            label={{ value: denomination, angle: -90, position: 'insideLeft', fill: FAINT, fontSize: 10 }}
          />
          <Tooltip
            contentStyle={{ background: '#0d1729', border: `1px solid ${AXIS_STROKE}`, borderRadius: 6, fontSize: 12, color: INK }}
            labelStyle={{ color: DIM, fontFamily: 'var(--font-plex-mono), monospace', fontSize: 10 }}
            itemStyle={{ color: INK, fontFamily: 'var(--font-plex-mono), monospace', fontSize: 11 }}
            formatter={(value, name) => {
              if (Array.isArray(value)) {
                return [`${formatPrice(Number(value[0]))} – ${formatPrice(Number(value[1]))} ${unit ?? ''}`.trim(), 'min – max'];
              }
              return [`${formatPrice(Number(value))} ${unit ?? ''}`.trim(), name === 'median' ? 'monthly median' : name];
            }}
          />
          <Legend wrapperStyle={{ fontSize: 10, color: FAINT, fontFamily: 'var(--font-plex-mono), monospace' }} />
          <Area
            type="monotone"
            dataKey="range"
            name="min – max"
            stroke="none"
            fill={AQUA}
            fillOpacity={0.14}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="median"
            name="monthly median"
            stroke={SIGNAL}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export function MarketsView() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const prices = useQuery({
    queryKey: ['market-prices'],
    queryFn: () => api.marketPrices(),
    retry: 1,
  });

  const [commodityId, setCommodityId] = useState('');
  const [marketId, setMarketId] = useState('all');

  const selected = useQuery({
    queryKey: ['market-prices', commodityId, marketId],
    queryFn: () => api.marketPrices({
      commodityId: commodityId || undefined,
      marketId: marketId === 'all' ? undefined : marketId,
    }),
    enabled: commodityId !== '' || marketId !== 'all',
    retry: 1,
  });

  const data = selected.data ?? prices.data;
  const coverage = data?.coverage;
  const series = data?.series ?? [];
  const unit = data?.selection.unit ?? null;
  const currency = data?.selection.currency ?? null;

  const ingest = useMutation({
    mutationFn: api.ingestMarketPrices,
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['market-prices'] });
      toast({
        title: result.counts.accepted > 0 ? 'Market prices stored' : 'No eligible prices returned',
        description: `${result.counts.accepted.toLocaleString()} new rows · ${result.counts.skipped.toLocaleString()} skipped of ${result.counts.rowsRead.toLocaleString()} read.`,
      });
    },
    onError: (error) => {
      toast({
        title: 'Market ingestion failed',
        description: error instanceof ApiRequestError ? error.message : 'The provider feed could not be stored. No prices were written from this attempt.',
        variant: 'destructive',
      });
    },
  });

  const ingestButton = (
    <Button onClick={() => ingest.mutate()} disabled={ingest.isPending} className="font-mono text-[11px] uppercase tracking-wide-mc">
      {ingest.isPending ? (
        <><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Downloading HDX/WFP…</>
      ) : (
        <><RefreshCw className="h-3.5 w-3.5" aria-hidden /> Fetch latest prices</>
      )}
    </Button>
  );

  const latest = data?.provenance.latestIngestion ?? prices.data?.provenance.latestIngestion ?? null;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <SectionHeader
        kicker="Field Planning · Market intelligence"
        title="Market Prices"
        description="Monthly median retail prices for Uganda market surveys published by WFP/FIT Uganda via HDX. Coverage, sample counts and provenance are shown with every series; missing months are never interpolated."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill
              status={`${coverage?.storedRows.toLocaleString() ?? '—'} stored rows`}
              pulse={false}
              className="border-aqua/40 text-aqua"
            />
            {ingestButton}
          </div>
        }
      />

      {prices.isLoading ? <SkeletonPanel label="Reading stored market prices" /> : null}

      {prices.isError ? (
        <FaultPanel error={prices.error} onRetry={() => prices.refetch()} label="Market price register" />
      ) : null}

      {!prices.isLoading && !prices.isError && (coverage?.storedRows ?? 0) === 0 ? (
        <EmptyState
          label="Market prices"
          hint="No market-price observations are stored. Run the HDX/WFP ingest to download the latest Uganda CSV. A failed or timed-out ingest stores nothing and is recorded as failed."
        />
      ) : null}

      {!prices.isLoading && !prices.isError && (coverage?.storedRows ?? 0) > 0 && data ? (
        <>
          <HudPanel calm className="flex flex-col gap-4">
            <div className="flex flex-wrap items-end gap-4">
              <div className="grid min-w-[220px] flex-1 gap-1.5">
                <label htmlFor="market-commodity" className="font-mono text-[10px] uppercase tracking-wide-mc text-faint">
                  Commodity
                </label>
                <Select
                  value={data.selection.commodityId ?? undefined}
                  onValueChange={(value) => { setCommodityId(value); setMarketId('all'); }}
                >
                  <SelectTrigger id="market-commodity" className="h-9 border-edge bg-panel text-xs text-ink">
                    <SelectValue placeholder="Choose a commodity" />
                  </SelectTrigger>
                  <SelectContent className="max-h-72 border-edge bg-popover text-dim">
                    {coverage?.commodities.map((item) => (
                      <SelectItem key={item.id} value={item.id} className="text-xs">
                        {item.name} · {item.observations.toLocaleString()}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid min-w-[220px] flex-1 gap-1.5">
                <label htmlFor="market-market" className="font-mono text-[10px] uppercase tracking-wide-mc text-faint">
                  Market
                </label>
                <Select value={marketId} onValueChange={setMarketId}>
                  <SelectTrigger id="market-market" className="h-9 border-edge bg-panel text-xs text-ink">
                    <SelectValue placeholder="All markets" />
                  </SelectTrigger>
                  <SelectContent className="max-h-72 border-edge bg-popover text-dim">
                    <SelectItem value="all" className="text-xs">All markets</SelectItem>
                    {coverage?.markets.map((item) => (
                      <SelectItem key={item.id} value={item.id} className="text-xs">
                        {item.name} · {item.observations.toLocaleString()}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <dl className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-[10px] text-faint sm:grid-cols-4">
                <div><dt className="uppercase tracking-wide-mc">Unit</dt><dd className="text-dim">{unit ?? '—'}</dd></div>
                <div><dt className="uppercase tracking-wide-mc">Currency</dt><dd className="text-dim">{currency ?? '—'}</dd></div>
                <div><dt className="uppercase tracking-wide-mc">Window</dt><dd className="text-dim">{data.range.from} → {data.range.to}</dd></div>
                <div><dt className="uppercase tracking-wide-mc">Months</dt><dd className="text-dim">{series.length}</dd></div>
              </dl>
            </div>

            <div className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-signal" aria-hidden />
              <h3 className="font-display text-sm font-bold uppercase tracking-wide-mc text-ink">
                Monthly median · min/max band
              </h3>
              {data.coverage.truncated ? (
                <span className="font-mono text-[10px] text-caution">series truncated at the read cap</span>
              ) : null}
            </div>

            {selected.isError ? (
              <FaultPanel error={selected.error} onRetry={() => selected.refetch()} label="Selected market series" />
            ) : null}
            {selected.isFetching && !selected.isLoading ? (
              <p className="font-mono text-[10px] uppercase tracking-wide-mc text-aqua" role="status">refreshing selection…</p>
            ) : null}

            {!selected.isError ? <MarketPriceChart series={series} unit={unit} currency={currency} /> : null}

            {!selected.isError && series.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="mc-table w-full min-w-[560px]">
                  <caption className="sr-only">Monthly price aggregates with sample counts</caption>
                  <thead>
                    <tr>
                      <th>Month</th>
                      <th>Median</th>
                      <th>Minimum</th>
                      <th>Maximum</th>
                      <th>Samples</th>
                    </tr>
                  </thead>
                  <tbody>
                    {series.map((point) => (
                      <tr key={point.month} className="border-b border-edge/60 last:border-0">
                        <td className="telemetry px-2 py-1.5">{point.month}</td>
                        <td className="px-2 py-1.5 text-ink">{formatPrice(point.median)}</td>
                        <td className="px-2 py-1.5 text-dim">{formatPrice(point.min)}</td>
                        <td className="px-2 py-1.5 text-dim">{formatPrice(point.max)}</td>
                        <td className="telemetry px-2 py-1.5">{point.sampleCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </HudPanel>

          <HudPanel calm className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 text-aqua" aria-hidden />
              <h3 className="font-display text-sm font-bold uppercase tracking-wide-mc text-ink">Source, licence & retrieval</h3>
              <StatusPill
                status={latest?.status ?? 'never ingested'}
                pulse={latest?.status === 'running'}
                className={latest?.status === 'failed' ? 'border-crit/40 text-crit' : undefined}
              />
            </div>

            <dl className="grid gap-x-6 gap-y-2 font-mono text-[11px] text-faint sm:grid-cols-2">
              <div><dt className="uppercase tracking-wide-mc">Provider</dt><dd className="text-dim">HDX (UN OCHA) · WFP VAM · FIT Uganda</dd></div>
              <div><dt className="uppercase tracking-wide-mc">Dataset</dt><dd className="text-dim">{data.provenance.datasetName}</dd></div>
              <div><dt className="uppercase tracking-wide-mc">Licence</dt><dd className="text-dim">{data.provenance.licence}</dd></div>
              <div><dt className="uppercase tracking-wide-mc">Rows stored</dt><dd className="text-dim">{coverage?.storedRows.toLocaleString() ?? '—'}</dd></div>
              <div><dt className="uppercase tracking-wide-mc">Coverage</dt><dd className="text-dim">{coverage?.firstDate?.slice(0, 10) ?? '—'} → {coverage?.lastDate?.slice(0, 10) ?? '—'}</dd></div>
              <div><dt className="uppercase tracking-wide-mc">Resource updated</dt><dd className="text-dim">{formatTimestamp(data.provenance.resourceUpdatedAt)}</dd></div>
              <div><dt className="uppercase tracking-wide-mc">Last retrieval</dt><dd className="text-dim">{formatTimestamp(data.provenance.retrievedAt)}</dd></div>
              <div><dt className="uppercase tracking-wide-mc">Latest run</dt><dd className="text-dim">{latest ? `${latest.accepted.toLocaleString()} accepted · ${latest.skipped.toLocaleString()} skipped · ${latest.rowCount.toLocaleString()} read` : '—'}</dd></div>
            </dl>

            {latest?.errorDetail ? (
              <p className="flex items-start gap-2 font-mono text-[10px] leading-relaxed text-caution" role="alert">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                latest ingestion note: {latest.errorDetail}
              </p>
            ) : null}

            {ingest.isError ? (
              <p className="font-mono text-[10px] leading-relaxed text-crit" role="alert">
                Last ingest attempt failed — no prices were written from that attempt. {ingest.error instanceof ApiRequestError ? ingest.error.message : ''}
              </p>
            ) : null}
            {ingest.isSuccess ? (
              <p className="font-mono text-[10px] leading-relaxed text-signal" role="status">
                Ingest complete — {ingest.data.counts.accepted.toLocaleString()} new rows stored from {ingest.data.counts.rowsRead.toLocaleString()} read;{' '}
                {ingest.data.counts.skipped.toLocaleString()} skipped ({ingest.data.counts.reasons.outsideWindow ?? 0} outside the 24-month window,{' '}
                {ingest.data.counts.reasons.priceType ?? 0} non-retail, {ingest.data.counts.alreadyStored.toLocaleString()} already stored).
              </p>
            ) : null}

            <p className="text-[11px] leading-relaxed text-dim">{data.provenance.note}</p>
            <a
              href={data.provenance.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="w-fit font-mono text-[10px] uppercase tracking-wide-mc text-aqua underline-offset-4 hover:underline"
            >
              HDX dataset page ↗
            </a>
            <p className="font-mono text-[10px] text-faint">
              Retail observations only when the provider labels price type; wholesale and retail are never blended.
            </p>
          </HudPanel>
        </>
      ) : null}
    </div>
  );
}
