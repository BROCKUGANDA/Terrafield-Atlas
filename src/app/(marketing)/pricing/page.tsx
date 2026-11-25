import type { Metadata } from 'next';
import Link from 'next/link';
import { ContentSection, FeatureCard, PageHero } from '@/components/marketing/shell';

export const metadata: Metadata = { title: 'Pricing', description: 'Configurable TerraField Atlas plans for individuals, cooperatives, enterprises, and institutions.' };

export default function PricingPage() {
  return (
    <>
      <PageHero kicker="Pricing · configurable by workspace" title="Start with evidence. Scale with governance." description="Plans, prices, and quotas are database configuration. The console shows the current entitlements for your personal or organization workspace; no payment provider is assumed or faked." />
      <ContentSection title="Plan architecture">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <FeatureCard index="01" title="Explorer">Free entry tier for geographic exploration and limited personal farm, analysis, and report workflows.</FeatureCard>
          <FeatureCard index="02" title="Professional">For individual agricultural professionals and consultants, with higher quotas and developer API access.</FeatureCard>
          <FeatureCard index="03" title="Cooperative">For multi-farm teams: organization workspaces, invitations, shared portfolios, webhooks, and higher operational limits.</FeatureCard>
          <FeatureCard index="04" title="Enterprise">Advanced analytics, organization controls, reporting, APIs, and configurable high-volume entitlements.</FeatureCard>
          <FeatureCard index="05" title="Institutional">Custom government, NGO, research, and programme deployments with negotiated integrations and service terms.</FeatureCard>
          <FeatureCard index="06" title="Billing integrity">Usage is recorded after successful fulfillment. Failed or cancelled operations are not billed. Subscription state is provider-neutral.</FeatureCard>
        </div>
      </ContentSection>
      <ContentSection title="Commercial readiness">
        <div className="grid gap-4 md:grid-cols-3">
          <FeatureCard index="A" title="Transparent usage">Farm counts, processing jobs, API requests, reports, intelligence runs, and storage are visible against configured quotas.</FeatureCard>
          <FeatureCard index="B" title="Replaceable payments">Payment-provider fields are ready for a reviewed integration appropriate to the target market. No checkout is represented as live before that review.</FeatureCard>
          <FeatureCard index="C" title="Institutional procurement">Security overview, source/licensing register, methodology, known limitations, and deployment documentation support evaluation.</FeatureCard>
        </div>
        <div className="mt-8 flex flex-wrap gap-3"><Link href="/#view=billing" className="inline-flex min-h-11 items-center bg-nasa px-5 font-mono text-xs uppercase tracking-wide-mc text-white">View current plans & usage</Link><Link href="/contact" className="inline-flex min-h-11 items-center border border-edge px-5 font-mono text-xs uppercase tracking-wide-mc text-dim hover:text-ink">Discuss institutional deployment</Link></div>
      </ContentSection>
    </>
  );
}
