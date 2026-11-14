'use client';

import { useState } from 'react';
import { useSession } from '@/components/state/store';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api, ApiRequestError, type CropDef, type RotationResult } from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Slider } from '@/components/ui/slider';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { RainfallProfileChart } from '@/components/charts/scientific-charts';
import { Loader2, Sprout, Plus, X, Trophy, AlertTriangle, BookOpen, Scale, Droplets } from 'lucide-react';
import { cn } from '@/lib/utils';

const FAMILY_COLORS: Record<string, string> = {
  cereal: 'border-amber-600/40 text-amber-300',
  legume: 'border-emerald-600/40 text-emerald-300',
  'root-tuber': 'border-sky-600/40 text-sky-300',
  oilseed: 'border-yellow-600/40 text-yellow-300',
  fiber: 'border-purple-600/40 text-purple-300',
  vegetable: 'border-teal-600/40 text-teal-300',
};

interface ScenarioDraft {
  name: string;
  cropKeys: string[];
}

/** Crop Rotation Planner: build scenarios, set priorities, compare alternatives. */
export function RotationPlannerView() {
  const { activeFarmId, setView } = useSession();
  const { toast } = useToast();
  const crops = useQuery({ queryKey: ['crops'], queryFn: api.crops });

  const [scenarios, setScenarios] = useState<ScenarioDraft[]>([
    { name: 'A: Current practice', cropKeys: ['maize', 'maize', 'maize', 'maize'] },
    { name: 'B: Legume-integrated', cropKeys: ['maize', 'cowpea', 'maize', 'common_bean'] },
    { name: 'C: Drought-hardy mix', cropKeys: ['sorghum', 'pearl_millet', 'cowpea', 'sunflower'] },
  ]);
  const [priorities, setPriorities] = useState({ soilHealth: 0.25, waterEfficiency: 0.25, seasonalAdaptability: 0.15, nutrientManagement: 0.15, cropDiversity: 0.1, economics: 0, foodSecurity: 0.1 });
  const [selectedCrop, setSelectedCrop] = useState('maize');
  const [activeScenario, setActiveScenario] = useState(0);

  const compare = useMutation({
    mutationFn: () =>
      api.compare({
        farmId: activeFarmId!,
        scenarios: scenarios.map((s) => ({ name: s.name, cropKeys: s.cropKeys })),
        priorities,
      }),
    onSuccess: (res) => {
      toast({
        title: 'Comparison complete',
        description: `${res.results.length} alternatives scored. Environment: ${res.environmentAvailable.rainfall ? 'POWER rainfall ✓' : 'no rainfall ✗'}; soil: ${res.soilAvailable.source ?? 'none'}.`,
      });
    },
    onError: (err) => {
      toast({
        title: 'Comparison failed',
        description: err instanceof ApiRequestError ? err.message : 'error',
        variant: 'destructive',
      });
    },
  });

  const rainfallProfile = useQuery({
    queryKey: ['obs-profile', activeFarmId],
    queryFn: () => api.observations(activeFarmId ? { farmId: activeFarmId } : {}),
    select: (data) => {
      // compute monthly median from daily rainfall points (client-side climatology)
      const pts = data.series.PRECTOTCORR?.points ?? [];
      if (pts.length === 0) return null;
      const byMonth = Array.from({ length: 12 }, () => [] as number[]);
      const buckets = new Map<string, number>();
      for (const p of pts) {
        if (p.value === null) continue;
        const key = p.date.slice(0, 7);
        buckets.set(key, (buckets.get(key) ?? 0) + p.value);
      }
      for (const [key, total] of buckets) {
        const m = Number(key.slice(5, 7)) - 1;
        byMonth[m].push(total);
      }
      const q = (arr: number[], p: number) => {
        if (!arr.length) return 0;
        const s = [...arr].sort((a, b) => a - b);
        const pos = (s.length - 1) * p;
        const lo = Math.floor(pos);
        return s[lo] + (pos - lo) * (s[Math.min(lo + 1, s.length - 1)] - s[lo]);
      };
      const years = new Set([...buckets.keys()].map((k) => k.slice(0, 4))).size;
      return { p25: byMonth.map((a) => q(a, 0.25)), p50: byMonth.map((a) => q(a, 0.5)), p75: byMonth.map((a) => q(a, 0.75)), years };
    },
  });

  if (!activeFarmId) {
    return (
      <Card className="border-dashed border-slate-800 bg-slate-900/20">
        <CardContent className="py-10 text-center flex flex-col items-center gap-3 text-sm text-slate-500">
          <Sprout className="h-8 w-8 text-slate-600" aria-hidden />
          <p>The rotation planner works on a farm profile (soil + environmental record).</p>
          <Button variant="outline" className="border-slate-700 text-slate-200" onClick={() => setView('farm')}>Set up a farm first</Button>
        </CardContent>
      </Card>
    );
  }

  const current = scenarios[activeScenario] ?? scenarios[0];

  return (
    <div className="mx-auto max-w-6xl flex flex-col gap-6">
      {/* Scenario builder */}
      <Card className="border-slate-800 bg-slate-900/40">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Rotation scenarios</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            {scenarios.map((s, i) => (
              <button
                key={i}
                onClick={() => setActiveScenario(i)}
                className={cn(
                  'rounded-lg border px-3 py-2 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-emerald-400',
                  activeScenario === i ? 'border-emerald-600/50 bg-emerald-500/10 text-emerald-300' : 'border-slate-800 bg-slate-900/60 text-slate-300 hover:bg-slate-800/60',
                )}
                aria-pressed={activeScenario === i}
              >
                {s.name || `Scenario ${String.fromCharCode(65 + i)}`}
                <span className="ml-2 text-slate-500">{s.cropKeys.length} crops</span>
              </button>
            ))}
            <Button variant="outline" size="sm" className="h-9 text-xs border-slate-700" onClick={() => setScenarios([...scenarios, { name: `${String.fromCharCode(65 + scenarios.length)}: New option`, cropKeys: [] }])}>
              <Plus className="mr-1 h-3.5 w-3.5" aria-hidden /> Add scenario
            </Button>
          </div>

          {/* Scenario editor */}
          <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
            <div className="flex items-center gap-2">
              <Input
                value={current.name}
                onChange={(e) => setScenarios(scenarios.map((s, i) => i === activeScenario ? { ...s, name: e.target.value } : s))}
                className="bg-slate-900 border-slate-700 h-8 text-xs w-64"
                aria-label="Scenario name"
              />
              {scenarios.length > 2 && (
                <Button variant="ghost" size="sm" className="h-8 text-xs text-slate-500" onClick={() => { setScenarios(scenarios.filter((_, i) => i !== activeScenario)); setActiveScenario(0); }}>
                  Remove scenario
                </Button>
              )}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {current.cropKeys.map((key, idx) => {
                const crop = crops.data?.crops.find((c) => c.cropKey === key);
                return (
                  <span key={idx} className={cn('rounded-md border px-2.5 py-1.5 text-xs flex items-center gap-1.5', FAMILY_COLORS[crop?.familyGroup ?? ''] ?? 'border-slate-700 text-slate-300')}>
                    <span className="text-slate-600 font-mono text-[10px]">{idx + 1}</span>
                    {crop?.name ?? key}
                    <button
                      onClick={() => setScenarios(scenarios.map((s, i) => i === activeScenario ? { ...s, cropKeys: s.cropKeys.filter((_, j) => j !== idx) } : s))}
                      className="text-slate-500 hover:text-red-400"
                      aria-label={`Remove ${crop?.name ?? key} from sequence`}
                    >
                      <X className="h-3 w-3" aria-hidden />
                    </button>
                  </span>
                );
              })}
              {current.cropKeys.length === 0 && <span className="text-xs text-slate-500">Empty sequence — add crops below.</span>}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select
                value={selectedCrop}
                onChange={(e) => setSelectedCrop(e.target.value)}
                className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-200 h-9"
                aria-label="Crop to add"
              >
                {(crops.data?.crops ?? []).map((c) => (
                  <option key={c.cropKey} value={c.cropKey}>
                    {c.name} · {c.family} · {c.waterReqMm[0]}–{c.waterReqMm[1]} mm
                  </option>
                ))}
              </select>
              <Button
                size="sm" className="h-9 text-xs bg-emerald-600 hover:bg-emerald-500 text-white"
                disabled={current.cropKeys.length >= 8}
                onClick={() => setScenarios(scenarios.map((s, i) => i === activeScenario ? { ...s, cropKeys: [...s.cropKeys, selectedCrop] } : s))}
              >
                <Plus className="mr-1 h-3.5 w-3.5" aria-hidden /> Add to sequence
              </Button>
            </div>
          </div>

          {/* Priorities */}
          <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
            <div className="flex items-center gap-1.5 text-xs font-medium text-slate-300">
              <Scale className="h-3.5 w-3.5 text-emerald-400" aria-hidden /> Farmer priorities (weights normalised server-side; versioned)
            </div>
            <div className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
              {(
                [
                  ['soilHealth', 'Soil-health improvement'],
                  ['waterEfficiency', 'Water efficiency'],
                  ['seasonalAdaptability', 'Seasonal adaptability'],
                  ['nutrientManagement', 'Nutrient management'],
                  ['cropDiversity', 'Crop diversity'],
                  ['economics', 'Economics (not assessed — no price source)'],
                  ['foodSecurity', 'Food security'],
                ] as const
              ).map(([key, label]) => (
                <div key={key} className={key === 'economics' ? 'opacity-60' : ''}>
                  <div className="flex justify-between text-[10px] text-slate-500">
                    <span>{label}</span>
                    <span className="font-mono">{priorities[key].toFixed(2)}</span>
                  </div>
                  <Slider
                    value={[Math.round(priorities[key] * 100)]}
                    min={0} max={100} step={5}
                    onValueChange={(v) => setPriorities({ ...priorities, [key]: v[0] / 100 })}
                    aria-label={label}
                  />
                </div>
              ))}
            </div>
          </div>

          <Button
            onClick={() => compare.mutate()}
            disabled={compare.isPending || scenarios.some((s) => s.cropKeys.length === 0)}
            className="w-fit bg-emerald-600 hover:bg-emerald-500 text-white"
          >
            {compare.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> Scoring alternatives…
              </>
            ) : (
              <>
                <Trophy className="mr-1 h-4 w-4" aria-hidden /> Compare {scenarios.length} alternatives
              </>
            )}
          </Button>
          {scenarios.some((s) => s.cropKeys.length === 0) && (
            <p className="text-[11px] text-amber-400">Every scenario needs at least one crop.</p>
          )}
        </CardContent>
      </Card>

      {/* Rainfall context */}
      {rainfallProfile.data && (
        <Card className="border-slate-800 bg-slate-900/40">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Droplets className="h-4 w-4 text-sky-400" aria-hidden /> Seasonal rainfall evidence used by the engine
            </CardTitle>
          </CardHeader>
          <CardContent>
            <RainfallProfileChart p25={rainfallProfile.data.p25} p50={rainfallProfile.data.p50} p75={rainfallProfile.data.p75} />
            <p className="mt-1 text-[11px] text-slate-600">
              Median + interquartile monthly rainfall from the {rainfallProfile.data.years}-year stored POWER record. Crops&apos;
              FAO-cited seasonal water requirements are compared against these windows.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Results */}
      {compare.data && (
        <div className="flex flex-col gap-4">
          {compare.data.ranking.map((rank) => {
            const result = compare.data!.results.find((r) => r.scenarioName === rank.scenarioName)!;
            return (
              <Card key={rank.scenarioName} className={cn('border-slate-800 bg-slate-900/40', rank.rank === 1 && 'border-emerald-600/40')}>
                <CardHeader className="pb-3">
                  <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                    <Badge variant={rank.rank === 1 ? 'default' : 'outline'} className={rank.rank === 1 ? 'bg-emerald-600 text-white' : 'border-slate-700 text-slate-400'}>
                      Rank {rank.rank}
                    </Badge>
                    <span>{rank.scenarioName}</span>
                    <span className="font-mono text-sm text-slate-300">{Math.round(rank.overallScore * 100)}/100</span>
                    <Badge variant="outline" className="border-slate-600 text-slate-400">confidence {Math.round(rank.confidence * 100)}%</Badge>
                    {rank.incompatibleCount > 0 && (
                      <Badge variant="outline" className="border-red-600/50 text-red-400">{rank.incompatibleCount} incompatibility flag(s)</Badge>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <ResultFactors result={result} />
                  {result.narrative.length > 0 && (
                    <ul className="text-xs text-slate-400 list-disc list-inside space-y-1">
                      {result.narrative.map((n, i) => <li key={i}>{n}</li>)}
                    </ul>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Crop catalogue browser */}
      <Card className="border-slate-800 bg-slate-900/40">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <BookOpen className="h-4 w-4 text-slate-400" aria-hidden /> Crop characteristics catalogue
            <span className="text-xs font-normal text-slate-500">{crops.data?.catalogueVersion} · FAO-cited values</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-lg border border-slate-800 max-h-96 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-900/80 text-slate-400 sticky top-0">
                <tr>
                  <th className="px-2.5 py-2 text-left font-medium">Crop</th>
                  <th className="px-2.5 py-2 text-left font-medium">Family</th>
                  <th className="px-2.5 py-2 text-left font-medium">Days</th>
                  <th className="px-2.5 py-2 text-left font-medium">Water req (mm)</th>
                  <th className="px-2.5 py-2 text-left font-medium">N-fix</th>
                  <th className="px-2.5 py-2 text-left font-medium">pH range</th>
                  <th className="px-2.5 py-2 text-left font-medium">Sources</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800 text-slate-300">
                {(crops.data?.crops ?? []).map((c) => (
                  <CropRow key={c.cropKey} crop={c} />
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function CropRow({ crop }: { crop: CropDef }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="bg-slate-900/30 cursor-pointer hover:bg-slate-800/40" onClick={() => setOpen(!open)} aria-expanded={open}>
        <td className="px-2.5 py-2">
          <div className="font-medium text-slate-200">{crop.name}</div>
          <div className="text-[10px] italic text-slate-500">{crop.scientificName}</div>
        </td>
        <td className="px-2.5 py-2">{crop.family}</td>
        <td className="px-2.5 py-2 font-mono">{crop.growthDays[0]}–{crop.growthDays[1]}</td>
        <td className="px-2.5 py-2 font-mono">{crop.waterReqMm[0]}–{crop.waterReqMm[1]}</td>
        <td className="px-2.5 py-2">{crop.nFixation ? <Badge variant="outline" className="border-emerald-600/40 text-emerald-400">legume</Badge> : '—'}</td>
        <td className="px-2.5 py-2 font-mono">{crop.soilPh[0]}–{crop.soilPh[1]}</td>
        <td className="px-2.5 py-2 text-[10px] text-slate-500 max-w-[10rem] truncate" title={crop.sources.join('; ')}>{crop.sources.length} citation(s)</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7} className="px-3 py-2 bg-[#0a101c]">
            <p className="text-[11px] text-slate-400">{crop.notes}</p>
            <ul className="mt-1 text-[10px] text-slate-500 list-disc list-inside">
              {crop.sources.map((s, i) => <li key={i}>{s}</li>)}
            </ul>
          </td>
        </tr>
      )}
    </>
  );
}

function ResultFactors({ result }: { result: RotationResult }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {result.factors.map((f) => (
        <div key={f.criterion} className="rounded-lg border border-slate-800 bg-slate-900/60 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-slate-200">{f.criterion}</span>
            <span className="font-mono text-xs">
              {f.score === null ? (
                <Badge variant="outline" className="border-amber-600/40 text-amber-400">not assessed</Badge>
              ) : (
                <span className={f.score >= 0.7 ? 'text-emerald-400' : f.score >= 0.4 ? 'text-amber-400' : 'text-red-400'}>
                  {Math.round(f.score * 100)}/100
                </span>
              )}
            </span>
          </div>
          {f.score !== null && (
            <div className="mt-1.5 h-1.5 rounded-full bg-slate-800 overflow-hidden">
              <div
                className={cn('h-full rounded-full', f.score >= 0.7 ? 'bg-emerald-500' : f.score >= 0.4 ? 'bg-amber-500' : 'bg-red-500')}
                style={{ width: `${Math.round(f.score * 100)}%` }}
              />
            </div>
          )}
          <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
            {f.explanation.length > 320 ? f.explanation.slice(0, 320) + '…' : f.explanation}
          </p>
          <span className="text-[9px] text-slate-600">weight {f.weight.toFixed(2)}</span>
        </div>
      ))}
    </div>
  );
}
