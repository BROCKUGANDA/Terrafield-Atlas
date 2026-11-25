'use client';

import { useMemo } from 'react';
import {
  ResponsiveContainer, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ReferenceLine, ComposedChart, Area, Bar,
} from 'recharts';
import type { ObservationPoint, TrendResult } from '@/lib/types';

/**
 * Mission-console chart tokens — hex mirrors of the CSS vars in globals.css
 * (--chart-1..5 map to signal/aqua/caution/iris/coral). SVG stroke/fill
 * attributes cannot carry var(), so the palette is pinned here.
 */
const SIGNAL = '#45e39a'; // --chart-1
const AQUA = '#4cc3ff'; // --chart-2
const CAUTION = '#ffb224'; // --chart-3
const CRIT = '#ff5d5d'; // --crit
const FAINT = '#627392'; // --faint
const DIM = '#9aaacd'; // --dim
const INK = '#eaf0fb'; // --ink
const PANEL = '#0b1322'; // --panel (chart background beneath masks)
const GRID_STROKE = 'rgba(151, 174, 224, 0.14)';
const AXIS_STROKE = 'rgba(151, 174, 224, 0.22)';

/** Shared recharts tick styling: mono 10px faint. */
const TICK = { fill: FAINT, fontSize: 10, fontFamily: 'var(--font-plex-mono), monospace' };
const TOOLTIP_STYLE = {
  background: '#0d1729',
  border: `1px solid ${AXIS_STROKE}`,
  borderRadius: 6,
  fontSize: 12,
  color: INK,
  padding: '6px 10px',
};
const TOOLTIP_LABEL = { color: DIM, fontFamily: 'var(--font-plex-mono), monospace', fontSize: 10 };
const LEGEND_STYLE = { fontSize: 10, color: FAINT, fontFamily: 'var(--font-plex-mono), monospace' };

/** Client-side daily → monthly aggregation (mirrors the server rule). */
export function toMonthly(
  points: ObservationPoint[],
  aggregation: 'sum' | 'mean',
): { label: string; year: number; month: number; value: number; n: number }[] {
  const buckets = new Map<string, { sum: number; n: number }>();
  for (const p of points) {
    if (p.value === null || !Number.isFinite(p.value)) continue;
    const key = p.date.slice(0, 7);
    const b = buckets.get(key) ?? { sum: 0, n: 0 };
    b.sum += p.value;
    b.n++;
    buckets.set(key, b);
  }
  const out: { label: string; year: number; month: number; value: number; n: number }[] = [];
  for (const [key, b] of buckets) {
    if (b.n < 20) continue;
    const [year, month] = key.split('-').map(Number);
    out.push({
      label: key,
      year,
      month,
      value: aggregation === 'sum' ? b.sum : b.sum / b.n,
      n: b.n,
    });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

interface SeriesChartProps {
  points: ObservationPoint[];
  aggregation: 'sum' | 'mean';
  variableLabel: string;
  unit: string;
  color?: string;
  trend?: TrendResult;
  height?: number;
}

/** Monthly time series with Theil-Sen trend line + CI band. */
export function MonthlySeriesChart({ points, aggregation, variableLabel, unit, color = AQUA, trend, height = 260 }: SeriesChartProps) {
  const data = useMemo(() => toMonthly(points, aggregation), [points, aggregation]);

  const withTrend = useMemo(() => {
    if (!trend || trend.slopePerYear === null) return data;
    const t0 = new Date(`${trend.periodStart}T00:00:00Z`).getTime();
    return data.map((d) => {
      const t = new Date(`${d.label}-15T00:00:00Z`).getTime();
      const years = (t - t0) / (365.25 * 86_400_000);
      const fitted = data[0] ? data[0].value - (trend.slopePerYear as number) * ((new Date(`${data[0].label}-15T00:00:00Z`).getTime() - t0) / (365.25 * 86_400_000)) : 0;
      return {
        ...d,
        trend: fitted + years * (trend.slopePerYear as number),
        lo: trend.ciLower !== null ? fitted + years * trend.ciLower : undefined,
        hi: trend.ciUpper !== null ? fitted + years * trend.ciUpper : undefined,
      };
    });
  }, [data, trend]);

  if (data.length === 0) {
    return (
      <div className="hud hud-calm flex h-[240px] items-center justify-center px-4 text-center text-xs text-faint">
        No observations stored for this variable yet.
      </div>
    );
  }

  return (
    <div style={{ height }} className="w-full" role="img" aria-label={`Monthly ${variableLabel} chart with trend`}>
      <ResponsiveContainer>
        <ComposedChart data={withTrend} margin={{ top: 8, right: 12, bottom: 0, left: -10 }}>
          <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
          <XAxis
            dataKey="label"
            tick={TICK}
            tickFormatter={(v: string) => v.slice(2, 7)}
            stroke={AXIS_STROKE}
          />
          <YAxis tick={TICK} stroke={AXIS_STROKE} label={{ value: unit, angle: -90, position: 'insideLeft', fill: FAINT, fontSize: 10 }} />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelStyle={TOOLTIP_LABEL}
            itemStyle={{ color: INK, fontFamily: 'var(--font-plex-mono), monospace', fontSize: 11 }}
            formatter={(value: number | string, name: string) => [Number(value).toFixed(2), name === 'value' ? `${variableLabel} (${aggregation === 'sum' ? 'monthly total' : 'monthly mean'})` : name]}
          />
          {trend?.significant !== undefined && withTrend.length > 0 && 'lo' in withTrend[0] && (
            <Area type="linear" dataKey="hi" stroke="none" fill="transparent" isAnimationActive={false} />
          )}
          <Line type="monotone" dataKey="value" stroke={color} strokeWidth={1.6} dot={false} isAnimationActive={false} />
          {trend && trend.slopePerYear !== null && (
            <Line
              type="linear"
              dataKey="trend"
              stroke={CAUTION}
              strokeWidth={1.2}
              strokeDasharray="6 3"
              dot={false}
              isAnimationActive={false}
              name="Theil-Sen trend"
            />
          )}
          <Legend wrapperStyle={LEGEND_STYLE} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** 12-month climatology with ±1σ band. */
export function ClimatologyChart({ climatology, unit, height = 220, color = SIGNAL }: { climatology: { month: number; mean: number; std: number; n: number }[]; unit: string; height?: number; color?: string }) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const data = climatology.map((c) => ({
    month: months[c.month - 1],
    mean: Number(c.mean.toFixed(2)),
    lo: Number((c.mean - c.std).toFixed(2)),
    hi: Number((c.mean + c.std).toFixed(2)),
    n: c.n,
  }));
  if (data.length === 0) return null;
  return (
    <div style={{ height }} className="w-full" role="img" aria-label="Monthly climatology chart">
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -10 }}>
          <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
          <XAxis dataKey="month" tick={TICK} stroke={AXIS_STROKE} />
          <YAxis tick={TICK} stroke={AXIS_STROKE} label={{ value: unit, angle: -90, position: 'insideLeft', fill: FAINT, fontSize: 10 }} />
          <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={{ color: INK, fontFamily: 'var(--font-plex-mono), monospace', fontSize: 11 }} />
          <Area type="monotone" dataKey="hi" stroke="none" fill={color} fillOpacity={0.12} isAnimationActive={false} name="mean ± 1σ" />
          <Area type="monotone" dataKey="lo" stroke="none" fill={PANEL} fillOpacity={1} isAnimationActive={false} name="" legendType="none" />
          <Line type="monotone" dataKey="mean" stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} name="monthly mean" />
          <Legend wrapperStyle={LEGEND_STYLE} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Anomaly z-score bars for the final year. */
export function AnomalyChart({ anomalies, height = 200 }: { anomalies: { date: string; value: number; zScore: number }[]; height?: number }) {
  const data = anomalies.map((a) => ({ date: a.date, z: Number(a.zScore.toFixed(2)), value: Number(a.value.toFixed(2)) }));
  if (data.length === 0) {
    return <div className="hud hud-calm flex h-[140px] items-center justify-center px-4 text-center text-xs text-faint">No months exceeded the ±2σ anomaly threshold in the final year.</div>;
  }
  return (
    <div style={{ height }} className="w-full" role="img" aria-label="Monthly anomaly z-score chart">
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
          <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
          <XAxis dataKey="date" tick={{ ...TICK, fontSize: 9 }} stroke={AXIS_STROKE} interval="preserveStartEnd" minTickGap={18} />
          <YAxis tick={TICK} stroke={AXIS_STROKE} label={{ value: 'σ', angle: -90, position: 'insideLeft', fill: FAINT, fontSize: 10 }} />
          <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={{ color: INK, fontFamily: 'var(--font-plex-mono), monospace', fontSize: 11 }} />
          <ReferenceLine y={0} stroke="rgba(151, 174, 224, 0.30)" />
          <ReferenceLine y={2} stroke={CAUTION} strokeDasharray="4 4" />
          <ReferenceLine y={-2} stroke={CAUTION} strokeDasharray="4 4" />
          <Bar dataKey="z" isAnimationActive={false} name="z-score" shape={(props: { x?: number; y?: number; width?: number; height?: number; payload?: { z: number } }) => {
            const { x = 0, y = 0, width = 0, height = 0, payload } = props;
            const fill = (payload?.z ?? 0) > 0 ? CRIT : AQUA;
            return <rect x={x} y={y} width={width} height={Math.abs(height)} fill={fill} rx={2} />;
          }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Fire calendar monthly counts. */
export function FireCalendarChart({ counts, height = 220 }: { counts: { month: string; count: number }[]; height?: number }) {
  if (counts.length === 0) {
    return <div className="hud hud-calm flex h-[140px] items-center justify-center px-4 text-center text-xs text-faint">No fire detections stored for this range yet — run the ingestion above.</div>;
  }
  return (
    <div style={{ height }} className="w-full" role="img" aria-label="Fire detection counts by month">
      <ResponsiveContainer>
        <ComposedChart data={counts} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
          <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
          <XAxis dataKey="month" tick={TICK} stroke={AXIS_STROKE} />
          <YAxis tick={TICK} stroke={AXIS_STROKE} allowDecimals={false} label={{ value: 'detections', angle: -90, position: 'insideLeft', fill: FAINT, fontSize: 10 }} />
          <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={{ color: INK, fontFamily: 'var(--font-plex-mono), monospace', fontSize: 11 }} />
          <Bar dataKey="count" fill={CAUTION} isAnimationActive={false} name="VIIRS detections" radius={[3, 3, 0, 0]} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Rainfall climatology bars (mm/month) for rotation context. */
export function RainfallProfileChart({ p25, p50, p75, height = 200 }: { p25: number[]; p50: number[]; p75: number[]; height?: number }) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const data = months.map((m, i) => ({ month: m, p50: Math.round(p50[i] ?? 0), p25: Math.round(p25[i] ?? 0), p75: Math.round(p75[i] ?? 0) }));
  return (
    <div style={{ height }} className="w-full" role="img" aria-label="Monthly rainfall climatology">
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
          <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
          <XAxis dataKey="month" tick={TICK} stroke={AXIS_STROKE} />
          <YAxis tick={TICK} stroke={AXIS_STROKE} label={{ value: 'mm', angle: -90, position: 'insideLeft', fill: FAINT, fontSize: 10 }} />
          <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={{ color: INK, fontFamily: 'var(--font-plex-mono), monospace', fontSize: 11 }} />
          <Area type="monotone" dataKey="p75" stroke="none" fill={AQUA} fillOpacity={0.15} isAnimationActive={false} name="p75" />
          <Area type="monotone" dataKey="p25" stroke="none" fill={PANEL} fillOpacity={1} isAnimationActive={false} name="" legendType="none" />
          <Line type="monotone" dataKey="p50" stroke={AQUA} strokeWidth={2} dot={false} isAnimationActive={false} name="median" />
          <Legend wrapperStyle={LEGEND_STYLE} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
