'use client';

import { useSession } from '@/components/state/store';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Satellite, Droplets, Thermometer, Leaf, Flame, FileSearch, ArrowRight, AlertTriangle } from 'lucide-react';

export function LandingView() {
  const setView = useSession((s) => s.setView);
  const sources = useQuery({ queryKey: ['sources'], queryFn: api.sources });

  return (
    <div className="mx-auto max-w-6xl flex flex-col gap-10">
      {/* Hero */}
      <section className="pt-6 sm:pt-10">
        <div className="flex items-center gap-2 text-emerald-400 text-xs font-semibold uppercase tracking-widest">
          <Satellite className="h-4 w-4" aria-hidden /> NASA Space Apps Challenge 2026 · Field Shift
        </div>
        <h1 className="mt-3 text-3xl sm:text-5xl font-bold tracking-tight text-slate-50 leading-tight">
          TerraField Atlas
        </h1>
        <p className="mt-4 max-w-2xl text-base sm:text-lg text-slate-400 leading-relaxed">
          Earth-observation intelligence for agricultural resilience. See what NASA satellites observe about your
          land — rainfall, temperature, solar radiation, root-zone moisture, vegetation and fire history — understand
          whether changes are statistically meaningful, and compare evidence-supported crop-rotation options with
          every score explainable and every observation traceable to its source.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button onClick={() => setView('explorer')} className="bg-emerald-600 hover:bg-emerald-500 text-white">
            Explore satellite data <ArrowRight className="ml-1 h-4 w-4" aria-hidden />
          </Button>
          <Button variant="outline" onClick={() => setView('dashboard')} className="border-slate-700 text-slate-200 hover:bg-slate-800">
            Open the dashboard
          </Button>
        </div>
      </section>

      {/* The problem */}
      <section aria-labelledby="problem-heading">
        <h2 id="problem-heading" className="text-xl font-semibold text-slate-100">The problem this product answers</h2>
        <p className="mt-2 text-sm text-slate-400 leading-relaxed max-w-3xl">
          Farmers face shifting rainfall patterns, temperature extremes and fire exposure, yet most decision tools
          either hide their evidence, overstate their certainty, or require data that smallholders do not have.
          TerraField Atlas takes the opposite stance: it is built around six questions, and refuses to answer any of
          them beyond what the evidence supports.
        </p>
        <ol className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-sm text-slate-300 list-decimal list-inside">
          <li className="rounded-lg border border-slate-800 bg-slate-900/40 p-3">What are the observed environmental conditions here?</li>
          <li className="rounded-lg border border-slate-800 bg-slate-900/40 p-3">How have they changed over time?</li>
          <li className="rounded-lg border border-slate-800 bg-slate-900/40 p-3">Are the changes statistically meaningful?</li>
          <li className="rounded-lg border border-slate-800 bg-slate-900/40 p-3">Which crop rotations fit the evidence?</li>
          <li className="rounded-lg border border-slate-800 bg-slate-900/40 p-3">How do alternatives compare?</li>
          <li className="rounded-lg border border-slate-800 bg-slate-900/40 p-3">What are the limits and uncertainties?</li>
        </ol>
      </section>

      {/* What it does */}
      <section aria-labelledby="features-heading">
        <h2 id="features-heading" className="text-xl font-semibold text-slate-100">What it actually does</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[
            { icon: Droplets, title: 'Real meteorological record', text: '12+ years of daily NASA POWER (MERRA-2) precipitation, temperature, humidity, radiation and root-zone wetness for any coordinate — ingested, stored, versioned.' },
            { icon: Thermometer, title: 'Honest trend detection', text: 'Seasonal Mann-Kendall + Theil-Sen with autocorrelation correction, confidence intervals and FDR control. Two different dates never become a "trend".' },
            { icon: Satellite, title: 'Satellite map layers', text: 'MODIS 250 m daily true color, MOD13Q1 NDVI 16-day composites and SMAP L4 9 km root-zone soil moisture, streamed live from NASA GIBS.' },
            { icon: Leaf, title: 'Explainable rotation planning', text: 'A deterministic engine scores rotation scenarios against FAO-cited crop requirements and your measured soil. Missing data lowers confidence — never the truth.' },
            { icon: Flame, title: 'Fire history', text: 'Real VIIRS 375 m active-fire detections (2015 → present) with confidence and fire radiative power, decoded from NASA GIBS vector tiles.' },
            { icon: FileSearch, title: 'Provenance for every number', text: 'Every external API request — success or failure — is logged with latency, status and retrieval time. Every analysis cites its method.' },
          ].map((f) => (
            <article key={f.title} className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
              <f.icon className="h-5 w-5 text-emerald-400" aria-hidden />
              <h3 className="mt-2 font-semibold text-slate-100 text-sm">{f.title}</h3>
              <p className="mt-1 text-xs text-slate-400 leading-relaxed">{f.text}</p>
            </article>
          ))}
        </div>
      </section>

      {/* Data transparency */}
      <section aria-labelledby="transparency-heading">
        <h2 id="transparency-heading" className="text-xl font-semibold text-slate-100">Data-source transparency</h2>
        <p className="mt-2 text-sm text-slate-400">
          Live source registry, refreshed from the running system. Unreachable or unconfigured sources are shown
          exactly as they are — never silently substituted with fabricated data.
        </p>
        <div className="mt-4 overflow-x-auto rounded-lg border border-slate-800">
          <table className="w-full text-xs">
            <thead className="bg-slate-900/80 text-slate-400">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Source</th>
                <th className="px-3 py-2 text-left font-medium">Dataset</th>
                <th className="px-3 py-2 text-left font-medium">Resolution</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 text-slate-300">
              {(sources.data?.sources ?? []).map((s) => (
                <tr key={s.id} className="bg-slate-900/30">
                  <td className="px-3 py-2 max-w-[14rem] truncate" title={s.provider}>{s.provider.split('—')[0]}</td>
                  <td className="px-3 py-2 max-w-[18rem] truncate" title={s.datasetName}>{s.datasetName}</td>
                  <td className="px-3 py-2 text-slate-400 max-w-[12rem] truncate">{s.spatialResolution}</td>
                  <td className="px-3 py-2">
                    <Badge variant="outline" className={s.status === 'operational' ? 'border-emerald-600/40 text-emerald-400' : 'border-amber-600/40 text-amber-400'}>
                      {s.status}
                    </Badge>
                  </td>
                </tr>
              ))}
              {sources.isLoading && (
                <tr><td colSpan={4} className="px-3 py-6 text-center text-slate-500">Loading source registry…</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Honesty box */}
      <section className="rounded-lg border border-amber-600/30 bg-amber-500/5 p-4" aria-labelledby="honesty-heading">
        <h2 id="honesty-heading" className="flex items-center gap-2 text-sm font-semibold text-amber-300">
          <AlertTriangle className="h-4 w-4" aria-hidden /> What this product deliberately does NOT claim
        </h2>
        <ul className="mt-2 text-xs text-slate-400 list-disc list-inside space-y-1">
          <li>Environmental correlations are never presented as proof of agricultural causation.</li>
          <li>Grid-cell reanalysis is not your farm&apos;s microclimate; 9 km SMAP pixels are not field-scale soil moisture.</li>
          <li>No yield, harvest or profit prediction exists anywhere in the engine.</li>
          <li>Missing measurements reduce confidence; they are never filled with invented values.</li>
        </ul>
      </section>
    </div>
  );
}
