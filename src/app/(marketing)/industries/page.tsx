import type { Metadata } from 'next';
import { ContentSection, FeatureCard, PageHero } from '@/components/marketing/shell';

export const metadata: Metadata = { title: 'Industries', description: 'Agricultural, environmental, public-sector, and research applications of TerraField Atlas.' };

export default function IndustriesPage() {
  return (
    <>
      <PageHero kicker="Industries · Earth intelligence in context" title="Designed for decisions that depend on place and time." description="TerraField Atlas begins with agricultural institutions in Uganda and East Africa, while its data contracts, tenancy model, and provider adapters support global expansion." />
      <ContentSection title="Where the platform is applied">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <FeatureCard index="01" title="Agricultural cooperatives">Portfolio monitoring, shared farm records, extension workflows, seasonal planning, and evidence-rich member reports.</FeatureCard>
          <FeatureCard index="02" title="Agribusiness & consultancies">Repeatable farm assessments, scenario comparison, team permissions, API access, and auditable exports.</FeatureCard>
          <FeatureCard index="03" title="Government & development">Regional climate exposure, environmental event monitoring, programme portfolios, and institutional reporting.</FeatureCard>
          <FeatureCard index="04" title="Environmental management">Fire-frequency context, land-cover change readiness, anomaly investigation, and source-governed event data.</FeatureCard>
          <FeatureCard index="05" title="Research & academia">Reproducible methods, validation records, dataset provenance, and explicit treatment of uncertainty and leakage.</FeatureCard>
          <FeatureCard index="06" title="Insurance & resilience finance">Exposure indicators and evidence packages—without unsupported loss, yield, or profit predictions.</FeatureCard>
        </div>
      </ContentSection>
      <ContentSection title="Expansion principles">
        <p className="max-w-4xl text-sm leading-relaxed text-dim">New countries and crops require reviewed agricultural rules, local language support, national meteorological integrations, and licensing checks. The architecture supports that expansion; the platform does not claim local agronomic validation that has not been performed.</p>
      </ContentSection>
    </>
  );
}
