'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { Settings, Activity, Database, Zap, RefreshCw, ServerCog } from 'lucide-react';

/** Settings & System Health. */
export function SettingsView() {
  const status = useQuery({ queryKey: ['system-status'], queryFn: api.systemStatus, refetchInterval: 30_000 });
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const invalidate = useMutation({
    mutationFn: async () => {
      await fetch('/api/v1/system/status?action=invalidate-cache', { method: 'POST' });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['system-status'] });
      toast({ title: 'Cache invalidated', description: 'Provider responses will be re-fetched on next use.' });
    },
  });

  const s = status.data;

  return (
    <div className="mx-auto max-w-5xl flex flex-col gap-6" id="system-health">
      <Card className="border-slate-800 bg-slate-900/40">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4 text-emerald-400" aria-hidden /> Provider availability
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {Object.entries(s?.providers ?? {}).map(([name, p]) => (
            <div key={name} className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-slate-200">{name}</span>
                <Badge variant="outline" className={p.status.startsWith('operational') ? 'border-emerald-600/40 text-emerald-400' : 'border-amber-600/40 text-amber-400'}>
                  {p.status.split(' ')[0]}
                </Badge>
              </div>
              <p className="mt-1 text-[11px] text-slate-500">{p.status}{p.note ? ` — ${p.note}` : ''}</p>
            </div>
          ))}
          {status.isLoading && <p className="text-xs text-slate-500">checking providers…</p>}
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card className="border-slate-800 bg-slate-900/40">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base"><Database className="h-4 w-4 text-sky-400" aria-hidden /> Data store</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-slate-400 flex flex-col gap-1.5">
            <Row k="Environmental observations" v={(s?.database.observations ?? 0).toLocaleString()} />
            <Row k="Fire detections" v={(s?.database.fireDetections ?? 0).toLocaleString()} />
            <Row k="Farms" v={String(s?.database.farms ?? 0)} />
            <Row k="Jobs" v={(s?.database.jobCounts ?? []).map((j) => `${j.count} ${j.status}`).join(', ') || 'none'} />
            <Row k="Trend engine" v={s?.engines.trendEngine ?? '—'} />
            <Row k="Rotation engine" v={s?.engines.rotationEngine ?? '—'} />
            <Row k="Crop catalogue" v={s?.engines.cropCatalogue ?? '—'} />
          </CardContent>
        </Card>

        <Card className="border-slate-800 bg-slate-900/40">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base"><Zap className="h-4 w-4 text-amber-400" aria-hidden /> Reliability controls</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-slate-400 flex flex-col gap-1.5">
            {Object.entries(s?.reliability ?? {}).map(([k, v]) => <Row key={k} k={k} v={v} />)}
            <div className="mt-2 flex flex-wrap gap-2">
              <Badge variant="outline" className="border-slate-700 text-slate-300">cache: {s?.cache.liveEntries ?? 0} live / {s?.cache.expiredEntries ?? 0} expired</Badge>
              {(s?.circuitBreakers ?? []).filter((c) => c.open).map((c) => (
                <Badge key={c.provider} variant="outline" className="border-red-600/40 text-red-400">
                  circuit open: {c.provider} ({Math.ceil(c.cooldownRemainingMs / 1000)}s)
                </Badge>
              ))}
              {(s?.circuitBreakers ?? []).filter((c) => !c.open && c.consecutiveFailures > 0).map((c) => (
                <Badge key={c.provider} variant="outline" className="border-amber-600/40 text-amber-400">
                  {c.provider}: {c.consecutiveFailures} recent failure(s)
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {(s?.database.failedJobs.length ?? 0) > 0 && (
        <Card className="border-red-800/40 bg-red-500/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-base text-red-300">Failed ingestion jobs</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-red-200/80 flex flex-col gap-1">
            {s?.database.failedJobs.map((j) => (
              <div key={j.id} className="font-mono text-[11px]">
                [{j.type}] {j.error} — {new Date(j.startedAt).toISOString().slice(0, 19).replace('T', ' ')}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card className="border-slate-800 bg-slate-900/40">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><ServerCog className="h-4 w-4 text-slate-400" aria-hidden /> Operations</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" className="border-slate-700 text-slate-200 h-8 text-xs" onClick={() => invalidate.mutate()} disabled={invalidate.isPending}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden /> Invalidate response cache
          </Button>
          <Button variant="outline" size="sm" className="border-slate-700 text-slate-200 h-8 text-xs" onClick={() => queryClient.invalidateQueries()}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden /> Refresh all dashboard data
          </Button>
        </CardContent>
      </Card>

      <Card className="border-slate-800 bg-slate-900/40">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><Settings className="h-4 w-4 text-slate-400" aria-hidden /> Methodology (as executed)</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-slate-400 flex flex-col gap-2">
          <p><span className="text-slate-300 font-medium">Trend detection:</span> {s?.methodology.trend}</p>
          <p><span className="text-slate-300 font-medium">Rotation scoring:</span> {s?.methodology.rotation}</p>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-slate-800/60 pb-1">
      <span className="text-slate-500">{k}</span>
      <span className="text-right text-slate-200 break-all">{v}</span>
    </div>
  );
}
