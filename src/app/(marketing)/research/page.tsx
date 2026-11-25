import type { Metadata } from 'next';
import Link from 'next/link';
import { ContentSection, FeatureCard, PageHero } from '@/components/marketing/shell';

export const metadata: Metadata = { title: 'Research', description: 'Scientific foundations, validation approach, and research limitations of TerraField Atlas.' };

export default function ResearchPage() {
  return (
    <>
      <PageHero kicker="Research · falsifiable by design" title="Scientific credibility is a workflow, not a label." description="TerraField Atlas records method versions, input variables, units, quality filters, missing-data treatment, validation strategy, and known limitations. Outputs are designed to be inspected and reproduced." />
      <ContentSection title="Research foundations">
        <div className="grid gap-4 md:grid-cols-2">
          <FeatureCard index="MK" title="Seasonal trend detection">Hirsch, Slack & Smith (1982); Hirsch & Slack (1984). Within-month Mann-Kendall statistics guard against seasonality manufacturing a trend.</FeatureCard>
          <FeatureCard index="TS" title="Robust slope estimation">Theil-Sen slope with Sen/Gilbert rank-based confidence intervals reduces sensitivity to outliers.</FeatureCard>
          <FeatureCard index="HR" title="Autocorrelation treatment">Hamed & Rao (1998) lag-1 variance inflation is applied conservatively when autocorrelation is detected. The seasonal adaptation is documented.</FeatureCard>
          <FeatureCard index="FDR" title="Multiple testing">Benjamini-Hochberg false-discovery-rate control is applied across variables analyzed in one request.</FeatureCard>
          <FeatureCard index="FAO" title="Agronomic ranges">FAO irrigation and crop guidance supplies documented water, duration, and compatibility ranges. Economics remains unassessed without approved price data.</FeatureCard>
          <FeatureCard index="VAL" title="Validation governance">AnalysisMethod and ValidationResult records separate benchmark data from production and require split strategies that avoid spatial or temporal leakage.</FeatureCard>
        </div>
      </ContentSection>
      <ContentSection title="What remains unvalidated">
        <ul className="grid gap-2 text-sm leading-relaxed text-dim md:grid-cols-2">
          <li>Farm-scale predictive yield models are not implemented.</li>
          <li>Quantitative NDVI and SMAP science arrays require separate credentials and QA workflows.</li>
          <li>Country-specific crop calendars need local expert review.</li>
          <li>Forecast products require held-out spatial/temporal validation and calibration evidence.</li>
          <li>Automated trend outputs do not establish causation.</li>
          <li>No independent certification of scientific accuracy is claimed.</li>
        </ul>
        <Link href="/data-methodology" className="mt-8 inline-flex min-h-11 items-center border border-edge px-5 font-mono text-xs uppercase tracking-wide-mc text-dim hover:text-ink">Read full data & methodology</Link>
      </ContentSection>
    </>
  );
}
