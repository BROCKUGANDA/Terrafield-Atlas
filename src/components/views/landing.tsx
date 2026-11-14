'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import {
  Satellite, Droplets, Thermometer, Leaf, Flame, FileSearch, ArrowRight,
  AlertTriangle, Radio, LogOut, ShieldCheck,
} from 'lucide-react';
import { useSession } from '@/components/state/store';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Kicker, SectionHeader, StatusPill, TelemetryStat, CoordReadout } from '@/components/ui-mc/kit';
import { QueryState, FaultPanel } from '@/components/system/query-state';
import { StatSkeletonRow, SkeletonRows } from '@/components/system/skeletons';
import { EarthGlobe, type GlobeStation } from '@/components/three/earth-globe';
import { cn } from '@/lib/utils';

/**
 * Mission brief + demo console access.
 * Landing view for operators without a session: hero with the procedural
 * telemetry globe, live mission telemetry (real rows only), the six mission
 * questions, capability cards, the live source registry and the honesty box.
 * Every number below is fetched live — nothing is fabricated.
 */

const HERO_INTRO =
  'Earth-observation intelligence for agricultural resilience. See what NASA satellites observe about your land — rainfall, temperature, solar radiation, root-zone moisture, vegetation and fire history — understand whether changes are statistically meaningful, and compare evidence-supported crop-rotation options with every score explainable and every observation traceable to its source.';

const QUESTIONS = [
  'What are the observed environmental conditions here?',
  'How have they changed over time?',
  'Are the changes statistically meaningful?',
  'Which crop rotations fit the evidence?',
  'How do alternatives compare?',
  'What are the limits and uncertainties?',
];

const FEATURES: { icon: typeof Droplets; tone: 'signal' | 'aqua'; title: string; text: string }[] = [
  {
    icon: Droplets,
    tone: 'signal',
    title: 'Real meteorological record',
    text: '12+ years of daily NASA POWER (MERRA-2) precipitation, temperature, humidity, radiation and root-zone wetness for any coordinate — ingested, stored, versioned.',
  },
  {
    icon: Thermometer,
    tone: 'aqua',
    title: 'Honest trend detection',
    text: 'Seasonal Mann-Kendall + Theil-Sen with autocorrelation correction, confidence intervals and FDR control. Two different dates never become a "trend".',
  },
  {
    icon: Satellite,
    tone: 'signal',
    title: 'Satellite map layers',
    text: 'MODIS 250 m daily true color, MOD13Q1 NDVI 16-day composites and SMAP L4 9 km root-zone soil moisture, streamed live from NASA GIBS.',
  },
  {
    icon: Leaf,
    tone: 'aqua',
    title: 'Explainable rotation planning',
    text: 'A deterministic engine scores rotation scenarios against FAO-cited crop requirements and your measured soil. Missing data lowers confidence — never the truth.',
  },
  {
    icon: Flame,
    tone: 'signal',
    title: 'Fire history',
    text: 'Real VIIRS 375 m active-fire detections (2015 → present) with confidence and fire radiative power, decoded from NASA GIBS vector tiles.',
  },
  {
    icon: FileSearch,
    tone: 'aqua',
    title: 'Provenance for every number',
    text: 'Every external API request — success or failure — is logged with latency, status and retrieval time. Every analysis cites its method.',
  },
];

const NOT_CLAIMS = [
  'Environmental correlations are never presented as proof of agricultural causation.',
  'Grid-cell reanalysis is not your farm\u2019s microclimate; 9 km SMAP pixels are not field-scale soil moisture.',
  'No yield, harvest or profit prediction exists anywhere in the engine.',
  'Missing measurements reduce confidence; they are never filled with invented values.',
];

/* Motion contract: staggered fade-up, viewport-gated below the fold. */
const fadeUp = {
  initial: { opacity: 0, y: 14 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
} as const;

// ---------------------------------------------------------------------------
// A/B: landing-hero-v1 — deterministic variant assignment, real exposure and
// outcome ledger (src/lib/experiments.ts). The unit id is a client-generated
// UUID in localStorage — a random label with no identity attached.
// ---------------------------------------------------------------------------
const EXPERIMENT_KEY = 'landing-hero-v1';
const EXPERIMENT_OUTCOME = 'experiment.cta_enter_console';

function visitorUnitId(): string {
  try {
    const existing = localStorage.getItem('tf_ab_unit');
    if (existing) return existing;
    const fresh = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `u-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem('tf_ab_unit', fresh);
    return fresh;
  } catch {
    return `anon-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`;
  }
}

export function LandingView() {
  const operator = useSession((s) => s.operator);
  const login = useSession((s) => s.login);
  const logout = useSession((s) => s.logout);
  const setView = useSession((s) => s.setView);

  const sources = useQuery({ queryKey: ['sources'], queryFn: api.sources });
  const status = useQuery({ queryKey: ['system-status'], queryFn: api.systemStatus });
  const health = useQuery({ queryKey: ['health'], queryFn: api.health });

  const [callsign, setCallsign] = useState('');
  const [hoveredStation, setHoveredStation] = useState<GlobeStation | null>(null);

  // A/B assignment — one fetch on mount; the server records the exposure
  // (distinct-unit ledger). Copy falls back to the control text until the
  // assignment lands; the page never blocks on it.
  const unitIdRef = useRef('');
  const [heroCopy, setHeroCopy] = useState<{ intro: string; cta: string } | null>(null);
  useEffect(() => {
    const unit = visitorUnitId();
    unitIdRef.current = unit;
    let cancelled = false;
    fetch(`/api/v1/experiments?exp=${EXPERIMENT_KEY}&unit=${encodeURIComponent(unit)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { copy?: { intro: string; cta: string } } | null) => {
        if (!cancelled && d?.copy) setHeroCopy(d.copy);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const heroIntro = heroCopy?.intro ?? HERO_INTRO;
  const heroCta = heroCopy?.cta ?? 'Enter console';

  /** Outcome ledger — at most ONE conversion recorded per unit per session. */
  const recordEnterOutcome = () => {
    const unit = unitIdRef.current;
    if (!unit) return;
    try {
      if (sessionStorage.getItem('tf_ab_outcome_done') === '1') return;
      sessionStorage.setItem('tf_ab_outcome_done', '1');
    } catch {
      /* storage unavailable — still record; the ledger tolerates repeats */
    }
    fetch('/api/v1/experiments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ exp: EXPERIMENT_KEY, unit, outcome: EXPERIMENT_OUTCOME }),
    }).catch(() => {});
  };

  // Lazy-mount the 3D layer after first paint to keep the hero instant.
  const [globeReady, setGlobeReady] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setGlobeReady(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const db = status.data?.database;
  const dataSources = health.data?.dataSources;
  const providersOk = dataSources?.filter((d) => d.status === 'operational').length ?? null;

  const enterConsole = () => {
    recordEnterOutcome();
    if (operator) setView('dashboard');
    else login(callsign.trim() || 'GUEST');
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-12 sm:gap-16">
      {/* ---------------------------------------------------------- */}
      {/* HERO                                                        */}
      {/* ---------------------------------------------------------- */}
      <section aria-labelledby="hero-heading" className="pt-2 sm:pt-4">
        <div className="grid items-start gap-8 lg:grid-cols-[1.05fr_0.95fr] lg:gap-10">
          {/* Left column — title, value, console access */}
          <div className="flex flex-col items-start gap-5">
            <motion.div
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
            >
              <Kicker>NASA Space Apps 2026 · Field Shift</Kicker>
            </motion.div>

            <motion.h1
              id="hero-heading"
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, delay: 0.06, ease: [0.22, 1, 0.36, 1] }}
              className="font-display text-5xl font-bold uppercase leading-[0.94] tracking-tight text-ink sm:text-6xl lg:text-7xl"
            >
              TerraField
              <span className="block text-nasa glow-nasa">Atlas</span>
              <span className="sr-only"> — TerraField Atlas mission console</span>
            </motion.h1>

            <motion.p
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, delay: 0.12, ease: [0.22, 1, 0.36, 1] }}
              className="max-w-xl text-sm leading-relaxed text-dim sm:text-base"
            >
              {heroIntro}
            </motion.p>

            {/* Demo access card */}
            <motion.div
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, delay: 0.18, ease: [0.22, 1, 0.36, 1] }}
              className="hud w-full max-w-xl p-4 sm:p-5"
            >
              {operator ? (
                <div className="flex flex-col gap-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <StatusPill status="operational" />
                    <p className="telemetry text-xs uppercase tracking-wide-mc text-dim">
                      Access granted · <span className="text-signal glow-signal">{operator.callsign}</span>
                      <span className="text-faint"> / mission-observer</span>
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2.5">
                    <Button onClick={() => setView('dashboard')} className="bg-nasa text-white hover:bg-nasa/90">
                      Return to console <ArrowRight className="ml-1 h-4 w-4" aria-hidden />
                    </Button>
                    <Button variant="ghost" onClick={logout} className="text-dim hover:text-crit">
                      <LogOut className="mr-1.5 h-4 w-4" aria-hidden /> Sign out
                    </Button>
                  </div>
                  <p className="font-mono text-[10px] leading-relaxed tracking-wide text-faint">
                    Session identifier stays on this device. No credentials, no password, nothing transmitted.
                  </p>
                </div>
              ) : (
                <form
                  className="flex flex-col gap-4"
                  onSubmit={(e) => {
                    e.preventDefault();
                    recordEnterOutcome();
                    login(callsign.trim() || 'GUEST');
                  }}
                >
                  <p className="font-mono text-[10px] font-semibold uppercase tracking-mission text-aqua">
                    Console access — open demo
                  </p>
                  <div className="flex flex-col gap-2.5 sm:flex-row">
                    <label htmlFor="callsign-input" className="sr-only">
                      Operator callsign (optional)
                    </label>
                    <Input
                      id="callsign-input"
                      value={callsign}
                      onChange={(e) => setCallsign(e.target.value)}
                      placeholder="e.g. MKUL-7"
                      autoComplete="off"
                      spellCheck={false}
                      className="h-10 w-full border-edge bg-panel-2 font-mono text-sm tracking-wide text-ink sm:max-w-[16rem]"
                      aria-describedby="access-note"
                    />
                    <Button type="submit" className="h-10 bg-nasa text-white hover:bg-nasa/90">
                      {heroCta} <ArrowRight className="ml-1 h-4 w-4" aria-hidden />
                    </Button>
                  </div>
                  <Button type="button" variant="ghost" onClick={() => { recordEnterOutcome(); login('GUEST'); }} className="h-9 w-fit text-dim hover:text-ink">
                    Continue as guest
                  </Button>
                  <p id="access-note" className="font-mono text-[10px] leading-relaxed tracking-wide text-faint">
                    Open demo — session identifier stays on this device. No credentials, no password, nothing transmitted.
                  </p>
                </form>
              )}
            </motion.div>
          </div>

          {/* Right column — telemetry network globe viewport */}
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, delay: 0.24, ease: [0.22, 1, 0.36, 1] }}
            className="flex flex-col gap-3"
          >
            <div className="hud scanlines relative h-[320px] overflow-hidden md:h-[min(420px,52vh)]">
              <p className="pointer-events-none absolute left-3 top-2.5 z-10 font-mono text-[10px] font-semibold uppercase tracking-mission text-aqua">
                Live telemetry network
              </p>
              <p className="pointer-events-none absolute right-3 top-2.5 z-10 font-mono text-[10px] uppercase tracking-wide-mc text-faint">
                stylized · not imagery
              </p>

              {globeReady ? (
                <EarthGlobe className="absolute inset-0" onStationHover={setHoveredStation} />
              ) : (
                <div className="grid-bg absolute inset-0 flex flex-col items-center justify-center gap-2">
                  <span className="anim-blink h-2 w-2 rounded-full bg-aqua" aria-hidden />
                  <p className="font-mono text-[10px] uppercase tracking-wide-mc text-faint">
                    initializing telemetry renderer…
                  </p>
                </div>
              )}

              {/* Station hover chip (parent-driven) */}
              {hoveredStation && (
                <div className="anim-fade-up hud hud-calm absolute bottom-2.5 right-2.5 z-10 max-w-[72%] px-3 py-2">
                  <p className="truncate font-mono text-[11px] uppercase tracking-wide-mc text-signal glow-signal">
                    {hoveredStation.label}
                  </p>
                  <p className="mt-0.5 flex items-center gap-2">
                    <CoordReadout lat={hoveredStation.lat} lon={hoveredStation.lon} />
                    <span className="font-mono text-[9px] uppercase tracking-wide-mc text-faint">demo preset</span>
                  </p>
                </div>
              )}

              <p className="pointer-events-none absolute bottom-2.5 left-3 z-10 font-mono text-[9px] uppercase leading-relaxed tracking-wide-mc text-faint">
                stylized telemetry network — not an imagery product
              </p>
            </div>

            {/* Source status pills (live registry) */}
            <div className="min-h-[2.25rem]" aria-live="polite">
              {sources.isLoading ? (
                <div className="flex flex-wrap gap-2" role="status">
                  {['power', 'gibs', 'smap', 'firms', 'soilgrids'].map((k) => (
                    <span key={k} className="skeleton-mc h-6 w-28" aria-hidden />
                  ))}
                </div>
              ) : sources.isError ? (
                <FaultPanel
                  error={sources.error}
                  onRetry={() => sources.refetch()}
                  label="Source registry"
                  className="p-3 sm:p-3.5"
                />
              ) : (
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {(sources.data?.sources ?? []).slice(0, 6).map((s) => (
                    <span key={s.id} className="inline-flex items-center gap-1.5">
                      <span className="font-mono text-[10px] uppercase tracking-wide-mc text-faint">
                        {s.provider.split('—')[0]}
                      </span>
                      <StatusPill status={s.status} pulse={false} />
                    </span>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        </div>
      </section>

      {/* ---------------------------------------------------------- */}
      {/* LIVE MISSION TELEMETRY                                      */}
      {/* ---------------------------------------------------------- */}
      <section aria-labelledby="telemetry-heading">
        <span id="telemetry-heading" className="sr-only">Live console telemetry</span>
        <motion.div {...fadeUp} transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}>
          <SectionHeader
            kicker="Mission telemetry"
            title="Live console telemetry"
            description="Read from the running system — real database rows and a live provider probe. If a value is missing, it is shown as missing."
          />
        </motion.div>
        <motion.div {...fadeUp} transition={{ duration: 0.5, delay: 0.08, ease: [0.22, 1, 0.36, 1] }} className="mt-4">
          {status.isLoading ? (
            <div role="status" aria-live="polite">
              <StatSkeletonRow count={4} />
            </div>
          ) : status.isError ? (
            <FaultPanel
              error={status.error}
              onRetry={() => status.refetch()}
              label="System status"
            />
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <TelemetryStat
                label="Observations stored"
                value={db ? db.observations.toLocaleString('en-US') : null}
                unit="rows"
                hint="real rows · POWER ingests"
              />
              <TelemetryStat
                label="Fire detections"
                value={db ? db.fireDetections.toLocaleString('en-US') : null}
                unit="rows"
                hint="VIIRS 375 m · via GIBS"
              />
              <TelemetryStat
                label="Farms registered"
                value={db ? db.farms.toLocaleString('en-US') : null}
                unit="farms"
                hint="operator-registered"
              />
              <TelemetryStat
                label="Providers operational"
                value={providersOk !== null && dataSources ? `${providersOk} / ${dataSources.length}` : null}
                hint={health.isError ? 'health probe unreachable — shown as unknown' : 'live registry probe'}
              />
            </div>
          )}
        </motion.div>
      </section>

      {/* ---------------------------------------------------------- */}
      {/* SIX MISSION QUESTIONS                                       */}
      {/* ---------------------------------------------------------- */}
      <section aria-labelledby="questions-heading">
        <span id="questions-heading" className="sr-only">Six questions, answered honestly</span>
        <motion.div {...fadeUp} transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}>
          <SectionHeader
            kicker="The problem"
            title="Six questions, answered honestly"
            description="Farmers face shifting rainfall patterns, temperature extremes and fire exposure, yet most decision tools either hide their evidence, overstate their certainty, or require data that smallholders do not have. TerraField Atlas takes the opposite stance: it is built around six questions, and refuses to answer any of them beyond what the evidence supports."
          />
        </motion.div>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {QUESTIONS.map((q, i) => (
            <motion.article
              key={q}
              {...fadeUp}
              transition={{ duration: 0.45, delay: i * 0.05, ease: [0.22, 1, 0.36, 1] }}
              className="hud hud-calm flex items-start gap-4 p-4 sm:p-5"
            >
              <p className="telemetry shrink-0 text-3xl font-medium leading-none text-nasa" aria-hidden>
                {String(i + 1).padStart(2, '0')}
              </p>
              <p className="pt-0.5 text-sm leading-relaxed text-ink">{q}</p>
            </motion.article>
          ))}
        </div>
      </section>

      {/* ---------------------------------------------------------- */}
      {/* CAPABILITIES                                                */}
      {/* ---------------------------------------------------------- */}
      <section aria-labelledby="features-heading">
        <span id="features-heading" className="sr-only">What the console actually does</span>
        <motion.div {...fadeUp} transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}>
          <SectionHeader
            kicker="Mission systems"
            title="What the console actually does"
            description="Six subsystems, each built around a real NASA Earth-observation data source with a deterministic method behind it."
          />
        </motion.div>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => (
            <motion.article
              key={f.title}
              {...fadeUp}
              transition={{ duration: 0.45, delay: i * 0.05, ease: [0.22, 1, 0.36, 1] }}
              className="hud hud-calm p-4 sm:p-5"
            >
              <span
                className={cn(
                  'flex h-9 w-9 items-center justify-center rounded-sm border',
                  f.tone === 'signal' ? 'border-signal/30 bg-signal/10' : 'border-aqua/30 bg-aqua/10',
                )}
                aria-hidden
              >
                <f.icon className={cn('h-4 w-4', f.tone === 'signal' ? 'text-signal' : 'text-aqua')} />
              </span>
              <h3 className="mt-3 font-display text-sm font-semibold uppercase tracking-wide-mc text-ink">
                {f.title}
              </h3>
              <p className="mt-1.5 text-xs leading-relaxed text-dim">{f.text}</p>
            </motion.article>
          ))}
        </div>
      </section>

      {/* ---------------------------------------------------------- */}
      {/* DATA-SOURCE TRANSPARENCY                                    */}
      {/* ---------------------------------------------------------- */}
      <section aria-labelledby="transparency-heading">
        <span id="transparency-heading" className="sr-only">Data-source transparency</span>
        <motion.div {...fadeUp} transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}>
          <SectionHeader
            kicker="Source registry"
            title="Data-source transparency"
            description="Live source registry, refreshed from the running system. Unreachable or unconfigured sources are shown exactly as they are — never silently substituted with fabricated data."
            actions={<StatusPill status={sources.isError ? 'unavailable' : sources.isLoading ? 'degraded' : 'nominal'} />}
          />
        </motion.div>
        <motion.div {...fadeUp} transition={{ duration: 0.5, delay: 0.08, ease: [0.22, 1, 0.36, 1] }} className="mt-4">
          <div className="hud overflow-hidden p-0">
            <QueryState
              isLoading={sources.isLoading}
              isError={sources.isError}
              error={sources.error}
              onRetry={() => sources.refetch()}
              label="Source registry"
              isEmpty={!sources.isLoading && !sources.isError && (sources.data?.sources?.length ?? 0) === 0}
              skeleton={
                <div className="p-4 sm:p-5" aria-hidden>
                  <SkeletonRows rows={6} />
                </div>
              }
            >
              <div className="max-h-96 overflow-y-auto">
                <Table className="mc-table w-full min-w-[42rem]">
                  <TableHeader>
                    <TableRow className="border-edge hover:bg-transparent">
                      <TableHead className="px-3 py-2.5 text-left">Source</TableHead>
                      <TableHead className="px-3 py-2.5 text-left">Dataset</TableHead>
                      <TableHead className="px-3 py-2.5 text-left">Resolution</TableHead>
                      <TableHead className="px-3 py-2.5 text-left">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(sources.data?.sources ?? []).map((s) => (
                      <TableRow key={s.id} className="border-edge/60 bg-transparent hover:bg-panel-2/50">
                        <TableCell className="max-w-[13rem] truncate px-3 py-2.5" title={s.provider}>
                          {s.provider.split('—')[0]}
                        </TableCell>
                        <TableCell className="max-w-[17rem] truncate px-3 py-2.5 text-ink/90" title={s.datasetName}>
                          {s.datasetName}
                        </TableCell>
                        <TableCell className="max-w-[11rem] truncate px-3 py-2.5 text-faint" title={s.spatialResolution}>
                          {s.spatialResolution}
                        </TableCell>
                        <TableCell className="px-3 py-2.5">
                          <StatusPill status={s.status} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </QueryState>
          </div>
        </motion.div>
      </section>

      {/* ---------------------------------------------------------- */}
      {/* DELIBERATE HONESTY BOX                                      */}
      {/* ---------------------------------------------------------- */}
      <section aria-labelledby="honesty-heading">
        <motion.div
          {...fadeUp}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="hud hud-calm p-4 sm:p-5"
          style={{ borderColor: 'rgba(255, 178, 36, 0.35)' }}
        >
          <h2 id="honesty-heading" className="flex items-center gap-2 font-display text-sm font-semibold uppercase tracking-wide-mc text-caution">
            <AlertTriangle className="h-4 w-4" aria-hidden /> What this product deliberately does NOT claim
          </h2>
          <ul className="mt-3 grid gap-2 text-xs leading-relaxed text-dim sm:grid-cols-2">
            {NOT_CLAIMS.map((claim) => (
              <li key={claim} className="flex items-start gap-2">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-caution" aria-hidden />
                <span>{claim}</span>
              </li>
            ))}
          </ul>
        </motion.div>
      </section>

      {/* ---------------------------------------------------------- */}
      {/* CLOSING CTA                                                 */}
      {/* ---------------------------------------------------------- */}
      <section aria-labelledby="cta-heading" className="pb-2">
        <motion.div
          {...fadeUp}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="hud grid-bg flex flex-col items-start gap-4 p-6 sm:flex-row sm:items-center sm:justify-between sm:p-8"
        >
          <div className="min-w-0">
            <p className="font-mono text-[10px] font-semibold uppercase tracking-mission text-nasa">
              Join the mission
            </p>
            <h2 id="cta-heading" className="mt-2 font-display text-2xl font-bold uppercase tracking-wide-mc text-ink sm:text-3xl">
              Every recommendation backed by evidence.
            </h2>
            <p className="mt-2 max-w-md text-xs leading-relaxed text-dim">
              Open the console and inspect the same provenance trail every analysis uses: source, method,
              retrieval time and confidence.
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-start gap-2.5 sm:items-end">
            <Button onClick={enterConsole} className="h-10 bg-nasa text-white hover:bg-nasa/90">
              {operator ? 'Return to the console' : 'Enter the console'}
              <ArrowRight className="ml-1 h-4 w-4" aria-hidden />
            </Button>
            <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wide-mc text-faint">
              {operator ? (
                <>
                  <ShieldCheck className="h-3.5 w-3.5 text-signal" aria-hidden />
                  session active · {operator.callsign}
                </>
              ) : (
                <>
                  <Radio className="h-3.5 w-3.5" aria-hidden />
                  demo access · no credentials
                </>
              )}
            </p>
          </div>
        </motion.div>
      </section>
    </div>
  );
}
