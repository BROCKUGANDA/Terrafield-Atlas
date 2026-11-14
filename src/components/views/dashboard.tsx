'use client';

import { useSession } from '@/components/state/store';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiRequestError } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { Download, CloudRain, Thermometer, Sun, Waves, Loader2, MapPin, Clock, Database, Flame } from 'lucide-react';

/** Earth Intelligence Dashboard: coverage, indicators, ingestion control. */
export function DashboardView() {
  const { location, setLocation, activeFarmId, setView } = useSession();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const regions = useQuery({ queryKey: ['regions'], queryFn: api.regions });
  const status = useQuery({ queryKey: ['system-status'], queryFn: api.systemStatus, refetchInterval: 60_000 });

  const ingest = useMutation({
    mutationFn: () => api.ingest(activeFarmId ? { farmId: activeFarmId, years: 12 } : { lat: location.lat, lon: location.lon, years: 12 }),
    onSuccess: (res) => {
      toast({
        title: 'NASA POWER record ingested',
        description: `${res.outcome.rowsWritten.toLocaleString()} real observations stored (${res.outcome.start} → ${res.outcome.end}); ${res.outcome.missingPoints} missing days reported.`,
      });
      queryClient.invalidateQueries({ queryKey: ['system-status'] });
      queryClient.invalidateQueries({ queryKey: ['observations'] });
    },
    onError: (err) => {
      toast({
        title: 'POWER ingestion failed',
        description: err instanceof ApiRequestError ? err.message : 'Unexpected error. No data fabricated.',
        variant: 'destructive',
      });
    },
  });

  const obs = useQuery({
    queryKey: ['observations', activeFarmId, location.lat, location.lon],
    queryFn: () => api.observations(activeFarmId ? { farmId: activeFarmId } : {}),
    enabled: !ingest.isPending,
  });

  const recentIngest = obs.data;

  return (
    <div className="mx-auto max-w-6xl flex flex-col gap-6">
      {/* Location control */}
      <Card className="border-slate-800 bg-slate-900/40">
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <MapPin className="h-4 w-4 text-emerald-400" aria-hidden /> Selected geography
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Select
              value={location.label}
              onValueChange={(v) => {
                const r = regions.data?.regions.find((x) => `${x.name}` === v);
                if (r) setLocation({ lat: r.lat, lon: r.lon, label: r.name, country: r.country, context: r.croppingContext });
              }}
            >
              <SelectTrigger className="w-full sm:w-80 bg-slate-900 border-slate-700 text-sm" aria-label="Select demo region">
                <SelectValue placeholder="Choose a region preset" />
              </SelectTrigger>
              <SelectContent className="bg-slate-900 border-slate-700 max-h-72">
                {(regions.data?.regions ?? []).map((r) => (
                  <SelectItem key={r.key} value={r.name} className="text-xs">
                    {r.name} · {r.country}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="font-mono text-xs text-slate-400">
              {location.lat.toFixed(3)}°, {location.lon.toFixed(3)}°
            </span>
            {activeFarmId && <Badge variant="outline" className="border-emerald-600/40 text-emerald-400">farm-linked</Badge>}
          </div>
          {location.context && <p className="text-xs text-slate-500 max-w-3xl">{location.context}</p>}
          <p className="text-[11px] text-slate-600">
            Curated real-region presets for the public demo; the map in the Geospatial Explorer lets you pick any coordinate.
          </p>
        </CardContent>
      </Card>

      {/* Ingestion control */}
      <Card className="border-slate-800 bg-slate-900/40">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Download className="h-4 w-4 text-sky-400" aria-hidden /> Environmental record ingestion
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-slate-400 max-w-3xl">
            Fetches the real NASA POWER daily record (precipitation, min/mean/max temperature, solar radiation,
            humidity, root-zone wetness) for the selected coordinate in 5-year chunks, and stores it with full
            provenance. Runs ~10–30 s.
          </p>
          <Button
            onClick={() => ingest.mutate()}
            disabled={ingest.isPending}
            className="w-fit bg-sky-600 hover:bg-sky-500 text-white"
          >
            {ingest.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
                Requesting NASA POWER…
              </>
            ) : (
              'Ingest 12-year POWER record'
            )}
          </Button>
          {ingest.isError && (
            <p className="text-xs text-red-400 max-w-3xl" role="alert">
              {ingest.error instanceof ApiRequestError ? ingest.error.message : 'Ingestion failed.'} No data was fabricated.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Coverage grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={<Database className="h-4 w-4 text-sky-400" />} label="Stored observations" value={(status.data?.database.observations ?? 0).toLocaleString()} sub="real NASA POWER values" />
        <StatCard icon={<FlameIcon /> } label="Fire detections" value={(status.data?.database.fireDetections ?? 0).toLocaleString()} sub="VIIRS 375 m, 2015→present" />
        <StatCard icon={<Clock className="h-4 w-4 text-emerald-400" />} label="Record start" value={recentIngest?.series?.PRECTOTCORR?.points?.[0]?.date?.slice(0, 4) ?? '—'} sub={recentIngest?.datasetVersions?.[0] ?? 'no record yet'} />
        <StatCard icon={<Database className="h-4 w-4 text-amber-400" />} label="Farms configured" value={String(status.data?.database.farms ?? 0)} sub="profiles with soil + scenarios" />
      </div>

      {/* Environmental indicators from the stored record */}
      <Card className="border-slate-800 bg-slate-900/40">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Recent observations & data coverage</CardTitle>
        </CardHeader>
        <CardContent>
          {obs.isLoading && <LoadingRow />}
          {obs.isError && (
            <p className="text-xs text-amber-400">Observation store unreachable — retrying automatically.</p>
          )}
          {obs.data && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {Object.entries(obs.data.series).map(([variable, s]) => {
                const last = [...s.points].reverse().find((p) => p.value !== null);
                return (
                  <div key={variable} className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">{variable}</span>
                      <span className="text-[10px] text-slate-600">{s.points.length} days</span>
                    </div>
                    <div className="mt-1 text-lg font-semibold text-slate-100 font-mono">
                      {last ? last.value.toFixed(1) : 'n/a'}
                      <span className="ml-1 text-[10px] font-normal text-slate-500">{s.unit}</span>
                    </div>
                    <div className="text-[10px] text-slate-600">latest: {last?.date ?? 'no valid value'}</div>
                  </div>
                );
              })}
              {Object.keys(obs.data.series).length === 0 && (
                <p className="text-xs text-slate-500 col-span-full">
                  No observations stored for this location yet — run the ingestion above, then head to
                  <button className="mx-1 underline text-emerald-400" onClick={() => setView('analysis')}>Environmental Analysis</button>
                  to detect trends.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function FlameIcon() {
  return <Flame className="h-4 w-4 text-amber-400" aria-hidden />;
}

function StatCard({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-slate-500">
        {icon} {label}
      </div>
      <div className="mt-1.5 text-2xl font-semibold text-slate-100 font-mono">{value}</div>
      <div className="text-[10px] text-slate-600 mt-0.5">{sub}</div>
    </div>
  );
}

function LoadingRow() {
  return (
    <div className="flex items-center gap-2 text-xs text-slate-500" role="status">
      <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> loading stored observations…
    </div>
  );
}
