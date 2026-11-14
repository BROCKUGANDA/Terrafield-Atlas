'use client';

import { useState } from 'react';
import { useSession } from '@/components/state/store';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api, ApiRequestError, type FireQueryResponse } from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { FireCalendarChart } from '@/components/charts/scientific-charts';
import { Flame, Loader2, Download, ShieldAlert } from 'lucide-react';

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
      setQueryKey((k) => k + 1);
    },
    onError: (err) => {
      toast({ title: 'Fire ingestion failed', description: err instanceof ApiRequestError ? err.message : 'error', variant: 'destructive' });
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

  return (
    <div className="mx-auto max-w-6xl flex flex-col gap-6">
      <Card className="border-slate-800 bg-slate-900/40">
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <Flame className="h-4 w-4 text-amber-500" aria-hidden /> Fire Intelligence — VIIRS 375 m active-fire detections
            <span className="text-xs font-normal text-slate-500">{location.label}</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-3 text-sm">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wider text-slate-500">From</span>
              <Input type="date" value={range.from} min="2015-01-01" max="2026-11-14" onChange={(e) => setRange({ ...range, from: e.target.value })} className="w-40 bg-slate-900 border-slate-700" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wider text-slate-500">To</span>
              <Input type="date" value={range.to} min="2015-01-01" max="2026-11-14" onChange={(e) => setRange({ ...range, to: e.target.value })} className="w-40 bg-slate-900 border-slate-700" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wider text-slate-500">Confidence</span>
              <select value={confidence} onChange={(e) => setConfidence(e.target.value)} className="rounded-md border border-slate-700 bg-slate-900 px-2 py-2 text-xs h-9" aria-label="Confidence filter">
                <option value="all">all</option>
                <option value="high">high</option>
                <option value="nominal">nominal</option>
                <option value="low">low</option>
              </select>
            </label>
            <Button
              onClick={() => ingest.mutate()}
              disabled={ingest.isPending || range.to < range.from}
              className="bg-amber-600 hover:bg-amber-500 text-white"
            >
              {ingest.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> Decoding VIIRS tiles…
                </>
              ) : (
                <>
                  <Download className="mr-1 h-4 w-4" aria-hidden /> Ingest detections (≤ 40 days)
                </>
              )}
            </Button>
          </div>
          <p className="text-[11px] text-slate-500 max-w-3xl">
            Detections are decoded server-side from NASA GIBS <span className="font-mono">VIIRS_SNPP_Thermal_Anomalies_375m_All</span> vector
            tiles — the same VIIRS detection stream NASA FIRMS distributes. The FIRMS CSV API itself is unreachable
            from this deployment sandbox and is health-flagged, never faked.
          </p>
        </CardContent>
      </Card>

      {fires.data && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Detections in range" value={fires.data.count.toLocaleString()} />
            <Stat label="High confidence" value={String(fires.data.confidenceDistribution.high)} tone="text-red-400" />
            <Stat label="Nominal" value={String(fires.data.confidenceDistribution.nominal)} tone="text-amber-400" />
            <Stat label="Mean FRP" value={fires.data.frpStats ? `${fires.data.frpStats.meanMW} MW` : '—'} />
          </div>

          <Card className="border-slate-800 bg-slate-900/40">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Fire calendar — detections per month</CardTitle>
            </CardHeader>
            <CardContent>
              <FireCalendarChart counts={fires.data.monthlyCounts} />
            </CardContent>
          </Card>

          <Card className="border-slate-800 bg-slate-900/40">
            <CardHeader className="pb-3">
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                Observations
                <Button variant="outline" size="sm" className="ml-auto h-8 text-xs border-slate-700 text-slate-200" onClick={() => showOnMap(fires.data)}>
                  Show on map
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {fires.data.count === 0 && (
                <p className="text-xs text-slate-500">
                  No detections stored for this range/location yet. Ingest the range above (fire-prone season and
                  region show real activity, e.g. Southern Africa Jul–Oct, or check the Zambia preset).
                </p>
              )}
              {fires.data.count > 0 && (
                <div className="overflow-x-auto rounded-lg border border-slate-800 max-h-96 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-900/80 text-slate-400 sticky top-0">
                      <tr>
                        <th className="px-2.5 py-2 text-left font-medium">Date</th>
                        <th className="px-2.5 py-2 text-left font-medium">Time (UTC)</th>
                        <th className="px-2.5 py-2 text-left font-medium">Latitude</th>
                        <th className="px-2.5 py-2 text-left font-medium">Longitude</th>
                        <th className="px-2.5 py-2 text-left font-medium">Confidence</th>
                        <th className="px-2.5 py-2 text-left font-medium">Day/Night</th>
                        <th className="px-2.5 py-2 text-left font-medium">FRP (MW)</th>
                        <th className="px-2.5 py-2 text-left font-medium">TI4 (K)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800 text-slate-300 font-mono">
                      {fires.data.detections.slice(0, 200).map((d, i) => (
                        <tr key={i} className="bg-slate-900/30">
                          <td className="px-2.5 py-1.5">{d.date}</td>
                          <td className="px-2.5 py-1.5">{d.time}</td>
                          <td className="px-2.5 py-1.5">{d.latitude.toFixed(4)}</td>
                          <td className="px-2.5 py-1.5">{d.longitude.toFixed(4)}</td>
                          <td className="px-2.5 py-1.5">
                            <Badge variant="outline" className={d.confidence === 'high' ? 'border-red-600/40 text-red-400' : d.confidence === 'nominal' ? 'border-amber-600/40 text-amber-400' : 'border-slate-700 text-slate-400'}>
                              {d.confidence}
                            </Badge>
                          </td>
                          <td className="px-2.5 py-1.5">{d.dayNight === 'D' ? 'day' : 'night'}</td>
                          <td className="px-2.5 py-1.5">{d.frp?.toFixed(1) ?? '—'}</td>
                          <td className="px-2.5 py-1.5">{d.brightTi4?.toFixed(0) ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="flex items-start gap-2 rounded-lg border border-amber-700/30 bg-amber-500/5 p-3 text-[11px] text-amber-200/80">
                <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
                <div>{fires.data.limitations} Archive gap days are reported as no-data, never zero.</div>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {fires.isError && (
        <Card className="border-red-800/40 bg-red-500/5">
          <CardContent className="py-6 text-sm text-red-300">
            Fire query failed: {fires.error instanceof ApiRequestError ? fires.error.message : 'unknown error'}.
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold font-mono ${tone ?? 'text-slate-100'}`}>{value}</div>
    </div>
  );
}
