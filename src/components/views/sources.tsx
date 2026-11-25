'use client';

import React, { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Database, Globe2, Radar, Search, UploadCloud } from 'lucide-react';
import { api, ApiRequestError, type RasterStatsResponse, type StacSearchResponse } from '@/lib/api-client';
import { useSession } from '@/components/state/store';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { HudPanel, SectionHeader, StatusPill } from '@/components/ui-mc/kit';
import { FaultPanel } from '@/components/system/query-state';

export function SourcesView() {
  const { location } = useSession();
  const { toast } = useToast();
  const sources = useQuery({ queryKey: ['sources'], queryFn: api.sources, retry: 1 });
  const [form, setForm] = useState({ from: '', to: '', collections: '', geometry: '', limit: 20, checkAssets: false });
  const [result, setResult] = useState<StacSearchResponse | null>(null);
  const [rasterFile, setRasterFile] = useState<File | null>(null);
  const [datasetVariable, setDatasetVariable] = useState('');
  const [datasetCrs, setDatasetCrs] = useState('');
  const [rasterResult, setRasterResult] = useState<RasterStatsResponse | null>(null);
  const raster = useMutation({
    mutationFn: () => {
      const name = (rasterFile?.name ?? '').toLowerCase();
      return name.endsWith('.nc') || name.endsWith('.nc4') || name.endsWith('.zip')
        ? api.rasterDataset(rasterFile!, { variable: datasetVariable || undefined, crs: datasetCrs || undefined })
        : api.rasterStats(rasterFile!);
    },
    onSuccess: (data) => setRasterResult(data),
    onError: (error) => toast({ title: 'Raster processing failed', description: error instanceof ApiRequestError ? error.message : 'Unexpected error.', variant: 'destructive' }),
  });
  const search = useMutation({
    mutationFn: () => api.stacSearch(form),
    onSuccess: (data) => setResult(data),
    onError: (error) => toast({ title: 'STAC discovery failed', description: error instanceof ApiRequestError ? error.message : 'Unexpected error.', variant: 'destructive' }),
  });
  const useCurrentArea = () => {
    const d = 0.1;
    setForm((current) => ({ ...current, geometry: JSON.stringify({ type: 'Polygon', coordinates: [[[location.lon - d, location.lat - d], [location.lon + d, location.lat - d], [location.lon + d, location.lat + d], [location.lon - d, location.lat + d], [location.lon - d, location.lat - d]]] }) }));
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <SectionHeader kicker="Data governance · provenance before presentation" title="Data Catalogue" description="Registered Earth-observation products, structured access/licensing metadata, and bounded STAC discovery. A catalogue entry never implies NASA endorsement or unrestricted commercial use." actions={<StatusPill status={`${sources.data?.sources.length ?? 0} registered sources`} pulse={false} className="border-aqua/40 text-aqua" />} />

      <HudPanel calm className="flex flex-col gap-3">
        <div className="flex items-center gap-2"><Database className="h-4 w-4 text-aqua" /><h3 className="font-display text-sm font-bold uppercase tracking-wide-mc text-ink">Governed source register</h3></div>
        {sources.isError ? <FaultPanel error={sources.error} onRetry={() => sources.refetch()} label="Data sources" /> : <div className="overflow-x-auto"><table className="mc-table w-full min-w-[900px]"><thead><tr><th>Provider / product</th><th>Version</th><th>Resolution</th><th>Access</th><th>License</th><th>Status</th></tr></thead><tbody>{(sources.data?.sources ?? []).map((source) => <tr key={source.id} className="border-b border-edge/60 align-top last:border-0"><td className="px-2 py-2"><span className="text-ink">{source.datasetName}</span><span className="telemetry ml-2 text-[10px] text-faint">{source.provider}</span><p className="mt-1 max-w-xl text-[10px] leading-relaxed text-faint">{source.limitations}</p></td><td className="telemetry px-2 py-2">{source.productVersion ?? source.productId ?? '—'}</td><td className="telemetry px-2 py-2">{source.nativeResolutionM ? `${source.nativeResolutionM.toLocaleString()} m` : source.spatialResolution}</td><td className="max-w-xs px-2 py-2 text-[10px] text-dim">{source.accessConditions ?? (source.authRequired ? 'Credentials required' : 'Public')}</td><td className="max-w-xs px-2 py-2 text-[10px] text-dim">{source.license}</td><td><StatusPill status={source.status} pulse={false} /></td></tr>)}</tbody></table></div>}
      </HudPanel>

      <HudPanel className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-2"><Radar className="h-4 w-4 text-iris" /><h3 className="font-display text-sm font-bold uppercase tracking-wide-mc text-ink">STAC discovery · NASA MAAP</h3><Globe2 className="ml-auto h-4 w-4 text-faint" /></div>
        <p className="text-[11px] leading-relaxed text-dim">Search up to 50 STAC items by geometry, date, and collection. Asset probes are optional and limited to five HEAD requests; no raster data is downloaded.</p>
        <div className="grid gap-3 md:grid-cols-4">
          <Label className="grid gap-1 text-[11px] text-dim">From<Input type="date" value={form.from} onChange={(event) => setForm({ ...form, from: event.target.value })} className="border-edge bg-panel text-ink" /></Label>
          <Label className="grid gap-1 text-[11px] text-dim">To<Input type="date" value={form.to} onChange={(event) => setForm({ ...form, to: event.target.value })} className="border-edge bg-panel text-ink" /></Label>
          <Label className="grid gap-1 text-[11px] text-dim">Collections (comma-separated)<Input value={form.collections} onChange={(event) => setForm({ ...form, collections: event.target.value })} placeholder="collection-id" className="border-edge bg-panel text-ink" /></Label>
          <Label className="grid gap-1 text-[11px] text-dim">Limit<Input type="number" min={1} max={50} value={form.limit} onChange={(event) => setForm({ ...form, limit: Number(event.target.value) })} className="border-edge bg-panel text-ink" /></Label>
        </div>
        <Label className="grid gap-1 text-[11px] text-dim">GeoJSON Polygon / MultiPolygon (optional)<Textarea value={form.geometry} onChange={(event) => setForm({ ...form, geometry: event.target.value })} rows={3} placeholder='{"type":"Polygon","coordinates":[...]}' className="border-edge bg-panel font-mono text-[11px] text-ink" /></Label>
        <div className="flex flex-wrap items-center gap-3"><Button onClick={useCurrentArea} variant="outline" className="h-8 font-mono text-[10px] uppercase tracking-wide-mc">Use current map area</Button><label className="flex items-center gap-2 text-[11px] text-dim"><input type="checkbox" checked={form.checkAssets} onChange={(event) => setForm({ ...form, checkAssets: event.target.checked })} />Probe up to five assets</label><Button onClick={() => search.mutate()} disabled={search.isPending} className="ml-auto h-9 font-mono text-xs uppercase tracking-wide-mc"><Search className="h-3.5 w-3.5" />{search.isPending ? 'Searching STAC…' : 'Discover items'}</Button></div>
      </HudPanel>

      <HudPanel calm className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-2"><UploadCloud className="h-4 w-4 text-signal" /><h3 className="font-display text-sm font-bold uppercase tracking-wide-mc text-ink">Quantitative raster statistics</h3></div>
        <p className="text-[11px] leading-relaxed text-dim">Upload a GeoTIFF (≤ 50 MB) for pixel statistics, or a NetCDF/Zarr ZIP with CRS metadata for dataset statistics. Clipping, reprojection, resampling, nodata handling, and lineage are shared across all formats.</p>
        <div className="flex flex-wrap items-center gap-3"><input type="file" accept=".tif,.tiff,image/tiff,.nc,.nc4,.zip" onChange={(event) => setRasterFile(event.target.files?.[0] ?? null)} className="text-xs text-dim" /><Input value={datasetVariable} onChange={(event) => setDatasetVariable(event.target.value)} placeholder="Dataset variable (optional)" className="h-9 w-48 border-edge bg-panel text-ink" /><Input value={datasetCrs} onChange={(event) => setDatasetCrs(event.target.value)} placeholder="CRS override (optional)" className="h-9 w-40 border-edge bg-panel text-ink" /><Button onClick={() => raster.mutate()} disabled={raster.isPending || !rasterFile} className="h-9 font-mono text-xs uppercase tracking-wide-mc">{raster.isPending ? 'Processing…' : 'Compute statistics'}</Button></div>
        {rasterResult && <pre className="max-h-80 overflow-auto rounded-sm border border-edge bg-void p-3 font-mono text-[11px] text-dim">{JSON.stringify(rasterResult, null, 2)}</pre>}
      </HudPanel>

      {result && <HudPanel calm className="flex flex-col gap-3"><div className="flex items-center gap-2"><StatusPill status={`${result.count} STAC items`} pulse={false} /><span className="telemetry text-[10px] text-faint">retrieved {result.retrievedAt}</span></div><div className="grid gap-2">{result.items.map((item) => <div key={item.id} className="border-b border-edge/60 py-2 last:border-0"><div className="flex flex-wrap items-center gap-2"><span className="font-mono text-xs text-ink">{item.id}</span><StatusPill status={item.collection ?? 'no collection'} pulse={false} />{item.cloudCover !== null && <span className="telemetry text-[10px] text-faint">cloud {item.cloudCover}%</span>}</div><p className="telemetry mt-1 text-[10px] text-faint">{item.datetime ?? item.start ?? 'time unknown'}</p><div className="mt-1 flex flex-wrap gap-2">{item.assets.map((asset) => /^https?:/i.test(asset.href) ? <a key={asset.name} href={asset.href} target="_blank" rel="noreferrer" className="font-mono text-[10px] text-aqua underline">{asset.name}</a> : <span key={asset.name} className="font-mono text-[10px] text-faint" title={asset.href}>{asset.name} · provider access</span>)}</div></div>)}</div>{result.assetAccessibility.length > 0 && <div className="border-t border-edge pt-2"><p className="font-mono text-[9px] uppercase tracking-wide-mc text-faint">Asset accessibility</p>{result.assetAccessibility.map((asset) => <p key={asset.href} className="telemetry mt-1 text-[10px] text-dim">{asset.status ?? '—'} · {asset.note} · {asset.href}</p>)}</div>}<p className="text-[10px] leading-relaxed text-caution">{result.limitations.join(' ')}</p></HudPanel>}
    </div>
  );
}
