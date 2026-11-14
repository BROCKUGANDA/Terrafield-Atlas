'use client';

import { useState } from 'react';
import { motion, type Variants } from 'framer-motion';
import { useSession } from '@/components/state/store';
import { useMutation } from '@tanstack/react-query';
import { api, type ReportResponse } from '@/lib/api-client';
import { logEvent } from '@/components/state/log-store';
import { downloadJson, timestampSlug } from '@/lib/export';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { Kicker, SectionHeader, CoordReadout } from '@/components/ui-mc/kit';
import { EmptyState, FaultPanel } from '@/components/system/query-state';
import { SweepLoader } from '@/components/system/skeletons';
import { FileText, Printer, AlertTriangle, Braces } from 'lucide-react';
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
      logEvent({
        severity: 'success',
        category: 'REPORT',
        title: 'Field report compiled',
        detail: `“${data.farm.name}” — ${data.environmentalRecord.observationCount.toLocaleString()} stored observations, ${data.trendAnalyses.length} trend analyses, ${data.rotationScenarios.length} rotation scenarios, ${data.provenance.length} provenance records. Compiled from stored real data only.`,
        view: 'reports',
      });
    },
    onError: () => {
      toast({ title: 'Report failed', variant: 'destructive' });
      logEvent({
        severity: 'crit',
        category: 'REPORT',
        title: 'Field report compilation failed',
        detail: 'The compiler reads only stored evidence; a failed build produces no partial document.',
        view: 'reports',
      });
    },
  });

  const exportReportJson = () => {
    if (!report) return;
    const slug = report.farm.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'farm';
    downloadJson(`terrafield-field-report-${slug}-${timestampSlug()}`, report);
    logEvent({
      severity: 'info',
      category: 'EXPORT',
      title: 'Field report exported as JSON',
      detail: `Full compiled document for “${report.farm.name}” — environmental record, trend statistics, soil information, rotation scenarios, provenance and methodology.`,
      view: 'reports',
    });
    toast({ title: 'Report exported', description: 'Complete compiled document written to JSON.' });
  };

  if (!activeFarmId) {
    return (
      <div className="mx-auto max-w-3xl">
        <EmptyState
          label="Field reports"
          hint="Reports are compiled per farm from stored evidence."
          action={
            <Button variant="outline" size="sm" className={cn('mt-2 uppercase', MONO_BTN)} onClick={() => setView('farm')}>
              <FileText className="h-3.5 w-3.5" aria-hidden /> Set up a farm first
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <motion.div variants={RISE} custom={0} initial="hidden" whileInView="show" viewport={{ once: true }} className="print:hidden">
        <SectionHeader
          kicker="Field Planning // Mission Documentation"
          title="Field Reports"
          description="Compiles environmental record, trend statistics, soil information, rotation comparisons, provenance ledger and methodology — from stored real observations only. Use your browser's print dialog to save as PDF (print styles included)."
          actions={
            <div className="flex flex-wrap items-center gap-2.5">
              <Button onClick={() => generate.mutate()} disabled={generate.isPending} data-tour="reports-generate" className={cn('uppercase', MONO_BTN)}>
                {generate.isPending ? (
                  <>
                    <span className="anim-blink h-1.5 w-1.5 rounded-full bg-primary-foreground" aria-hidden /> Compiling…
                  </>
                ) : (
                  'Generate report'
                )}
              </Button>
              {report && (
                <>
                  <Button variant="outline" onClick={() => window.print()} className={cn('uppercase', MONO_BTN)}>
                    <Printer className="h-3.5 w-3.5" aria-hidden /> Print / save as PDF
                  </Button>
                  <Button
                    variant="outline"
                    onClick={exportReportJson}
                    className={cn('uppercase', MONO_BTN)}
                    aria-label="Export the compiled report as JSON"
                  >
                    <Braces className="h-3.5 w-3.5" aria-hidden /> JSON
                  </Button>
                </>
              )}
            </div>
          }
        />
      </motion.div>

      {generate.isPending && (
        <motion.div variants={RISE} custom={1} initial="hidden" animate="show" role="status" aria-live="polite">
          <SweepLoader label="Compiling field report" />
        </motion.div>
      )}
      {generate.isError && (
        <motion.div variants={RISE} custom={1} initial="hidden" animate="show">
          <FaultPanel
            error={generate.error}
            label="Report compilation"
            onRetry={() => generate.mutate()}
            hint="The compiler reads only stored evidence; a failed build produces no partial document."
          />
        </motion.div>
      )}

      {report && !generate.isPending && (
        <motion.div variants={RISE} custom={1} initial="hidden" animate="show">
          <article
            id="report"
            aria-label="Farm assessment report document"
            className="hud hud-calm relative overflow-hidden print:border-0 print:bg-white print:text-neutral-900"
          >
            <div className="grid-bg p-6 sm:p-8 print:bg-none print:p-0">
              <div className="flex flex-col gap-6 text-[13px] leading-relaxed print:text-neutral-800">

                {/* Cover block — mono mission document identity */}
                <header className="border-b border-edge pb-5 print:border-neutral-300">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="font-mono text-[11px] font-semibold uppercase tracking-mission text-nasa print:text-neutral-900">TerraField Atlas · Farm Assessment</p>
                    <p className="telemetry text-[10px] uppercase tracking-wide-mc text-faint print:text-neutral-500">field report · no fabrication</p>
                  </div>
                  <h1 className="mt-2 font-display text-2xl font-bold uppercase tracking-wide-mc text-ink print:text-neutral-900">{report.farm.name}</h1>
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-dim print:text-neutral-600">
                    <CoordReadout lat={report.farm.location.lat} lon={report.farm.location.lon} className="print:text-neutral-700" />
                    <span>
                      {report.farm.region ? `${report.farm.region}, ` : ''}{report.farm.country ?? ''}
                    </span>
                    {report.farm.areaHa ? <span>{(report.farm.areaHa / 100).toFixed(2)} km² boundary</span> : null}
                  </div>
                  <div className="telemetry mt-2 text-[11px] text-faint print:text-neutral-500">
                    Generated {new Date(report.generatedAt).toUTCString()} · engines: {report.methodology.trendEngine.slice(0, 60)}…
                  </div>
                </header>

                {/* 1 · Environmental record */}
                <DocSection index="01" title="Environmental record">
                  {report.environmentalRecord.available ? (
                    <div className="text-xs text-dim space-y-1 print:text-neutral-700">
                      <p>{report.environmentalRecord.observationCount.toLocaleString()} real NASA POWER observations ({report.environmentalRecord.period.start} → {report.environmentalRecord.period.end}).</p>
                      <p className="text-faint print:text-neutral-500">{report.environmentalRecord.sources}. Dataset version: {report.environmentalRecord.datasetVersions[0]}.</p>
                      {report.environmentalRecord.climatology && (
                        <p className="text-faint print:text-neutral-500">Rainfall climatology ({report.environmentalRecord.climatology.years} years), median mm/month: [{report.environmentalRecord.climatology.rainfallMonthlyMedianMm.map((m) => Math.round(m)).join(', ')}].</p>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-caution print:text-amber-700">No environmental record ingested for this farm yet.</p>
                  )}
                </DocSection>

                {/* 2 · Environmental trends */}
                <DocSection index="02" title="Environmental trends">
                  {report.trendAnalyses.length === 0 ? (
                    <p className="text-xs text-faint print:text-neutral-500">No trend analyses stored.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-[11px]">
                        <thead>
                          <tr className="border-b border-edge text-left print:border-neutral-300">
                            <th className="py-1.5 pr-2 font-mono text-[9px] font-semibold uppercase tracking-wide-mc text-faint">Variable</th>
                            <th className="py-1.5 pr-2 font-mono text-[9px] font-semibold uppercase tracking-wide-mc text-faint">Direction</th>
                            <th className="py-1.5 pr-2 font-mono text-[9px] font-semibold uppercase tracking-wide-mc text-faint">Slope / yr</th>
                            <th className="py-1.5 pr-2 font-mono text-[9px] font-semibold uppercase tracking-wide-mc text-faint">95% CI</th>
                            <th className="py-1.5 pr-2 font-mono text-[9px] font-semibold uppercase tracking-wide-mc text-faint">p</th>
                            <th className="py-1.5 font-mono text-[9px] font-semibold uppercase tracking-wide-mc text-faint">n (months)</th>
                          </tr>
                        </thead>
                        <tbody className="text-dim print:text-neutral-700">
                          {report.trendAnalyses.map((t) => (
                            <tr key={t.variable} className="border-b border-edge/60 print:border-neutral-200">
                              <td className="py-1.5 pr-2">{t.label} <span className="text-faint print:text-neutral-500">({t.unit})</span></td>
                              <td className="py-1.5 pr-2">{t.direction}{t.significant ? ' *' : ''}</td>
                              <td className="telemetry py-1.5 pr-2">{t.slopePerYear?.toFixed(3) ?? 'n/a'}</td>
                              <td className="telemetry py-1.5 pr-2">{t.ci[0] !== null ? `${t.ci[0]?.toFixed(2)}…${t.ci[1]?.toFixed(2)}` : 'n/a'}</td>
                              <td className="telemetry py-1.5 pr-2">{t.pValue?.toExponential(1) ?? 'n/a'}{t.fdrAdjustedP !== null ? ` (FDR ${t.fdrAdjustedP.toExponential(1)})` : ''}</td>
                              <td className="telemetry py-1.5">{t.sampleCount}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <p className="mt-1 text-[10px] text-faint print:text-neutral-500">* significant at 0.05 after seasonal Mann-Kendall with FDR control. Interpretations in the appendix of each analysis (stored in the platform).</p>
                </DocSection>

                {/* 3 · Soil information */}
                <DocSection index="03" title="Soil information">
                  <div className="text-xs text-dim space-y-1 print:text-neutral-700">
                    {report.soilInformation.measured ? (
                      <p>Measured ({String(report.soilInformation.measured.source)}): pH {String(report.soilInformation.measured.ph ?? '—')}, texture {String(report.soilInformation.measured.texture ?? '—')}, OC {String(report.soilInformation.measured.organicCarbonPct ?? '—')}%.</p>
                    ) : (
                      <p className="text-caution print:text-amber-700">No measured soil test on file — the soil-suitability criterion is not assessed in scoring.</p>
                    )}
                    {report.soilInformation.supplementaryModeled && (
                      <p className="text-faint print:text-neutral-500">Supplementary modeled profile (SoilGrids): pH {String(report.soilInformation.supplementaryModeled.ph ?? '—')} — model estimate, not an in-field measurement.</p>
                    )}
                    <p className="text-faint print:text-neutral-500">{report.soilInformation.note}</p>
                  </div>
                </DocSection>

                {/* 4 · Crop-rotation comparison */}
                <DocSection index="04" title="Crop-rotation comparison">
                  {report.rotationScenarios.length === 0 ? (
                    <p className="text-xs text-faint print:text-neutral-500">No scenarios evaluated yet.</p>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {report.rotationScenarios.map((s) => (
                        <div key={s.name + s.createdAt} className="rounded-sm border border-edge bg-panel-2/40 p-3 print:border-neutral-300 print:bg-neutral-50">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-display text-sm font-bold uppercase tracking-wide-mc text-ink print:text-neutral-900">{s.name}</span>
                            <span className="telemetry text-xs text-dim print:text-neutral-700">{Math.round(s.overallScore * 100)}/100</span>
                            <span className="font-mono text-[10px] uppercase tracking-wide-mc text-faint print:text-neutral-500">confidence {Math.round(s.confidence * 100)}%</span>
                          </div>
                          <div className="telemetry mt-1 text-[11px] text-faint print:text-neutral-600">Sequence: {s.cropKeys.join(' → ')} · rule set {s.ruleVersion}</div>
                          {s.incompatible.length > 0 && (
                            <ul className="mt-1 list-inside list-disc text-[11px] text-crit print:text-red-700">
                              {s.incompatible.map((i, idx) => <li key={idx}>{i.detail}</li>)}
                            </ul>
                          )}
                          <ul className="mt-1 list-inside list-disc text-[11px] text-faint print:text-neutral-600">
                            {s.fullResult.narrative.map((n, i) => <li key={i}>{n}</li>)}
                          </ul>
                        </div>
                      ))}
                    </div>
                  )}
                </DocSection>

                {/* 5 · Provenance */}
                <DocSection index="05" title="Provenance (most recent provider requests)">
                  <div className="overflow-x-auto">
                    <table className="w-full text-[10px]">
                      <thead>
                        <tr className="border-b border-edge text-left print:border-neutral-300">
                          <th className="py-1 pr-2 font-mono text-[9px] font-semibold uppercase tracking-wide-mc text-faint">Provider</th>
                          <th className="py-1 pr-2 font-mono text-[9px] font-semibold uppercase tracking-wide-mc text-faint">Operation</th>
                          <th className="py-1 pr-2 font-mono text-[9px] font-semibold uppercase tracking-wide-mc text-faint">Status</th>
                          <th className="py-1 font-mono text-[9px] font-semibold uppercase tracking-wide-mc text-faint">Retrieved (UTC)</th>
                        </tr>
                      </thead>
                      <tbody className="text-dim print:text-neutral-700">
                        {report.provenance.map((p, i) => (
                          <tr key={i} className="border-b border-edge/60 print:border-neutral-200">
                            <td className="py-1 pr-2">{p.provider}</td>
                            <td className="telemetry py-1 pr-2">{p.operation}</td>
                            <td className={`telemetry py-1 pr-2 ${p.ok ? 'text-signal' : 'text-crit'}`}>{p.status} {p.ok ? '✓' : '✗'}</td>
                            <td className="telemetry py-1">{new Date(p.retrievedAt).toISOString().slice(0, 19).replace('T', ' ')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </DocSection>

                {/* 6 · Methodology */}
                <DocSection index="06" title="Methodology">
                  <div className="text-xs text-dim space-y-2 print:text-neutral-700">
                    <p><span className="font-medium text-ink print:text-neutral-900">Trend engine:</span> {report.methodology.trendEngine}</p>
                    <p><span className="font-medium text-ink print:text-neutral-900">Rotation engine:</span> {report.methodology.rotationEngine}</p>
                    <ul className="list-inside list-disc text-faint space-y-0.5 print:text-neutral-600">
                      {report.methodology.honestyRules.map((r, i) => <li key={i}>{r}</li>)}
                    </ul>
                  </div>
                </DocSection>

                {/* 7 · Known limitations — caution block */}
                <section>
                  <div className="rounded-sm border border-caution/40 bg-caution/5 p-4 print:border-amber-500 print:bg-amber-50">
                    <h2 className="flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-wide-mc text-caution print:text-amber-700">
                      <AlertTriangle className="h-4 w-4" aria-hidden /> 07 · Known limitations
                    </h2>
                    <ul className="mt-2 list-inside list-disc text-xs text-dim space-y-1 print:text-neutral-700">
                      {report.limitations.map((l, i) => <li key={i}>{l}</li>)}
                    </ul>
                  </div>
                </section>

                <footer className="border-t border-edge pt-3 text-[10px] text-faint print:border-neutral-300 print:text-neutral-500">
                  TerraField Atlas · NASA Space Apps Challenge 2026 · data: NASA POWER (LaRC), NASA GIBS EOSDIS, ISRIC SoilGrids ·
                  This report describes observed environmental associations and evidence-based compatibility only; it does not
                  predict yields or profit.
                </footer>

                {/* Print-only provenance stamp — appears on paper, hidden on screen */}
                <p className="print-only mt-2 border-t border-neutral-300 pt-2 font-mono text-[9px] uppercase tracking-wide text-neutral-600">
                  Printed from the TerraField Atlas mission console · {new Date(report.generatedAt).toUTCString()} · every figure
                  traceable to source + retrieval time · missing data reported as missing, never fabricated.
                </p>
              </div>
            </div>
          </article>
        </motion.div>
      )}
    </div>
  );
}

/** Numbered report section with kicker eyebrow. */
function DocSection({ index, title, children }: { index: string; title: string; children: React.ReactNode }) {
  return (
    <section>
      <Kicker>{index} · {title}</Kicker>
      <div className="mt-2">{children}</div>
    </section>
  );
}
