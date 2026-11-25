import type { Metadata } from 'next';
import Link from 'next/link';
import { ContentSection, FeatureCard, PageHero } from '@/components/marketing/shell';

export const metadata: Metadata = { title: 'Platform', description: 'The TerraField Atlas Earth-intelligence platform and its six connected product systems.' };

export default function PlatformPage() {
  return (
    <>
      <PageHero kicker="Platform · connected Earth intelligence" title="One evidence backbone. Six operational systems." description="TerraField Atlas connects satellite observations, climate records, soil context, agricultural knowledge, and institutional workflows so every decision can be traced, explained, and challenged." />
      <ContentSection title="The product systems">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <FeatureCard index="01" title="Earth Intelligence">Explore global geography, farm boundaries, satellite layers, historical observations, time series, raster statistics, and saved map views.</FeatureCard>
          <FeatureCard index="02" title="Agronomy">Manage farms, measured and modeled soil context, crop records, planting calendars, and explainable rotation scenarios.</FeatureCard>
          <FeatureCard index="03" title="Climate">Analyze rainfall, temperature, seasonal anomalies, drought indicators, and environmental trends with explicit uncertainty.</FeatureCard>
          <FeatureCard index="04" title="Sentinel">Monitor VIIRS thermal anomalies, fire frequency, archive coverage, and landscape events without calling a hotspot a confirmed fire.</FeatureCard>
          <FeatureCard index="05" title="Markets">A governed extension point for approved production and commodity-price feeds. No fabricated prices or harvest estimates.</FeatureCard>
          <FeatureCard index="06" title="Intelligence">Translate questions into validated analytical plans, execute permission-controlled tools, and retain evidence references and approval gates.</FeatureCard>
        </div>
      </ContentSection>
      <ContentSection title="Built for institutional reality">
        <div className="grid gap-4 md:grid-cols-3">
          <FeatureCard index="A" title="Secure boundaries">Verified accounts, organization memberships, role permissions, API-key scopes, and server-side tenant checks.</FeatureCard>
          <FeatureCard index="B" title="Scientific integrity">Versioned methods, source licenses, quality metadata, missing-data accounting, and reproducible analytical runs.</FeatureCard>
          <FeatureCard index="C" title="Commercial enforcement">Configurable plans, server-side quotas, successful-operation usage metering, signed webhooks, and a versioned developer API.</FeatureCard>
        </div>
        <div className="mt-8 flex flex-wrap gap-3"><Link href="/#view=dashboard" className="inline-flex min-h-11 items-center bg-nasa px-5 font-mono text-xs uppercase tracking-wide-mc text-white">Open the console</Link><Link href="/data-methodology" className="inline-flex min-h-11 items-center border border-edge px-5 font-mono text-xs uppercase tracking-wide-mc text-dim hover:text-ink">Read the methodology</Link></div>
      </ContentSection>
    </>
  );
}
