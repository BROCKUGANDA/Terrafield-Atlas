'use client';

import { useState } from 'react';
import { motion, type Variants } from 'framer-motion';
import { useSession } from '@/components/state/store';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api, ApiRequestError, type CropDef, type RotationResult } from '@/lib/api-client';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Slider } from '@/components/ui/slider';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { Kicker, SectionHeader, HudPanel } from '@/components/ui-mc/kit';
import { QueryState, EmptyState, FaultPanel, LoadingChip } from '@/components/system/query-state';
import { SkeletonPanel, SweepLoader } from '@/components/system/skeletons';
import { RainfallProfileChart } from '@/components/charts/scientific-charts';
import { Sprout, Plus, X, Trophy, BookOpen, Scale, Droplets, AlertTriangle, ShieldAlert } from 'lucide-react';
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

const FAMILY_COLORS: Record<string, string> = {
  cereal: 'border-caution/40 text-caution',
  legume: 'border-signal/40 text-signal',
  'root-tuber': 'border-aqua/40 text-aqua',
  oilseed: 'border-iris/40 text-iris',
  fiber: 'border-nasa/40 text-nasa',
  vegetable: 'border-signal/30 text-signal',
};

/** Animated gradient score bar (nasa→signal) with mono readout. */
function ScoreBar({ pct, tone = 'score', delay = 0 }: { pct: number; tone?: 'score' | 'confidence'; delay?: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full border border-edge bg-panel-2" role="presentation">
      <motion.div
        initial={{ width: 0 }}
        animate={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
        transition={{ duration: 0.8, delay, ease: [0.22, 1, 0.36, 1] }}
        className={cn('h-full rounded-full', tone === 'score' ? 'bg-gradient-to-r from-nasa to-signal' : 'bg-gradient-to-r from-signal to-aqua')}
      />
    </div>
  );
}

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
      <div className="mx-auto max-w-3xl">
        <EmptyState
          label="Rotation planner"
          hint="The rotation planner works on a farm profile (soil + environmental record)."
          action={
            <Button variant="outline" size="sm" className={cn('mt-2 uppercase', MONO_BTN)} onClick={() => setView('farm')}>
              <Sprout className="h-3.5 w-3.5" aria-hidden /> Set up a farm first
            </Button>
          }
        />
      </div>
    );
  }

  const current = scenarios[activeScenario] ?? scenarios[0];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <motion.div variants={RISE} custom={0} initial="hidden" whileInView="show" viewport={{ once: true }}>
        <SectionHeader
          kicker="Field Planning // Decision Support"
          title="Crop Rotation Planner"
          description="Build alternative crop sequences, set farmer priorities, and compare deterministic rule-based scores side by side. Missing evidence lowers confidence — nothing is substituted, and no yield or profit predictions are made."
          actions={
            crops.data ? (
              <span className="telemetry rounded-sm border border-edge bg-panel-2/60 px-2.5 py-1 text-[10px] uppercase tracking-wide-mc text-dim">
                catalogue {crops.data.catalogueVersion} · FAO-cited values
              </span>
            ) : (
              <LoadingChip label={crops.isError ? 'catalogue fault' : 'reading catalogue'} />
            )
          }
        />
      </motion.div>

      {/* Scenario builder */}
      <motion.section variants={RISE} custom={1} initial="hidden" whileInView="show" viewport={{ once: true }} aria-label="Scenario builder">
        <HudPanel>
          <Kicker>Scenario builder</Kicker>
          <div className="mt-3 flex flex-wrap gap-2">
            {scenarios.map((s, i) => (
              <button
                key={i}
                onClick={() => setActiveScenario(i)}
                className={cn(
                  'rounded-sm border px-3 py-2 text-xs transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-2',
                  activeScenario === i
                    ? 'border-nasa/50 bg-nasa/10 text-ink'
                    : 'border-edge bg-panel-2/50 text-dim hover:border-iris/40 hover:bg-panel-2',
                )}
                style={{ outlineColor: 'var(--nasa)' }}
                aria-pressed={activeScenario === i}
              >
                {s.name || `Scenario ${String.fromCharCode(65 + i)}`}
                <span className="ml-2 font-mono text-[10px] text-faint">{s.cropKeys.length} crops</span>
              </button>
            ))}
            <Button variant="outline" size="sm" className={cn('h-9 uppercase', MONO_BTN)} onClick={() => setScenarios([...scenarios, { name: `${String.fromCharCode(65 + scenarios.length)}: New option`, cropKeys: [] }])}>
              <Plus className="h-3.5 w-3.5" aria-hidden /> Add scenario
            </Button>
          </div>

          {/* Scenario editor */}
          <div className="mt-4 rounded-sm border border-edge bg-panel-2/40 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={current.name}
                onChange={(e) => setScenarios(scenarios.map((s, i) => i === activeScenario ? { ...s, name: e.target.value } : s))}
                className="h-8 w-64 border-edge bg-panel text-xs text-ink"
                aria-label="Scenario name"
              />
              {scenarios.length > 2 && (
                <Button variant="ghost" size="sm" className="h-8 px-2 text-faint hover:text-crit" onClick={() => { setScenarios(scenarios.filter((_, i) => i !== activeScenario)); setActiveScenario(0); }}>
                  Remove scenario
                </Button>
              )}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {current.cropKeys.map((key, idx) => {
                const crop = crops.data?.crops.find((c) => c.cropKey === key);
                return (
                  <span key={idx} className={cn('flex items-center gap-1.5 rounded-sm border bg-panel/70 px-2.5 py-1.5 text-xs', FAMILY_COLORS[crop?.familyGroup ?? ''] ?? 'border-edge text-dim')}>
                    <span className="telemetry text-[10px] text-faint">{String(idx + 1).padStart(2, '0')}</span>
                    {crop?.name ?? key}
                    <button
                      onClick={() => setScenarios(scenarios.map((s, i) => i === activeScenario ? { ...s, cropKeys: s.cropKeys.filter((_, j) => j !== idx) } : s))}
                      className="text-faint transition-colors hover:text-crit focus-visible:outline-2 focus-visible:outline-offset-2"
                      style={{ outlineColor: 'var(--nasa)' }}
                      aria-label={`Remove ${crop?.name ?? key} from sequence`}
                    >
                      <X className="h-3 w-3" aria-hidden />
                    </button>
                  </span>
                );
              })}
              {current.cropKeys.length === 0 && <span className="text-xs text-faint">Empty sequence — add crops below.</span>}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {crops.data ? (
                <Select value={selectedCrop} onValueChange={setSelectedCrop}>
                  <SelectTrigger className="h-9 w-full max-w-sm border-edge bg-panel text-xs text-ink" aria-label="Crop to add">
                    <SelectValue placeholder="Select crop" />
                  </SelectTrigger>
                  <SelectContent className="max-h-72 overflow-y-auto">
                    {(crops.data.crops ?? []).map((c) => (
                      <SelectItem key={c.cropKey} value={c.cropKey} className="text-xs">
                        {c.name} · {c.family} · {c.waterReqMm[0]}–{c.waterReqMm[1]} mm
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : crops.isError ? (
                <LoadingChip label="catalogue fault — retry below" />
              ) : (
                <LoadingChip label="reading crop catalogue" />
              )}
              <Button
                size="sm" className={cn('h-9 uppercase', MONO_BTN)}
                disabled={current.cropKeys.length >= 8 || !crops.data}
                onClick={() => setScenarios(scenarios.map((s, i) => i === activeScenario ? { ...s, cropKeys: [...s.cropKeys, selectedCrop] } : s))}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden /> Add to sequence
              </Button>
            </div>
          </div>

          {/* Priorities */}
          <div className="mt-4 rounded-sm border border-edge bg-panel-2/40 p-3">
            <div className="flex items-center gap-1.5 text-xs font-medium text-dim">
              <Scale className="h-3.5 w-3.5 text-signal" aria-hidden /> Farmer priorities (weights normalised server-side; versioned)
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
                  <div className="flex justify-between font-mono text-[10px] uppercase tracking-wide-mc text-faint">
                    <span>{label}</span>
                    <span className="telemetry text-dim">{priorities[key].toFixed(2)}</span>
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

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              onClick={() => compare.mutate()}
              disabled={compare.isPending || scenarios.some((s) => s.cropKeys.length === 0)}
              className={cn('uppercase', MONO_BTN)}
            >
              {compare.isPending ? (
                <>
                  <span className="anim-blink h-1.5 w-1.5 rounded-full bg-primary-foreground" aria-hidden /> Scoring alternatives…
                </>
              ) : (
                <>
                  <Trophy className="h-4 w-4" aria-hidden /> Compare {scenarios.length} alternatives
                </>
              )}
            </Button>
            {scenarios.some((s) => s.cropKeys.length === 0) && (
              <p className="text-[11px] text-caution">Every scenario needs at least one crop.</p>
            )}
          </div>
        </HudPanel>
      </motion.section>

      {/* Rainfall context */}
      <motion.section variants={RISE} custom={2} initial="hidden" whileInView="show" viewport={{ once: true }} aria-label="Seasonal rainfall evidence">
        <QueryState
          isLoading={rainfallProfile.isPending}
          isError={rainfallProfile.isError}
          error={rainfallProfile.error}
          onRetry={() => rainfallProfile.refetch()}
          label="Stored POWER rainfall record"
          skeleton={<SkeletonPanel label="Reading stored POWER rainfall" rows={3} />}
          isEmpty={rainfallProfile.data === null}
          empty={
            <div className="hud hud-calm flex items-start gap-2.5 p-4" role="note">
              <Droplets className="mt-0.5 h-4 w-4 shrink-0 text-caution" aria-hidden />
              <p className="text-[11px] leading-relaxed text-dim">
                <span className="font-mono uppercase tracking-wide-mc text-caution">No stored rainfall record</span> — the seasonal
                water-availability criterion is scored as missing data by the engine. Confidence drops; nothing is substituted.
              </p>
            </div>
          }
        >
          {rainfallProfile.data && (
            <HudPanel>
              <div className="flex items-center gap-2">
                <Droplets className="h-4 w-4 text-aqua" aria-hidden />
                <h3 className="font-display text-sm font-bold uppercase tracking-wide-mc text-ink">Seasonal rainfall evidence used by the engine</h3>
              </div>
              <div className="mt-3">
                <RainfallProfileChart p25={rainfallProfile.data.p25} p50={rainfallProfile.data.p50} p75={rainfallProfile.data.p75} />
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-faint">
                Median + interquartile monthly rainfall from the {rainfallProfile.data.years}-year stored POWER record. Crops&apos;
                FAO-cited seasonal water requirements are compared against these windows.
              </p>
            </HudPanel>
          )}
        </QueryState>
      </motion.section>

      {/* Comparison running / fault */}
      {compare.isPending && (
        <motion.section variants={RISE} custom={2} initial="hidden" animate="show" aria-live="polite">
          <SweepLoader label="Scoring alternatives" />
        </motion.section>
      )}
      {compare.isError && (
        <motion.section variants={RISE} custom={2} initial="hidden" animate="show">
          <FaultPanel
            error={compare.error}
            label="Rotation comparison"
            onRetry={() => compare.mutate()}
            hint="The deterministic engine did not run; no scores were produced or cached for this attempt."
          />
        </motion.section>
      )}

      {/* Results */}
      {compare.data && (
        <motion.section variants={RISE} custom={3} initial="hidden" whileInView="show" viewport={{ once: true }} aria-label="Comparison results">
          <HudPanel calm={false}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <Kicker>Engine output // ranking</Kicker>
                <p className="mt-2 text-[11px] leading-relaxed text-faint">
                  Overall score = weighted sum of deterministic criterion rules; confidence reflects how much real
                  evidence was available. Rank 1 is only the best match under the weights above — not a yield forecast.
                </p>
              </div>
              <span className="telemetry rounded-sm border border-edge bg-panel-2/60 px-2.5 py-1 text-[10px] uppercase tracking-wide-mc text-dim">
                rules {compare.data.results[0]?.ruleVersion ?? '—'}
              </span>
            </div>

            <Accordion type="single" collapsible className="mt-4">
              {compare.data.ranking.map((rank, idx) => {
                const result = compare.data!.results.find((r) => r.scenarioName === rank.scenarioName)!;
                const rankOne = rank.rank === 1;
                const scorePct = Math.round(rank.overallScore * 100);
                const confPct = Math.round(rank.confidence * 100);
                return (
                  <AccordionItem key={rank.scenarioName} value={rank.scenarioName} className="border-edge">
                    <AccordionTrigger className="rounded-sm hover:no-underline">
                      <div className="flex w-full flex-col gap-3 py-1 md:flex-row md:items-center md:gap-4">
                        <span
                          className={cn('telemetry w-12 shrink-0 text-3xl font-semibold tabular-nums', rankOne ? 'glow-nasa text-nasa' : 'text-dim')}
                          aria-label={`Rank ${rank.rank}`}
                        >
                          {String(rank.rank).padStart(2, '0')}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={cn('font-display text-sm font-bold uppercase tracking-wide-mc', rankOne ? 'text-ink' : 'text-dim')}>
                              {rank.scenarioName}
                            </span>
                            {rank.incompatibleCount > 0 && (
                              <span className="inline-flex items-center gap-1.5 rounded-sm border border-crit/40 bg-crit/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide-mc text-crit">
                                <ShieldAlert className="h-3 w-3" aria-hidden /> {rank.incompatibleCount} incompatible
                              </span>
                            )}
                            {result.missingInformation.length > 0 && (
                              <span className="inline-flex items-center gap-1.5 rounded-sm border border-caution/40 bg-caution/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide-mc text-caution">
                                {result.missingInformation.length} missing inputs
                              </span>
                            )}
                          </div>
                          <p className="telemetry mt-1 truncate text-[10px] text-faint">
                            {result.cropNames.join(' → ')}
                          </p>
                        </div>
                        <div className="grid w-full shrink-0 gap-2.5 sm:grid-cols-2 md:w-72">
                          <div>
                            <p className="mb-1 font-mono text-[9px] uppercase tracking-wide-mc text-faint">
                              score <span className="telemetry text-ink">{scorePct}/100</span>
                            </p>
                            <ScoreBar pct={scorePct} tone="score" delay={0.05 * idx} />
                          </div>
                          <div>
                            <p className="mb-1 font-mono text-[9px] uppercase tracking-wide-mc text-faint">
                              confidence <span className="telemetry text-dim">{confPct}%</span>
                            </p>
                            <ScoreBar pct={confPct} tone="confidence" delay={0.05 * idx} />
                          </div>
                        </div>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent>
                      <ScenarioDetail result={result} index={idx} />
                    </AccordionContent>
                  </AccordionItem>
                );
              })}
            </Accordion>
          </HudPanel>
        </motion.section>
      )}

      {/* Crop catalogue browser */}
      <motion.section variants={RISE} custom={4} initial="hidden" whileInView="show" viewport={{ once: true }} aria-label="Crop characteristics catalogue">
        <QueryState
          isLoading={crops.isPending}
          isError={crops.isError}
          error={crops.error}
          onRetry={() => crops.refetch()}
          label="Crop catalogue"
          skeleton={<SkeletonPanel label="Reading crop catalogue" rows={6} />}
          isEmpty={!!crops.data && crops.data.crops.length === 0}
          empty={<EmptyState label="Crop catalogue" hint="The FAO-cited catalogue is empty — no crop characteristics can be shown." />}
        >
          <HudPanel>
            <div className="flex flex-wrap items-center gap-2">
              <BookOpen className="h-4 w-4 text-iris" aria-hidden />
              <h3 className="font-display text-sm font-bold uppercase tracking-wide-mc text-ink">Crop characteristics catalogue</h3>
              <span className="font-mono text-[10px] uppercase tracking-wide-mc text-faint">{crops.data?.catalogueVersion} · FAO-cited values</span>
            </div>
            <div className="mt-3 max-h-96 overflow-x-auto overflow-y-auto rounded-sm border border-edge">
              <table className="mc-table w-full min-w-[46rem]">
                <thead className="sticky top-0 z-10 bg-panel">
                  <tr className="border-b border-edge">
                    <th className="px-3 py-2 text-left">Crop</th>
                    <th className="px-3 py-2 text-left">Family</th>
                    <th className="px-3 py-2 text-left">Days</th>
                    <th className="px-3 py-2 text-left">Water req (mm)</th>
                    <th className="px-3 py-2 text-left">N-fix</th>
                    <th className="px-3 py-2 text-left">pH range</th>
                    <th className="px-3 py-2 text-left">Sources</th>
                  </tr>
                </thead>
                <tbody>
                  {(crops.data?.crops ?? []).map((c) => (
                    <CropRow key={c.cropKey} crop={c} />
                  ))}
                </tbody>
              </table>
            </div>
          </HudPanel>
        </QueryState>
      </motion.section>
    </div>
  );
}

function CropRow({ crop }: { crop: CropDef }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="cursor-pointer bg-panel/30 transition-colors hover:bg-panel-2/60" onClick={() => setOpen(!open)} aria-expanded={open} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!open); } }}>
        <td className="px-3 py-2">
          <div className="font-medium text-ink">{crop.name}</div>
          <div className="text-[10px] italic text-faint">{crop.scientificName}</div>
        </td>
        <td className="px-3 py-2">
          <span className={cn('rounded-sm border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide-mc', FAMILY_COLORS[crop.familyGroup] ?? 'border-edge text-dim')}>
            {crop.familyGroup}
          </span>
        </td>
        <td className="telemetry px-3 py-2">{crop.growthDays[0]}–{crop.growthDays[1]}</td>
        <td className="telemetry px-3 py-2">{crop.waterReqMm[0]}–{crop.waterReqMm[1]}</td>
        <td className="px-3 py-2">{crop.nFixation ? <Badge variant="outline" className="border-signal/40 text-signal">legume</Badge> : '—'}</td>
        <td className="telemetry px-3 py-2">{crop.soilPh[0]}–{crop.soilPh[1]}</td>
        <td className="px-3 py-2 text-[10px] text-faint" title={crop.sources.join('; ')}>{crop.sources.length} citation(s)</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7} className="border-b border-edge/60 bg-panel-2/40 px-3 py-2.5">
            <p className="text-[11px] leading-relaxed text-dim">{crop.notes}</p>
            <ul className="mt-1 list-inside list-disc text-[10px] text-faint">
              {crop.sources.map((s, i) => <li key={i}>{s}</li>)}
            </ul>
          </td>
        </tr>
      )}
    </>
  );
}

function ScenarioDetail({ result, index }: { result: RotationResult; index: number }) {
  return (
    <div className="flex flex-col gap-4 pb-2">
      {/* Incompatible rules — crit */}
      {result.incompatible.length > 0 && (
        <div className="rounded-sm border border-crit/40 bg-crit/5 p-3" role="alert">
          <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wide-mc text-crit">
            <ShieldAlert className="h-3.5 w-3.5" aria-hidden /> Incompatible rules — hard constraints
          </p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {result.incompatible.map((i, idx) => (
              <li key={idx} className="flex flex-wrap items-baseline gap-x-2 text-[11px] leading-relaxed">
                <span className="rounded-sm border border-crit/40 bg-crit/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide-mc text-crit">{i.rule}</span>
                <span className="text-dim">{i.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Missing information — caution */}
      {result.missingInformation.length > 0 && (
        <div className="rounded-sm border border-caution/35 bg-caution/5 p-3" role="note">
          <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wide-mc text-caution">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> Missing information — confidence lowered, not fabricated
          </p>
          <ul className="mt-2 list-inside list-disc text-[11px] leading-relaxed text-dim">
            {result.missingInformation.map((m, i) => <li key={i}>{m}</li>)}
          </ul>
        </div>
      )}

      {/* Factor breakdown — mono criterion ledger */}
      <div className="grid gap-2 sm:grid-cols-2">
        {result.factors.map((f, fi) => {
          const scorePct = f.score === null ? null : Math.round(f.score * 100);
          const scoreTone = f.score === null ? 'text-caution' : f.score >= 0.7 ? 'text-signal' : f.score >= 0.4 ? 'text-caution' : 'text-crit';
          return (
            <div key={f.criterion} className="rounded-sm border border-edge bg-panel-2/40 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[10px] uppercase tracking-wide-mc text-dim">{f.criterion}</span>
                <span className="telemetry text-xs">
                  {f.score === null ? (
                    <span className="rounded-sm border border-caution/40 bg-caution/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide-mc text-caution">not assessed</span>
                  ) : (
                    <span className={scoreTone}>{scorePct}/100</span>
                  )}
                </span>
              </div>
              {scorePct !== null && (
                <div className="mt-1.5">
                  <ScoreBar pct={scorePct} tone="score" delay={0.04 * fi} />
                </div>
              )}
              <p className="mt-2 text-[11px] leading-relaxed text-faint">
                {f.explanation.length > 320 ? f.explanation.slice(0, 320) + '…' : f.explanation}
              </p>
              <div className="telemetry mt-1.5 flex flex-wrap items-center gap-x-3 text-[9px] uppercase tracking-wide-mc text-faint">
                <span>weight {f.weight.toFixed(2)}</span>
                {f.missingDataReason && <span className="text-caution">missing — {f.missingDataReason}</span>}
              </div>
            </div>
          );
        })}
      </div>

      {/* Narrative */}
      {result.narrative.length > 0 && (
        <ul className="list-inside list-disc space-y-1 text-xs leading-relaxed text-dim">
          {result.narrative.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      )}
      <p className="telemetry text-[9px] uppercase tracking-wide-mc text-faint">
        rule set {result.ruleVersion} · deterministically re-runnable · scenario #{index + 1}
      </p>
    </div>
  );
}
