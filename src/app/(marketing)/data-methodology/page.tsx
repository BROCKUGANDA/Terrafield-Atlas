import type { Metadata } from 'next';
import Link from 'next/link';
import { ContentSection, FeatureCard, PageHero } from '@/components/marketing/shell';

export const metadata: Metadata = { title: 'Data & methodology', description: 'Sources, scientific methods, provenance, licensing, and limitations for TerraField Atlas.' };

export default function DataMethodologyPage() {
  return (
    <>
      <PageHero kicker="Data & methodology · evidence contract" title="Every number has a source. Every result has limits." description="The platform separates observations, historical estimates, modeled scenarios, and user-entered data. It never silently imputes missing observations or presents environmental association as agricultural causation." />
      <ContentSection title="Integrated sources">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <FeatureCard index="NASA" title="POWER">Daily MERRA-2 meteorology on a 0.5° × 0.625° grid with local solar time day boundaries. Reanalysis, not farm microclimate.</FeatureCard>
          <FeatureCard index="NASA" title="GIBS">MODIS/VIIRS imagery, MOD13Q1 NDVI renders, SMAP L4 moisture renders, and VIIRS 375 m thermal-anomaly vectors.</FeatureCard>
          <FeatureCard index="NASA" title="EONET & FIRMS">Event-level natural-event context and an authenticated fire-data adapter. Availability and credentials are reported honestly.</FeatureCard>
          <FeatureCard index="ISRIC" title="SoilGrids 2.0">Modeled global soil properties under CC BY 4.0. Always labeled as modeled and never substituted for laboratory measurements.</FeatureCard>
          <FeatureCard index="NASA" title="MAAP STAC">Bounded STAC item discovery with asset metadata and optional accessibility probes. Discovery does not grant data rights.</FeatureCard>
          <FeatureCard index="FAO" title="Agronomic knowledge">Versioned crop characteristics with citations for water requirements, soil compatibility, duration, and rotation rationale.</FeatureCard>
        </div>
      </ContentSection>
      <ContentSection title="Statistical and agronomic methods">
        <div className="grid gap-4 md:grid-cols-2">
          <FeatureCard index="01" title="Trend detection">Monthly aggregation with minimum valid-day rules, seasonal Mann-Kendall, Theil-Sen slope, Sen confidence interval, Hamed-Rao autocorrelation adjustment, and Benjamini-Hochberg FDR.</FeatureCard>
          <FeatureCard index="02" title="Rotation comparison">Deterministic factor scoring for family sequence, nitrogen contribution, water, thermal feasibility, nutrients, diversity, soil, and staple presence. Missing inputs reduce confidence rather than becoming zero.</FeatureCard>
          <FeatureCard index="03" title="Fire intelligence">Coverage-aware counts from real VIIRS detections. Archive gaps are no-data, not zero. Hotspots are thermal anomalies, not confirmed fires.</FeatureCard>
          <FeatureCard index="04" title="Provenance & reproducibility">Source product versions, retrieval timestamps, processing history, method versions, configuration, and evidence references are retained with significant outputs.</FeatureCard>
        </div>
      </ContentSection>
      <ContentSection title="Known limits">
        <ul className="grid gap-2 text-sm leading-relaxed text-dim md:grid-cols-2">
          <li>POWER is regional reanalysis; it does not resolve farm-scale microclimate.</li>
          <li>NDVI and SMAP map layers are visualizations unless quantitative science files are configured.</li>
          <li>VIIRS misses short-lived or cloud-obscured fires and has archive gaps.</li>
          <li>SoilGrids is modeled and intermittently unavailable.</li>
          <li>The platform does not predict yield or profit.</li>
          <li>Market intelligence remains disabled until approved feeds are integrated.</li>
          <li>Forecasts require validation metrics and are not presented as observations.</li>
          <li>No scientific certification, regulatory approval, or NASA endorsement is claimed.</li>
        </ul>
        <Link href="/#view=sources" className="mt-8 inline-flex min-h-11 items-center border border-edge px-5 font-mono text-xs uppercase tracking-wide-mc text-dim hover:text-ink">Open the data catalogue</Link>
      </ContentSection>
    </>
  );
}
