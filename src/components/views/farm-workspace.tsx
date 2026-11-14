'use client';

import { useState } from 'react';
import { motion, type Variants } from 'framer-motion';
import { useSession } from '@/components/state/store';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiRequestError, type SoilTest } from '@/lib/api-client';
import { logEvent } from '@/components/state/log-store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { Kicker, SectionHeader, TelemetryStat, HudPanel, CoordReadout } from '@/components/ui-mc/kit';
import { QueryState, EmptyState, FaultPanel } from '@/components/system/query-state';
import { SkeletonPanel } from '@/components/system/skeletons';
import { MapPin, FlaskConical, Sprout, Mountain, Save, Plus, Beaker, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Staggered section entrance (y:12→0, 0.35s, ~60ms stagger, once). */
const RISE: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: (i: number = 0) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.35, delay: Math.min(i, 6) * 0.06, ease: [0.22, 1, 0.36, 1] },
  }),
};

const MONO_BTN = 'font-mono text-[11px] uppercase tracking-wide-mc';

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
      logEvent({
        severity: 'success',
        category: 'FARM',
        title: `Farm created — ${res.farm.name}`,
        detail: `Profile registered at ${res.farm.centroidLat.toFixed(3)}, ${res.farm.centroidLon.toFixed(3)}${farmBoundary ? ' with a drawn boundary polygon' : ' (no boundary yet)'}. Made the active farm.`,
        view: 'farm',
      });
    },
    onError: (err) => {
      toast({ title: 'Farm creation failed', description: err instanceof ApiRequestError ? err.message : 'error', variant: 'destructive' });
      logEvent({
        severity: 'crit',
        category: 'FARM',
        title: 'Farm creation failed',
        detail: err instanceof ApiRequestError ? `${err.code} — ${err.message}` : 'Unexpected error.',
        correlationId: err instanceof ApiRequestError ? err.correlationId : undefined,
        view: 'farm',
      });
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
      logEvent({
        severity: 'success',
        category: 'FARM',
        title: 'Farm boundary saved',
        detail: `${farmBoundary ? farmBoundary.length : 0}-vertex GeoJSON polygon stored with the farm profile and re-validated.`,
        view: 'farm',
      });
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
      logEvent({
        severity: 'success',
        category: 'FARM',
        title: 'SoilGrids supplementary profile stored',
        detail: `Modeled values retrieved from ISRIC SoilGrids 2.0: ${res.retrieved.map((r) => `${r.property} ${r.value.toFixed(1)} ${r.unit}`).join(', ')}. Stored as MODEL estimates, clearly labeled — never blended with measured tests.`,
        view: 'farm',
      });
    },
    onError: (err) => {
      toast({
        title: 'SoilGrids unavailable',
        description: err instanceof ApiRequestError ? err.message : 'Provider unreachable — no values fabricated.',
        variant: 'destructive',
      });
      logEvent({
        severity: 'crit',
        category: 'FARM',
        title: 'SoilGrids request failed',
        detail: err instanceof ApiRequestError ? `${err.code} — ${err.message}` : 'Provider unreachable — no values fabricated.',
        correlationId: err instanceof ApiRequestError ? err.correlationId : undefined,
        view: 'farm',
      });
    },
  });

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <motion.div variants={RISE} custom={0} initial="hidden" whileInView="show" viewport={{ once: true }}>
        <SectionHeader
          kicker="Field Planning // Farm Registry"
          title="Farm Workspace"
          description="Farm profile, drawn boundary, soil tests and crop history. Every record keeps its source label — measured entries are never blended with modeled supplementary profiles."
          actions={<HudPanel calm className="flex items-center gap-2 !p-2.5"><MapPin className="h-3.5 w-3.5 text-nasa" aria-hidden /><CoordReadout lat={location.lat} lon={location.lon} /></HudPanel>}
        />
      </motion.div>

      {/* Farm list + creation */}
      <motion.div variants={RISE} custom={1} initial="hidden" whileInView="show" viewport={{ once: true }} className="grid gap-4 lg:grid-cols-2">
        <HudPanel>
          <div className="flex items-center gap-2">
            <MapPin className="h-4 w-4 text-signal" aria-hidden />
            <h3 className="font-display text-sm font-bold uppercase tracking-wide-mc text-ink">Your farms</h3>
          </div>
          <QueryState
            isLoading={farms.isLoading}
            isError={farms.isError}
            error={farms.error}
            onRetry={() => farms.refetch()}
            label="Farm registry"
            skeleton={<SkeletonPanel label="Reading farm registry" rows={4} />}
            isEmpty={!!farms.data && farms.data.farms.length === 0}
            empty={<EmptyState label="Farm registry" hint="No farms yet — create one on the right. The public demo needs no signup." />}
          >
            <div className="mt-3 flex max-h-96 flex-col gap-2 overflow-y-auto pr-1">
              {(farms.data?.farms ?? []).map((f) => {
                const active = activeFarmId === f.id;
                return (
                  <button
                    key={f.id}
                    onClick={() => setActiveFarmId(f.id)}
                    className={cn(
                      'rounded-sm border p-3 text-left transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-2',
                      active
                        ? 'border-nasa/50 bg-nasa/10'
                        : 'border-edge bg-panel-2/50 hover:border-iris/40 hover:bg-panel-2',
                    )}
                    style={{ outlineColor: 'var(--nasa)' }}
                    aria-pressed={active}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className={cn('font-display text-sm font-semibold uppercase tracking-wide-mc', active ? 'text-ink' : 'text-dim')}>
                        {f.name}
                      </span>
                      {active && <span className="anim-blink h-1.5 w-1.5 rounded-full bg-nasa" aria-label="Active farm" />}
                    </div>
                    <div className="telemetry mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-faint">
                      <span>{f.centroidLat.toFixed(3)}, {f.centroidLon.toFixed(3)}</span>
                      {f.country && <span>{f.country}</span>}
                      <span>{f._count.soilTests} soil tests</span>
                      <span>{f._count.scenarios} scenarios</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </QueryState>
        </HudPanel>

        <HudPanel>
          <Kicker>New registration</Kicker>
          <h3 className="mt-2 font-display text-sm font-bold uppercase tracking-wide-mc text-ink">Create a farm at the selected location</h3>
          <p className="mt-2 text-[11px] leading-relaxed text-faint">
            Location comes from the header selector / Explorer map. If you drew a boundary there
            ({farmBoundary?.length ?? 0} vertices in session), it will be validated and stored with the farm.
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="farm-name" className="font-mono text-[10px] uppercase tracking-wide-mc text-faint">Name</Label>
              <Input id="farm-name" value={newFarm.name} onChange={(e) => setNewFarm({ ...newFarm, name: e.target.value })} placeholder="e.g. Kilimo Bora Block 3" className="h-9 border-edge bg-panel text-xs text-ink" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="farm-country" className="font-mono text-[10px] uppercase tracking-wide-mc text-faint">Country</Label>
              <Input id="farm-country" value={newFarm.country} onChange={(e) => setNewFarm({ ...newFarm, country: e.target.value })} placeholder="Kenya" className="h-9 border-edge bg-panel text-xs text-ink" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="farm-region" className="font-mono text-[10px] uppercase tracking-wide-mc text-faint">Region</Label>
              <Input id="farm-region" value={newFarm.region} onChange={(e) => setNewFarm({ ...newFarm, region: e.target.value })} placeholder="Rift Valley" className="h-9 border-edge bg-panel text-xs text-ink" />
            </div>
          </div>
          <div className="telemetry mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-dim">
            <CoordReadout lat={location.lat} lon={location.lon} />
            <span className="text-faint">— {location.label}</span>
          </div>
          <Button onClick={() => createFarm.mutate()} disabled={createFarm.isPending} className={cn('mt-3 w-fit uppercase', MONO_BTN)}>
            {createFarm.isPending ? (
              <>
                <span className="anim-blink h-1.5 w-1.5 rounded-full bg-primary-foreground" aria-hidden /> Creating farm…
              </>
            ) : (
              <>
                <Plus className="h-3.5 w-3.5" aria-hidden /> Create farm
              </>
            )}
          </Button>
        </HudPanel>
      </motion.div>

      {/* Active farm profile */}
      {activeFarmId && farm.isLoading && (
        <motion.div variants={RISE} custom={2} initial="hidden" whileInView="show" viewport={{ once: true }} role="status" aria-live="polite">
          <SkeletonPanel label="Reading farm profile" rows={6} />
        </motion.div>
      )}
      {activeFarmId && farm.isError && (
        <motion.div variants={RISE} custom={2} initial="hidden" whileInView="show" viewport={{ once: true }}>
          <FaultPanel error={farm.error} onRetry={() => farm.refetch()} label="Farm profile" />
        </motion.div>
      )}
      {activeFarmId && farm.data && (
        <>
          <motion.section variants={RISE} custom={2} initial="hidden" whileInView="show" viewport={{ once: true }} aria-label="Farm profile">
            <HudPanel>
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <div>
                  <Kicker>Farm profile</Kicker>
                  <h3 className="mt-2 font-display text-lg font-bold uppercase tracking-wide-mc text-ink">{farm.data.farm.name}</h3>
                </div>
                {farm.data.farm.areaHa && (
                  <span className="telemetry rounded-sm border border-edge bg-panel-2/60 px-2 py-0.5 text-[10px] uppercase tracking-wide-mc text-dim">
                    {farm.data.farm.areaHa.toFixed(1)} ha (computed)
                  </span>
                )}
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <TelemetryStat label="Stored observations" value={farm.data.farm._count.observations.toLocaleString()} hint="NASA POWER rows" />
                <TelemetryStat label="Soil tests on file" value={farm.data.farm.soilTests.length} hint="measured + modeled" />
                <TelemetryStat label="Scenarios stored" value={farm.data.farm._count.scenarios} hint="rotation comparisons" />
                <TelemetryStat label="Area" value={farm.data.farm.areaHa?.toFixed(1) ?? null} unit="ha" hint="computed polygon" />
              </div>

              <div className="telemetry mt-4 flex flex-wrap gap-x-6 gap-y-1 text-[11px] text-dim">
                <span>Centroid: <span className="text-ink">{farm.data.farm.centroidLat.toFixed(4)}, {farm.data.farm.centroidLon.toFixed(4)}</span></span>
                <span>Boundary: {farm.data.farm.boundaryGeoJson ? <span className="text-signal">stored (validated polygon)</span> : <span className="text-faint">none</span>}</span>
              </div>

              {farmBoundary && (
                <div className="mt-3 flex items-start gap-2.5 rounded-sm border border-caution/35 bg-caution/5 p-3" role="status">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-caution" aria-hidden />
                  <p className="text-[11px] leading-relaxed text-dim">
                    <span className="font-mono uppercase tracking-wide-mc text-caution">Boundary in session</span> — {farmBoundary.length} vertices
                    drawn in the Geospatial Explorer, not yet committed to this farm.
                  </p>
                </div>
              )}

              <div className="mt-4 flex flex-wrap gap-2">
                <Button variant="outline" size="sm" className={cn('h-8 uppercase', MONO_BTN)} onClick={() => setView('explorer')}>
                  <MapPin className="h-3.5 w-3.5" aria-hidden /> Draw boundary on map
                </Button>
                <Button
                  variant="outline" size="sm" className={cn('h-8 uppercase', MONO_BTN)}
                  disabled={!farmBoundary || farmBoundary.length < 3 || saveBoundary.isPending}
                  onClick={() => saveBoundary.mutate(activeFarmId)}
                >
                  {saveBoundary.isPending ? (
                    <>
                      <span className="anim-blink h-1.5 w-1.5 rounded-full bg-caution" aria-hidden /> Saving…
                    </>
                  ) : (
                    <>
                      <Save className="h-3.5 w-3.5" aria-hidden /> Save drawn boundary ({farmBoundary?.length ?? 0})
                    </>
                  )}
                </Button>
              </div>

              <CropHistoryEditor farmId={activeFarmId} current={farm.data.farm.cropHistory} />
            </HudPanel>
          </motion.section>

          <motion.section variants={RISE} custom={3} initial="hidden" whileInView="show" viewport={{ once: true }} aria-label="Soil properties">
            <SoilSection farmId={activeFarmId} tests={farm.data.farm.soilTests} onSoilGrids={() => soilGrids.mutate(activeFarmId)} soilGridsPending={soilGrids.isPending} />
          </motion.section>
        </>
      )}

      {!activeFarmId && (
        <motion.div variants={RISE} custom={2} initial="hidden" whileInView="show" viewport={{ once: true }}>
          <EmptyState
            label="Farm workspace"
            hint="Select or create a farm above to manage its profile, soil tests and crop history."
            action={
              <Button variant="outline" size="sm" className={cn('mt-2 uppercase', MONO_BTN)} onClick={() => setView('explorer')}>
                <MapPin className="h-3.5 w-3.5" aria-hidden /> Open explorer to place a farm
              </Button>
            }
          />
        </motion.div>
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
      logEvent({
        severity: 'success',
        category: 'FARM',
        title: 'Crop history saved',
        detail: `${entries.length}-season farmer-supplied sequence stored with the farm profile.`,
        view: 'farm',
      });
    },
  });
  return (
    <div className="mt-4 rounded-sm border border-edge bg-panel-2/40 p-3">
      <div className="flex items-center gap-1.5 text-xs font-medium text-dim">
        <Sprout className="h-3.5 w-3.5 text-signal" aria-hidden /> Previous crop sequence (farmer-supplied)
      </div>
      <div className="mt-2 flex flex-col gap-2">
        {entries.map((e, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2 text-xs">
            <Input value={e.season} onChange={(ev) => setEntries(entries.map((x, j) => j === i ? { ...x, season: ev.target.value } : x))} placeholder="Season (e.g. 2025 long rains)" className="h-8 w-44 border-edge bg-panel text-xs text-ink" aria-label={`Season ${i + 1}`} />
            <Input value={e.crop} onChange={(ev) => setEntries(entries.map((x, j) => j === i ? { ...x, crop: ev.target.value } : x))} placeholder="Crop" className="h-8 w-36 border-edge bg-panel text-xs text-ink" aria-label={`Crop ${i + 1}`} />
            <Button variant="ghost" size="sm" className="h-8 px-2 text-faint hover:text-crit" onClick={() => setEntries(entries.filter((_, j) => j !== i))} aria-label={`Remove entry ${i + 1}`}>Remove</Button>
          </div>
        ))}
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className={cn('h-8 uppercase', MONO_BTN)} onClick={() => setEntries([...entries, { season: '', crop: '' }])}>Add season</Button>
          <Button size="sm" className={cn('h-8 uppercase', MONO_BTN)} disabled={update.isPending} onClick={() => update.mutate()}>
            {update.isPending ? (
              <>
                <span className="anim-blink h-1.5 w-1.5 rounded-full bg-primary-foreground" aria-hidden /> Saving history…
              </>
            ) : (
              'Save history'
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

const SOURCE_PILLS: Record<SoilTest['source'], { label: string; cls: string }> = {
  laboratory: { label: 'lab · measured', cls: 'border-signal/40 bg-signal/10 text-signal' },
  farmer: { label: 'farmer · measured', cls: 'border-signal/40 bg-signal/5 text-signal' },
  soilgrids: { label: 'soilgrids · modeled', cls: 'border-caution/40 bg-caution/10 text-caution' },
};

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
      logEvent({
        severity: 'success',
        category: 'FARM',
        title: 'Soil measurement stored',
        detail: `${form.source} soil test (measured ${form.measuredAt}) recorded for the active farm — stored with its source label, never blended with modeled SoilGrids values.`,
        view: 'farm',
      });
      setForm({ ...form, ph: '', organicCarbonPct: '', nitrogenMgKg: '', phosphorusMgKg: '', potassiumCmolKg: '', sandPct: '', siltPct: '', clayPct: '', notes: '' });
    },
    onError: (err) => toast({ title: 'Validation failed', description: err instanceof ApiRequestError ? err.message : 'check values', variant: 'destructive' }),
  });

  return (
    <HudPanel>
      <div className="flex items-center gap-2">
        <FlaskConical className="h-4 w-4 text-caution" aria-hidden />
        <h3 className="font-display text-sm font-bold uppercase tracking-wide-mc text-ink">Soil properties</h3>
      </div>

      {/* Source hierarchy note */}
      <div className="mt-3 flex items-start gap-2.5 rounded-sm border border-caution/35 bg-caution/5 p-3">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-caution" aria-hidden />
        <p className="text-[11px] leading-relaxed text-dim">
          <span className="font-mono uppercase tracking-wide-mc text-caution">Source hierarchy</span> — farmer / laboratory measurements
          always outrank the modeled SoilGrids supplementary profile. Modeled values are clearly labeled model
          estimates and are never mixed with measurements.
        </p>
      </div>

      <QueryState
        isLoading={false}
        isError={false}
        isEmpty={tests.length === 0}
        empty={
          <EmptyState
            label="Soil information"
            hint="No soil information yet. Enter a farmer/lab test below, or fetch the supplementary SoilGrids modeled profile."
            action={
              <Button variant="outline" size="sm" className={cn('mt-2 border-caution/40 uppercase text-caution hover:bg-caution/10', MONO_BTN)} onClick={onSoilGrids} disabled={soilGridsPending}>
                {soilGridsPending ? (
                  <>
                    <span className="anim-blink h-1.5 w-1.5 rounded-full bg-caution" aria-hidden /> Retrieving…
                  </>
                ) : (
                  <>
                    <Mountain className="h-3.5 w-3.5" aria-hidden /> Fetch SoilGrids modeled profile (supplementary)
                  </>
                )}
              </Button>
            }
          />
        }
      >
        <div className="mt-3 max-h-96 overflow-x-auto overflow-y-auto rounded-sm border border-edge">
          <table className="mc-table w-full min-w-[42rem]">
            <thead className="sticky top-0 z-10 bg-panel">
              <tr className="border-b border-edge">
                <th className="px-3 py-2 text-left">Source</th>
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-left">pH</th>
                <th className="px-3 py-2 text-left">Texture</th>
                <th className="px-3 py-2 text-left">OC %</th>
                <th className="px-3 py-2 text-left">N mg/kg</th>
                <th className="px-3 py-2 text-left">Detail</th>
              </tr>
            </thead>
            <tbody>
              {tests.map((t) => {
                const modeled = t.source === 'soilgrids';
                return (
                  <tr key={t.id} className={cn('border-b border-edge/60 last:border-b-0', modeled ? 'bg-caution/5' : 'hover:bg-panel-2/50')}>
                    <td className="px-3 py-2">
                      <span className={cn('inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide-mc', SOURCE_PILLS[t.source].cls)}>
                        {SOURCE_PILLS[t.source].label}
                      </span>
                    </td>
                    <td className="telemetry px-3 py-2">{new Date(t.measuredAt).toISOString().slice(0, 10)}</td>
                    <td className={cn('telemetry px-3 py-2', !modeled && 'text-ink')}>{t.ph?.toFixed(1) ?? '—'}</td>
                    <td className="px-3 py-2">{t.texture ?? '—'}</td>
                    <td className={cn('telemetry px-3 py-2', !modeled && 'text-ink')}>{t.organicCarbonPct?.toFixed(1) ?? '—'}</td>
                    <td className={cn('telemetry px-3 py-2', !modeled && 'text-ink')}>{t.nitrogenMgKg ?? '—'}</td>
                    <td className="max-w-[18rem] truncate px-3 py-2 text-faint" title={t.sourceDetail ?? t.notes ?? ''}>{t.sourceDetail ?? t.notes ?? ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </QueryState>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="outline" size="sm" className={cn('border-caution/40 text-caution hover:bg-caution/10 uppercase', MONO_BTN)} onClick={onSoilGrids} disabled={soilGridsPending}>
          {soilGridsPending ? (
            <>
              <span className="anim-blink h-1.5 w-1.5 rounded-full bg-caution" aria-hidden /> Retrieving…
            </>
          ) : (
            <>
              <Mountain className="h-3.5 w-3.5" aria-hidden /> Fetch SoilGrids modeled profile (supplementary)
            </>
          )}
        </Button>
      </div>

      {/* Manual entry */}
      <div className="mt-4 rounded-sm border border-edge bg-panel-2/40 p-3">
        <div className="flex items-center gap-1.5 text-xs font-medium text-dim">
          <Beaker className="h-3.5 w-3.5 text-signal" aria-hidden /> Enter a soil measurement (farmer or laboratory)
        </div>
        <div className="mt-2 grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <Field label="Source">
            <Select value={form.source} onValueChange={(v) => setForm({ ...form, source: v as 'farmer' | 'laboratory' })}>
              <SelectTrigger className="h-9 border-edge bg-panel text-xs text-ink" aria-label="Measurement source"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="farmer" className="text-xs">Farmer measurement</SelectItem>
                <SelectItem value="laboratory" className="text-xs">Laboratory report</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Measured at">
            <Input type="date" value={form.measuredAt} onChange={(e) => setForm({ ...form, measuredAt: e.target.value })} className="h-9 border-edge bg-panel text-xs text-ink" />
          </Field>
          <Field label="pH (0–14)">
            <Input type="number" step="0.1" value={form.ph} onChange={(e) => setForm({ ...form, ph: e.target.value })} className="h-9 border-edge bg-panel text-xs text-ink" aria-label="pH value" />
          </Field>
          <Field label="Texture class">
            <Select value={textureSelect} onValueChange={setTextureSelect}>
              <SelectTrigger className="h-9 border-edge bg-panel text-xs text-ink" aria-label="Texture class"><SelectValue /></SelectTrigger>
              <SelectContent>
                {['none', 'sand', 'sandy loam', 'loam', 'silt loam', 'clay loam', 'clay'].map((t) => (
                  <SelectItem key={t} value={t} className="text-xs">{t === 'none' ? '— select —' : t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Depth (cm)">
            <Input type="number" value={form.depthCm} onChange={(e) => setForm({ ...form, depthCm: e.target.value })} className="h-9 border-edge bg-panel text-xs text-ink" aria-label="Sampling depth in cm" />
          </Field>
          <Field label="Organic C (%)">
            <Input type="number" step="0.01" value={form.organicCarbonPct} onChange={(e) => setForm({ ...form, organicCarbonPct: e.target.value })} className="h-9 border-edge bg-panel text-xs text-ink" aria-label="Organic carbon percent" />
          </Field>
          <Field label="Total N (mg/kg)">
            <Input type="number" value={form.nitrogenMgKg} onChange={(e) => setForm({ ...form, nitrogenMgKg: e.target.value })} className="h-9 border-edge bg-panel text-xs text-ink" aria-label="Total nitrogen mg per kg" />
          </Field>
          <Field label="P (mg/kg)">
            <Input type="number" value={form.phosphorusMgKg} onChange={(e) => setForm({ ...form, phosphorusMgKg: e.target.value })} className="h-9 border-edge bg-panel text-xs text-ink" aria-label="Phosphorus mg per kg" />
          </Field>
          <Field label="K (cmol/kg)">
            <Input type="number" value={form.potassiumCmolKg} onChange={(e) => setForm({ ...form, potassiumCmolKg: e.target.value })} className="h-9 border-edge bg-panel text-xs text-ink" aria-label="Potassium cmol per kg" />
          </Field>
          <Field label="Notes">
            <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="lab / method" className="h-9 border-edge bg-panel text-xs text-ink" aria-label="Notes" />
          </Field>
        </div>
        <Button size="sm" className={cn('mt-3 h-8 uppercase', MONO_BTN)} disabled={addTest.isPending} onClick={() => addTest.mutate()}>
          {addTest.isPending ? (
            <>
              <span className="anim-blink h-1.5 w-1.5 rounded-full bg-primary-foreground" aria-hidden /> Storing measurement…
            </>
          ) : (
            'Store measurement'
          )}
        </Button>
      </div>
    </HudPanel>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[10px] uppercase tracking-wide-mc text-faint">{label}</span>
      {children}
    </label>
  );
}
