'use client';

import { useState } from 'react';
import { useSession } from '@/components/state/store';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api, type ReportResponse } from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { FileText, Printer, Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react';

/** Reports: farm assessment compiled from real stored data; printable. */
export function ReportsView() {
  const { activeFarmId, setView } = useSession();
  const { toast } = useToast();
  const [report, setReport] = useState<ReportResponse | null>(null);

  const generate = useMutation({
    mutationFn: () => api.report(activeFarmId!),
    onSuccess: (data) => {
      setReport(data);
      toast({ title: 'Report compiled', description: `${data.trendAnalyses.length} trend analyses · ${data.rotationScenarios.length} scenarios · ${data.provenance.length} provenance records.` });
    },
    onError: () => toast({ title: 'Report failed', variant: 'destructive' }),
  });

  if (!activeFarmId) {
    return (
      <Card className="border-dashed border-slate-800 bg-slate-900/20">
        <CardContent className="py-10 text-center flex flex-col items-center gap-3 text-sm text-slate-500">
          <FileText className="h-8 w-8 text-slate-600" aria-hidden />
          <p>Reports are compiled per farm from stored evidence.</p>
          <Button variant="outline" className="border-slate-700 text-slate-200" onClick={() => setView('farm')}>Set up a farm first</Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="mx-auto max-w-4xl flex flex-col gap-6">
      <Card className="border-slate-800 bg-slate-900/40 print:hidden">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Farm assessment report</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-slate-400 max-w-2xl">
            Compiles environmental record, trend statistics, soil information, rotation comparisons, provenance ledger
            and methodology — from stored real observations only. Use your browser&apos;s print dialog to save as PDF
            (print styles included).
          </p>
          <Button onClick={() => generate.mutate()} disabled={generate.isPending} className="w-fit bg-emerald-600 hover:bg-emerald-500 text-white">
            {generate.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> Compiling…
              </>
            ) : (
              'Generate report'
            )}
          </Button>
          {report && (
            <Button variant="outline" onClick={() => window.print()} className="w-fit border-slate-700 text-slate-200">
              <Printer className="mr-1 h-4 w-4" aria-hidden /> Print / save as PDF
            </Button>
          )}
        </CardContent>
      </Card>

      {report && (
        <div id="report" className="rounded-lg border border-slate-800 bg-white text-slate-900 print:border-0 print:p-0">
          <div className="p-6 sm:p-8 flex flex-col gap-6 text-[13px] leading-relaxed">
            <header className="border-b border-slate-200 pb-4">
              <div className="text-[11px] uppercase tracking-widest text-emerald-700 font-semibold">TerraField Atlas · Farm Assessment</div>
              <h1 className="mt-1 text-2xl font-bold text-slate-900">{report.farm.name}</h1>
              <div className="mt-1 text-xs text-slate-600">
                {report.farm.region ? `${report.farm.region}, ` : ''}{report.farm.country ?? ''} · centroid {report.farm.location.lat.toFixed(4)}°, {report.farm.location.lon.toFixed(4)}°
                {report.farm.areaHa ? ` · ${(report.farm.areaHa / 100).toFixed(2)} km² boundary` : ''}
              </div>
              <div className="mt-1 text-[11px] text-slate-500">Generated {new Date(report.generatedAt).toUTCString()} · engines: {report.methodology.trendEngine.slice(0, 60)}…</div>
            </header>

            <section>
              <h2 className="text-base font-semibold mb-2">1 · Environmental record</h2>
              {report.environmentalRecord.available ? (
                <div className="text-xs text-slate-700 space-y-1">
                  <p>{report.environmentalRecord.observationCount.toLocaleString()} real NASA POWER observations ({report.environmentalRecord.period.start} → {report.environmentalRecord.period.end}).</p>
                  <p className="text-slate-500">{report.environmentalRecord.sources}. Dataset version: {report.environmentalRecord.datasetVersions[0]}.</p>
                  {report.environmentalRecord.climatology && (
                    <p className="text-slate-500">Rainfall climatology ({report.environmentalRecord.climatology.years} years), median mm/month: [{report.environmentalRecord.climatology.rainfallMonthlyMedianMm.map((m) => Math.round(m)).join(', ')}].</p>
                  )}
                </div>
              ) : (
                <p className="text-xs text-amber-700">No environmental record ingested for this farm yet.</p>
              )}
            </section>

            <section>
              <h2 className="text-base font-semibold mb-2">2 · Environmental trends</h2>
              {report.trendAnalyses.length === 0 ? (
                <p className="text-xs text-slate-500">No trend analyses stored.</p>
              ) : (
                <table className="w-full text-[11px] border-collapse">
                  <thead>
                    <tr className="border-b border-slate-300 text-left text-slate-600">
                      <th className="py-1.5 pr-2 font-medium">Variable</th>
                      <th className="py-1.5 pr-2 font-medium">Direction</th>
                      <th className="py-1.5 pr-2 font-medium">Slope / yr</th>
                      <th className="py-1.5 pr-2 font-medium">95% CI</th>
                      <th className="py-1.5 pr-2 font-medium">p</th>
                      <th className="py-1.5 font-medium">n (months)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.trendAnalyses.map((t) => (
                      <tr key={t.variable} className="border-b border-slate-100">
                        <td className="py-1.5 pr-2">{t.label} <span className="text-slate-400">({t.unit})</span></td>
                        <td className="py-1.5 pr-2">{t.direction}{t.significant ? ' *' : ''}</td>
                        <td className="py-1.5 pr-2 font-mono">{t.slopePerYear?.toFixed(3) ?? 'n/a'}</td>
                        <td className="py-1.5 pr-2 font-mono">{t.ci[0] !== null ? `${t.ci[0]?.toFixed(2)}…${t.ci[1]?.toFixed(2)}` : 'n/a'}</td>
                        <td className="py-1.5 pr-2 font-mono">{t.pValue?.toExponential(1) ?? 'n/a'}{t.fdrAdjustedP !== null ? ` (FDR ${t.fdrAdjustedP.toExponential(1)})` : ''}</td>
                        <td className="py-1.5 font-mono">{t.sampleCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="mt-1 text-[10px] text-slate-500">* significant at 0.05 after seasonal Mann-Kendall with FDR control. Interpretations in the appendix of each analysis (stored in the platform).</p>
            </section>

            <section>
              <h2 className="text-base font-semibold mb-2">3 · Soil information</h2>
              <div className="text-xs text-slate-700 space-y-1">
                {report.soilInformation.measured ? (
                  <p>Measured ({String(report.soilInformation.measured.source)}): pH {String(report.soilInformation.measured.ph ?? '—')}, texture {String(report.soilInformation.measured.texture ?? '—')}, OC {String(report.soilInformation.measured.organicCarbonPct ?? '—')}%.</p>
                ) : (
                  <p className="text-amber-700">No measured soil test on file — the soil-suitability criterion is not assessed in scoring.</p>
                )}
                {report.soilInformation.supplementaryModeled && (
                  <p className="text-slate-500">Supplementary modeled profile (SoilGrids): pH {String(report.soilInformation.supplementaryModeled.ph ?? '—')} — model estimate, not an in-field measurement.</p>
                )}
                <p className="text-slate-500">{report.soilInformation.note}</p>
              </div>
            </section>

            <section>
              <h2 className="text-base font-semibold mb-2">4 · Crop-rotation comparison</h2>
              {report.rotationScenarios.length === 0 ? (
                <p className="text-xs text-slate-500">No scenarios evaluated yet.</p>
              ) : (
                <div className="flex flex-col gap-3">
                  {report.rotationScenarios.map((s) => (
                    <div key={s.name + s.createdAt} className="rounded border border-slate-200 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-sm">{s.name}</span>
                        <span className="font-mono text-xs">{Math.round(s.overallScore * 100)}/100</span>
                        <span className="text-[10px] text-slate-500">confidence {Math.round(s.confidence * 100)}%</span>
                      </div>
                      <div className="mt-1 text-xs text-slate-600">Sequence: {s.cropKeys.join(' → ')} · rule set {s.ruleVersion}</div>
                      {s.incompatible.length > 0 && (
                        <ul className="mt-1 text-[11px] text-red-700 list-disc list-inside">
                          {s.incompatible.map((i, idx) => <li key={idx}>{i.detail}</li>)}
                        </ul>
                      )}
                      <ul className="mt-1 text-[11px] text-slate-600 list-disc list-inside">
                        {s.fullResult.narrative.map((n, i) => <li key={i}>{n}</li>)}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section>
              <h2 className="text-base font-semibold mb-2">5 · Provenance (most recent provider requests)</h2>
              <table className="w-full text-[10px] border-collapse">
                <thead>
                  <tr className="border-b border-slate-300 text-left text-slate-600">
                    <th className="py-1 pr-2 font-medium">Provider</th>
                    <th className="py-1 pr-2 font-medium">Operation</th>
                    <th className="py-1 pr-2 font-medium">Status</th>
                    <th className="py-1 pr-2 font-medium">Retrieved (UTC)</th>
                  </tr>
                </thead>
                <tbody>
                  {report.provenance.map((p, i) => (
                    <tr key={i} className="border-b border-slate-100">
                      <td className="py-1 pr-2">{p.provider}</td>
                      <td className="py-1 pr-2 font-mono">{p.operation}</td>
                      <td className="py-1 pr-2 font-mono">{p.status} {p.ok ? '✓' : '✗'}</td>
                      <td className="py-1 font-mono">{new Date(p.retrievedAt).toISOString().slice(0, 19).replace('T', ' ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section>
              <h2 className="text-base font-semibold mb-2">6 · Methodology</h2>
              <div className="text-xs text-slate-700 space-y-2">
                <p><span className="font-medium">Trend engine:</span> {report.methodology.trendEngine}</p>
                <p><span className="font-medium">Rotation engine:</span> {report.methodology.rotationEngine}</p>
                <ul className="list-disc list-inside text-slate-600 space-y-0.5">
                  {report.methodology.honestyRules.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              </div>
            </section>

            <section>
              <h2 className="text-base font-semibold mb-2 flex items-center gap-1.5"><AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden /> 7 · Known limitations</h2>
              <ul className="text-xs text-slate-600 list-disc list-inside space-y-1">
                {report.limitations.map((l, i) => <li key={i}>{l}</li>)}
              </ul>
            </section>

            <footer className="border-t border-slate-200 pt-3 text-[10px] text-slate-500">
              TerraField Atlas · NASA Space Apps Challenge 2026 · data: NASA POWER (LaRC), NASA GIBS EOSDIS, ISRIC SoilGrids ·
              This report describes observed environmental associations and evidence-based compatibility only; it does not
              predict yields or profit.
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
