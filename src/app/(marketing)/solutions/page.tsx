import type { Metadata } from 'next';
import Link from 'next/link';
import { ContentSection, FeatureCard, PageHero } from '@/components/marketing/shell';

export const metadata: Metadata = { title: 'Solutions', description: 'TerraField Atlas workflows for farmers, cooperatives, agribusinesses, researchers, and public institutions.' };

export default function SolutionsPage() {
  return (
    <>
      <PageHero kicker="Solutions · from field to institution" title="Different users. One operational evidence chain." description="A field officer records conditions, an agronomist compares options, a cooperative monitors its portfolio, and an institution exports an auditable report—all from the same governed observations." />
      <ContentSection title="Role-specific workflows">
        <div className="grid gap-4 md:grid-cols-2">
          <FeatureCard index="01" title="Individual farmers & consultants">Create a verified account, register a farm boundary, inspect climate coverage, add measured soil results, and compare rotation alternatives with missing inputs made explicit.</FeatureCard>
          <FeatureCard index="02" title="Agricultural cooperatives">Create an organization, invite extension staff, group farms into workspaces, monitor environmental exposure, and share reports inside a secure tenant boundary.</FeatureCard>
          <FeatureCard index="03" title="Agribusinesses">Manage multi-farm portfolios, standardize crop and soil records, run reproducible analyses, and deliver signed events to existing operational systems.</FeatureCard>
          <FeatureCard index="04" title="Research institutions">Inspect source versions, quality filters, statistical methods, validation records, and provenance before using an output in research.</FeatureCard>
          <FeatureCard index="05" title="Government & development programmes">Monitor regional climate and fire exposure, compare districts, manage teams, and produce evidence-rich reports without overstating precision.</FeatureCard>
          <FeatureCard index="06" title="Developers & integrators">Use scoped API keys, paginated resources, correlation IDs, plan quotas, OpenAPI documentation, and signed webhooks.</FeatureCard>
        </div>
      </ContentSection>
      <ContentSection title="First-value path">
        <ol className="grid gap-3 md:grid-cols-4">
          {['Create a verified account or organization', 'Add farms and geographic boundaries', 'Inspect environmental data coverage', 'Run an approved analysis and export evidence'].map((step, index) => <li key={step} className="hud hud-calm p-4"><span className="telemetry text-nasa">0{index + 1}</span><p className="mt-2 text-sm text-ink">{step}</p></li>)}
        </ol>
        <Link href="/#view=organizations" className="mt-8 inline-flex min-h-11 items-center border border-aqua/50 px-5 font-mono text-xs uppercase tracking-wide-mc text-aqua">Open organization workspace</Link>
      </ContentSection>
    </>
  );
}
