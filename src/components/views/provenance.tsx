'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollText, Database, CheckCircle2, XCircle } from 'lucide-react';

/** Evidence & Provenance: request ledger, source register, methodology pointer. */
export function ProvenanceView() {
  const [provider, setProvider] = useState<string>('all');
  const provenance = useQuery({
    queryKey: ['provenance', provider],
    queryFn: () => api.provenance(120),
    refetchInterval: 30_000,
  });

  const logs = (provenance.data?.requestLog ?? []).filter((l) => provider === 'all' || l.provider === provider);
  const providers = [...new Set((provenance.data?.requestLog ?? []).map((l) => l.provider))];

  return (
    <div className="mx-auto max-w-6xl flex flex-col gap-6">
      <Card className="border-slate-800 bg-slate-900/40">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ScrollText className="h-4 w-4 text-emerald-400" aria-hidden /> API request ledger
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            {provenance.data && (
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge variant="outline" className="border-slate-700 text-slate-300">{provenance.data.summary.requestsLogged} logged</Badge>
                <Badge variant="outline" className="border-emerald-600/40 text-emerald-400">{provenance.data.summary.ok} ok</Badge>
                <Badge variant="outline" className="border-red-600/40 text-red-400">{provenance.data.summary.failed} failed</Badge>
                {providers.map((p) => (
                  <button
                    key={p}
                    onClick={() => setProvider(provider === p ? 'all' : p)}
                    className={`rounded-md border px-2 py-0.5 transition-colors ${provider === p ? 'border-emerald-600/50 text-emerald-300 bg-emerald-500/10' : 'border-slate-700 text-slate-400 hover:bg-slate-800'}`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            )}
          </div>
          <p className="text-[11px] text-slate-500 max-w-3xl">
            Every external request this platform has made, successful or not, with status, latency, response size,
            correlation ID and retrieval timestamp. This is the evidence chain behind every number shown elsewhere.
          </p>
          <div className="overflow-x-auto rounded-lg border border-slate-800 max-h-[28rem] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-900/80 text-slate-400 sticky top-0">
                <tr>
                  <th className="px-2.5 py-2 text-left font-medium">Time</th>
                  <th className="px-2.5 py-2 text-left font-medium">Provider</th>
                  <th className="px-2.5 py-2 text-left font-medium">Operation</th>
                  <th className="px-2.5 py-2 text-left font-medium">Status</th>
                  <th className="px-2.5 py-2 text-left font-medium">Latency</th>
                  <th className="px-2.5 py-2 text-left font-medium">Bytes</th>
                  <th className="px-2.5 py-2 text-left font-medium">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800 text-slate-300">
                {logs.map((l) => (
                  <tr key={l.id} className="bg-slate-900/30">
                    <td className="px-2.5 py-1.5 font-mono text-[10px] whitespace-nowrap">{new Date(l.retrievedAt).toISOString().slice(11, 19)}</td>
                    <td className="px-2.5 py-1.5">{l.provider}</td>
                    <td className="px-2.5 py-1.5 font-mono text-[10px]">{l.operation}</td>
                    <td className="px-2.5 py-1.5">
                      <span className="inline-flex items-center gap-1">
                        {l.ok ? <CheckCircle2 className="h-3 w-3 text-emerald-400" aria-hidden /> : <XCircle className="h-3 w-3 text-red-400" aria-hidden />}
                        <span className="font-mono">{l.status}</span>
                      </span>
                    </td>
                    <td className="px-2.5 py-1.5 font-mono">{l.latencyMs} ms</td>
                    <td className="px-2.5 py-1.5 font-mono">{l.responseBytes ? `${(l.responseBytes / 1024).toFixed(1)} kB` : '—'}</td>
                    <td className="px-2.5 py-1.5 text-[10px] text-slate-500 max-w-[16rem] truncate" title={l.errorDetail ?? l.requestUrl}>
                      {l.errorDetail ?? l.requestUrl.slice(0, 80)}
                    </td>
                  </tr>
                ))}
                {logs.length === 0 && (
                  <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-500">No requests logged yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card className="border-slate-800 bg-slate-900/40">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Database className="h-4 w-4 text-sky-400" aria-hidden /> Data-source register
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {(provenance.data?.sources ?? []).map((s) => (
            <div key={s.id} className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-slate-100">{s.datasetName}</span>
                <Badge variant="outline" className={s.status === 'operational' ? 'border-emerald-600/40 text-emerald-400' : 'border-amber-600/40 text-amber-400'}>
                  {s.status}
                </Badge>
                {s.authRequired && <Badge variant="outline" className="border-amber-600/40 text-amber-400">auth required</Badge>}
              </div>
              <dl className="mt-2 grid gap-x-6 gap-y-1 text-[11px] sm:grid-cols-2 lg:grid-cols-3">
                <Row k="Provider" v={s.provider} />
                <Row k="Product" v={s.productId ?? '—'} />
                <Row k="Format" v={s.dataFormat} />
                <Row k="Coverage" v={s.temporalCoverage} />
                <Row k="Resolution" v={s.spatialResolution} />
                <Row k="Units" v={s.units ?? '—'} />
                <Row k="License" v={s.license} />
                <Row k="Attribution" v={s.attribution} />
                <Row k="Rate limits" v={s.rateLimit ?? '—'} />
              </dl>
              <p className="mt-2 text-[11px] leading-relaxed text-slate-500"><span className="text-slate-400">Limitations:</span> {s.limitations}</p>
              <p className="mt-1 text-[10px] text-slate-600 font-mono break-all">{s.endpointTemplate}</p>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-slate-600">{k}</dt>
      <dd className="text-slate-300">{v}</dd>
    </div>
  );
}
