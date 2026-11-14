'use client';

import { useState } from 'react';
import { useSession } from '@/components/state/store';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiRequestError, type SoilTest } from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { Loader2, MapPin, FlaskConical, Sprout, Mountain, Save, Plus, Beaker } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Farm Workspace: profile, boundary, soil tests, crop history. */
export function FarmWorkspaceView() {
  const { activeFarmId, setActiveFarmId, location, farmBoundary, setFarmBoundary, setView } = useSession();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const farms = useQuery({ queryKey: ['farms'], queryFn: api.farms });
  const farm = useQuery({ queryKey: ['farm', activeFarmId], queryFn: () => api.farm(activeFarmId!), enabled: !!activeFarmId });

  const [newFarm, setNewFarm] = useState({ name: '', country: '', region: '' });

  const createFarm = useMutation({
    mutationFn: async () => {
      const boundaryGeoJson = farmBoundary && farmBoundary.length >= 3
        ? JSON.stringify({ type: 'Polygon', coordinates: [[...farmBoundary, farmBoundary[0]]] })
        : undefined;
      return api.createFarm({
        name: newFarm.name || 'My Farm',
        centroidLat: location.lat,
        centroidLon: location.lon,
        country: newFarm.country || undefined,
        region: newFarm.region || undefined,
        boundaryGeoJson,
      });
    },
    onSuccess: (res) => {
      setActiveFarmId(res.farm.id);
      setFarmBoundary(null);
      queryClient.invalidateQueries({ queryKey: ['farms'] });
      queryClient.invalidateQueries({ queryKey: ['farm'] });
      toast({ title: 'Farm created', description: `${res.farm.name} at ${res.farm.centroidLat.toFixed(3)}, ${res.farm.centroidLon.toFixed(3)}.` });
    },
    onError: (err) => {
      toast({ title: 'Farm creation failed', description: err instanceof ApiRequestError ? err.message : 'error', variant: 'destructive' });
    },
  });

  const saveBoundary = useMutation({
    mutationFn: (farmId: string) => {
      if (!farmBoundary || farmBoundary.length < 3) throw new Error('Draw a boundary with ≥ 3 vertices on the map first');
      const ring = [...farmBoundary, farmBoundary[0]];
      return api.updateFarm(farmId, { boundaryGeoJson: JSON.stringify({ type: 'Polygon', coordinates: [ring] }) });
    },
    onSuccess: () => {
      setFarmBoundary(null);
      queryClient.invalidateQueries({ queryKey: ['farm'] });
      toast({ title: 'Boundary saved', description: 'Validated GeoJSON polygon stored with the farm profile.' });
    },
    onError: (err) => {
      toast({ title: 'Boundary not saved', description: err instanceof Error ? err.message : 'error', variant: 'destructive' });
    },
  });

  const soilGrids = useMutation({
    mutationFn: (farmId: string) => api.fetchSoilGrids(farmId),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['farm'] });
      toast({
        title: 'SoilGrids profile stored',
        description: `Modeled values: ${res.retrieved.map((r) => `${r.property} ${r.value.toFixed(1)} ${r.unit}`).join(', ')}. Clearly labeled as model estimates.`,
      });
    },
    onError: (err) => {
      toast({
        title: 'SoilGrids unavailable',
        description: err instanceof ApiRequestError ? err.message : 'Provider unreachable — no values fabricated.',
        variant: 'destructive',
      });
    },
  });

  return (
    <div className="mx-auto max-w-6xl flex flex-col gap-6">
      {/* Farm list + creation */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="border-slate-800 bg-slate-900/40">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base"><MapPin className="h-4 w-4 text-emerald-400" aria-hidden /> Your farms</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {farms.isLoading && <p className="text-xs text-slate-500">loading farms…</p>}
            {(farms.data?.farms ?? []).map((f) => (
              <button
                key={f.id}
                onClick={() => setActiveFarmId(f.id)}
                className={cn(
                  'text-left rounded-lg border p-3 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-emerald-400',
                  activeFarmId === f.id ? 'border-emerald-600/50 bg-emerald-500/5' : 'border-slate-800 bg-slate-900/60 hover:bg-slate-800/60',
                )}
                aria-pressed={activeFarmId === f.id}
              >
                <div className="font-medium text-slate-100">{f.name}</div>
                <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-slate-500">
                  <span className="font-mono">{f.centroidLat.toFixed(3)}, {f.centroidLon.toFixed(3)}</span>
                  {f.country && <span>{f.country}</span>}
                  <span>{f._count.soilTests} soil tests</span>
                  <span>{f._count.scenarios} scenarios</span>
                </div>
              </button>
            ))}
            {farms.data?.farms.length === 0 && (
              <p className="text-xs text-slate-500">No farms yet — create one on the right. The public demo needs no signup.</p>
            )}
          </CardContent>
        </Card>

        <Card className="border-slate-800 bg-slate-900/40">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Create a farm at the selected location</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-[11px] text-slate-500">
              Location comes from the header selector / Explorer map. If you drew a boundary there
              ({farmBoundary?.length ?? 0} vertices in session), it will be validated and stored with the farm.
            </p>
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="farm-name" className="text-[10px] uppercase tracking-wider text-slate-500">Name</Label>
                <Input id="farm-name" value={newFarm.name} onChange={(e) => setNewFarm({ ...newFarm, name: e.target.value })} placeholder="e.g. Kilimo Bora Block 3" className="bg-slate-900 border-slate-700" />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="farm-country" className="text-[10px] uppercase tracking-wider text-slate-500">Country</Label>
                <Input id="farm-country" value={newFarm.country} onChange={(e) => setNewFarm({ ...newFarm, country: e.target.value })} placeholder="Kenya" className="bg-slate-900 border-slate-700" />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="farm-region" className="text-[10px] uppercase tracking-wider text-slate-500">Region</Label>
                <Input id="farm-region" value={newFarm.region} onChange={(e) => setNewFarm({ ...newFarm, region: e.target.value })} placeholder="Rift Valley" className="bg-slate-900 border-slate-700" />
              </div>
            </div>
            <div className="text-xs text-slate-400 font-mono">{location.lat.toFixed(3)}°, {location.lon.toFixed(3)}° — {location.label}</div>
            <Button onClick={() => createFarm.mutate()} disabled={createFarm.isPending} className="w-fit bg-emerald-600 hover:bg-emerald-500 text-white">
              {createFarm.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Plus className="mr-1 h-4 w-4" aria-hidden />}
              Create farm
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Active farm profile */}
      {activeFarmId && farm.data && (
        <>
          <Card className="border-slate-800 bg-slate-900/40">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex flex-wrap items-center gap-2">
                Farm profile · <span className="text-slate-300 font-normal">{farm.data.farm.name}</span>
                {farm.data.farm.areaHa && <Badge variant="outline" className="border-slate-700 text-slate-400">{farm.data.farm.areaHa.toFixed(1)} ha (computed)</Badge>}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-xs text-slate-400">
              <div className="flex flex-wrap gap-x-6 gap-y-1">
                <span>Centroid: <span className="font-mono text-slate-200">{farm.data.farm.centroidLat.toFixed(4)}, {farm.data.farm.centroidLon.toFixed(4)}</span></span>
                <span>Boundary: {farm.data.farm.boundaryGeoJson ? 'stored (validated polygon)' : 'none'}</span>
                <span>Stored observations: {farm.data.farm._count.observations.toLocaleString()}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline" size="sm" className="border-slate-700 text-slate-200 h-8 text-xs"
                  onClick={() => setView('explorer')}
                >
                  <MapPin className="mr-1 h-3.5 w-3.5" aria-hidden /> Draw boundary on map
                </Button>
                <Button
                  variant="outline" size="sm" className="border-slate-700 text-slate-200 h-8 text-xs"
                  disabled={!farmBoundary || farmBoundary.length < 3}
                  onClick={() => saveBoundary.mutate(activeFarmId)}
                >
                  <Save className="mr-1 h-3.5 w-3.5" aria-hidden /> Save drawn boundary ({farmBoundary?.length ?? 0})
                </Button>
              </div>
              <CropHistoryEditor farmId={activeFarmId} current={farm.data.farm.cropHistory} />
            </CardContent>
          </Card>

          <SoilSection farmId={activeFarmId} tests={farm.data.farm.soilTests} onSoilGrids={() => soilGrids.mutate(activeFarmId)} soilGridsPending={soilGrids.isPending} />
        </>
      )}

      {!activeFarmId && (
        <Card className="border-dashed border-slate-800 bg-slate-900/20">
          <CardContent className="py-8 text-center text-sm text-slate-500">
            Select or create a farm above to manage its profile, soil tests and crop history.
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function CropHistoryEditor({ farmId, current }: { farmId: string; current: string | null }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [entries, setEntries] = useState<{ season: string; crop: string; family?: string }[]>(
    current ? JSON.parse(current) : [],
  );
  const update = useMutation({
    mutationFn: () => api.updateFarm(farmId, { cropHistory: entries }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['farm'] });
      toast({ title: 'Crop history saved' });
    },
  });
  return (
    <div className="mt-1 rounded-lg border border-slate-800 bg-slate-900/60 p-3">
      <div className="flex items-center gap-1.5 text-xs font-medium text-slate-300">
        <Sprout className="h-3.5 w-3.5 text-emerald-400" aria-hidden /> Previous crop sequence (farmer-supplied)
      </div>
      <div className="mt-2 flex flex-col gap-2">
        {entries.map((e, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2 text-xs">
            <Input value={e.season} onChange={(ev) => setEntries(entries.map((x, j) => j === i ? { ...x, season: ev.target.value } : x))} placeholder="Season (e.g. 2025 long rains)" className="w-44 bg-slate-900 border-slate-700 h-8" aria-label={`Season ${i + 1}`} />
            <Input value={e.crop} onChange={(ev) => setEntries(entries.map((x, j) => j === i ? { ...x, crop: ev.target.value } : x))} placeholder="Crop" className="w-36 bg-slate-900 border-slate-700 h-8" aria-label={`Crop ${i + 1}`} />
            <Button variant="ghost" size="sm" className="h-8 px-2 text-slate-500" onClick={() => setEntries(entries.filter((_, j) => j !== i))} aria-label="Remove entry">Remove</Button>
          </div>
        ))}
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="h-8 text-xs border-slate-700" onClick={() => setEntries([...entries, { season: '', crop: '' }])}>Add season</Button>
          <Button size="sm" className="h-8 text-xs bg-emerald-600 hover:bg-emerald-500 text-white" disabled={update.isPending} onClick={() => update.mutate()}>Save history</Button>
        </div>
      </div>
    </div>
  );
}

function SoilSection({ farmId, tests, onSoilGrids, soilGridsPending }: { farmId: string; tests: SoilTest[]; onSoilGrids: () => void; soilGridsPending: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    source: 'farmer' as 'farmer' | 'laboratory',
    measuredAt: new Date().toISOString().slice(0, 10),
    ph: '', texture: '', organicCarbonPct: '', nitrogenMgKg: '', phosphorusMgKg: '', potassiumCmolKg: '',
    sandPct: '', siltPct: '', clayPct: '', depthCm: '', notes: '',
  });
  const [textureSelect, setTextureSelect] = useState('none');

  const addTest = useMutation({
    mutationFn: () => {
      const num = (v: string) => (v.trim() === '' ? undefined : Number(v));
      return api.addSoilTest(farmId, {
        source: form.source,
        measuredAt: form.measuredAt,
        ph: num(form.ph),
        texture: textureSelect !== 'none' ? textureSelect : undefined,
        organicCarbonPct: num(form.organicCarbonPct),
        nitrogenMgKg: num(form.nitrogenMgKg),
        phosphorusMgKg: num(form.phosphorusMgKg),
        potassiumCmolKg: num(form.potassiumCmolKg),
        sandPct: num(form.sandPct),
        siltPct: num(form.siltPct),
        clayPct: num(form.clayPct),
        depthCm: num(form.depthCm),
        notes: form.notes.trim() || undefined,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['farm'] });
      toast({ title: 'Soil measurement stored', description: `Labeled as ${form.source} measurement — never mixed with modeled values.` });
      setForm({ ...form, ph: '', organicCarbonPct: '', nitrogenMgKg: '', phosphorusMgKg: '', potassiumCmolKg: '', sandPct: '', siltPct: '', clayPct: '', notes: '' });
    },
    onError: (err) => toast({ title: 'Validation failed', description: err instanceof ApiRequestError ? err.message : 'check values', variant: 'destructive' }),
  });

  return (
    <Card className="border-slate-800 bg-slate-900/40">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <FlaskConical className="h-4 w-4 text-amber-400" aria-hidden /> Soil properties
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {tests.length > 0 ? (
          <div className="overflow-x-auto rounded-lg border border-slate-800">
            <table className="w-full text-xs">
              <thead className="bg-slate-900/80 text-slate-400">
                <tr>
                  <th className="px-2.5 py-2 text-left font-medium">Source</th>
                  <th className="px-2.5 py-2 text-left font-medium">Date</th>
                  <th className="px-2.5 py-2 text-left font-medium">pH</th>
                  <th className="px-2.5 py-2 text-left font-medium">Texture</th>
                  <th className="px-2.5 py-2 text-left font-medium">OC %</th>
                  <th className="px-2.5 py-2 text-left font-medium">N mg/kg</th>
                  <th className="px-2.5 py-2 text-left font-medium">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800 text-slate-300">
                {tests.map((t) => (
                  <tr key={t.id} className={t.source === 'soilgrids' ? 'bg-amber-500/5' : ''}>
                    <td className="px-2.5 py-2">
                      <Badge variant="outline" className={t.source === 'soilgrids' ? 'border-amber-600/40 text-amber-400' : t.source === 'laboratory' ? 'border-emerald-600/40 text-emerald-400' : 'border-sky-600/40 text-sky-400'}>
                        {t.source}
                      </Badge>
                    </td>
                    <td className="px-2.5 py-2">{new Date(t.measuredAt).toISOString().slice(0, 10)}</td>
                    <td className="px-2.5 py-2 font-mono">{t.ph?.toFixed(1) ?? '—'}</td>
                    <td className="px-2.5 py-2">{t.texture ?? '—'}</td>
                    <td className="px-2.5 py-2 font-mono">{t.organicCarbonPct?.toFixed(1) ?? '—'}</td>
                    <td className="px-2.5 py-2 font-mono">{t.nitrogenMgKg ?? '—'}</td>
                    <td className="px-2.5 py-2 max-w-[18rem] truncate" title={t.sourceDetail ?? t.notes ?? ''}>{t.sourceDetail ?? t.notes ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-slate-500">No soil information yet. Enter a farmer/lab test below, or fetch the supplementary SoilGrids modeled profile.</p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" className="border-amber-700/50 text-amber-300 hover:bg-amber-500/10 h-8 text-xs" onClick={onSoilGrids} disabled={soilGridsPending}>
            {soilGridsPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> : <Mountain className="mr-1 h-3.5 w-3.5" aria-hidden />}
            Fetch SoilGrids modeled profile (supplementary)
          </Button>
        </div>

        {/* Manual entry */}
        <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
          <div className="flex items-center gap-1.5 text-xs font-medium text-slate-300">
            <Beaker className="h-3.5 w-3.5 text-emerald-400" aria-hidden /> Enter a soil measurement (farmer or laboratory)
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
            <Field label="Source">
              <Select value={form.source} onValueChange={(v) => setForm({ ...form, source: v as 'farmer' | 'laboratory' })}>
                <SelectTrigger className="bg-slate-900 border-slate-700 h-9 text-xs" aria-label="Measurement source"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-slate-900 border-slate-700">
                  <SelectItem value="farmer" className="text-xs">Farmer measurement</SelectItem>
                  <SelectItem value="laboratory" className="text-xs">Laboratory report</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Measured at">
              <Input type="date" value={form.measuredAt} onChange={(e) => setForm({ ...form, measuredAt: e.target.value })} className="bg-slate-900 border-slate-700 h-9 text-xs" />
            </Field>
            <Field label="pH (0–14)">
              <Input type="number" step="0.1" value={form.ph} onChange={(e) => setForm({ ...form, ph: e.target.value })} className="bg-slate-900 border-slate-700 h-9 text-xs" aria-label="pH value" />
            </Field>
            <Field label="Texture class">
              <Select value={textureSelect} onValueChange={setTextureSelect}>
                <SelectTrigger className="bg-slate-900 border-slate-700 h-9 text-xs" aria-label="Texture class"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-slate-900 border-slate-700">
                  {['none', 'sand', 'sandy loam', 'loam', 'silt loam', 'clay loam', 'clay'].map((t) => (
                    <SelectItem key={t} value={t} className="text-xs">{t === 'none' ? '— select —' : t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Depth (cm)">
              <Input type="number" value={form.depthCm} onChange={(e) => setForm({ ...form, depthCm: e.target.value })} className="bg-slate-900 border-slate-700 h-9 text-xs" aria-label="Sampling depth in cm" />
            </Field>
            <Field label="Organic C (%)">
              <Input type="number" step="0.01" value={form.organicCarbonPct} onChange={(e) => setForm({ ...form, organicCarbonPct: e.target.value })} className="bg-slate-900 border-slate-700 h-9 text-xs" aria-label="Organic carbon percent" />
            </Field>
            <Field label="Total N (mg/kg)">
              <Input type="number" value={form.nitrogenMgKg} onChange={(e) => setForm({ ...form, nitrogenMgKg: e.target.value })} className="bg-slate-900 border-slate-700 h-9 text-xs" aria-label="Total nitrogen mg per kg" />
            </Field>
            <Field label="P (mg/kg)">
              <Input type="number" value={form.phosphorusMgKg} onChange={(e) => setForm({ ...form, phosphorusMgKg: e.target.value })} className="bg-slate-900 border-slate-700 h-9 text-xs" aria-label="Phosphorus mg per kg" />
            </Field>
            <Field label="K (cmol/kg)">
              <Input type="number" value={form.potassiumCmolKg} onChange={(e) => setForm({ ...form, potassiumCmolKg: e.target.value })} className="bg-slate-900 border-slate-700 h-9 text-xs" aria-label="Potassium cmol per kg" />
            </Field>
            <Field label="Notes">
              <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="lab / method" className="bg-slate-900 border-slate-700 h-9 text-xs" aria-label="Notes" />
            </Field>
          </div>
          <Button size="sm" className="mt-3 h-8 text-xs bg-emerald-600 hover:bg-emerald-500 text-white" disabled={addTest.isPending} onClick={() => addTest.mutate()}>
            {addTest.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> : null}
            Store measurement
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-slate-500">{label}</span>
      {children}
    </label>
  );
}
