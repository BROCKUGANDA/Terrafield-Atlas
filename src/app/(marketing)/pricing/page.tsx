import type { Metadata } from 'next';
import Link from 'next/link';
import { ContentSection, FeatureCard, PageHero } from '@/components/marketing/shell';

export const metadata: Metadata = { title: 'Pricing', description: 'Configurable TerraField Atlas plans for individuals, cooperatives, enterprises, and institutions.' };

export default function PricingPage() {
  return (
    <>
      <PageHero kicker="Pricing · configurable by workspace" title="Free to use. Support if you can." description="Every product capability — exploration, farms, analyses, organizations, API keys, webhooks and reports — is available without payment. Plans differ only in cost-bearing compute quotas (jobs, AI runs, storage). Onchain support is voluntary and never unlocks or locks a feature." />
      <ContentSection title="Plan architecture">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <FeatureCard index="01" title="Explorer">Free core: exploration, farms, analyses, organization workspaces, API access, webhooks and reports; modest compute quotas keep provider costs bounded.</FeatureCard>
          <FeatureCard index="02" title="Professional">For individual professionals and consultants who need higher processing, AI and storage quotas. No feature is withheld.</FeatureCard>
          <FeatureCard index="03" title="Cooperative">For multi-farm teams that need higher compute limits; organization workspaces, invitations, shared portfolios and webhooks are already free.</FeatureCard>
          <FeatureCard index="04" title="Enterprise">High-volume compute for large portfolios; governance and API features remain available on every tier.</FeatureCard>
          <FeatureCard index="05" title="Institutional">Custom government, NGO, research, and programme deployments with negotiated integrations and service terms.</FeatureCard>
          <FeatureCard index="06" title="Support, not paywall">Onchain support payments (USDC or native currency) are voluntary. They do not change entitlements; compute quotas exist only where a provider charges us. Failed operations are never metered.</FeatureCard>
        </div>
      </ContentSection>
      <ContentSection title="Commercial readiness">
        <div className="grid gap-4 md:grid-cols-3">
          <FeatureCard index="A" title="Transparent usage">Farm counts, processing jobs, API requests, reports, intelligence runs, and storage are visible against configured quotas.</FeatureCard>
          <FeatureCard index="B" title="Onchain support">Support is settled onchain through an OpenZeppelin-based receiver contract and verified server-side; no card data, custody or fiat processor is involved.</FeatureCard>
          <FeatureCard index="C" title="Institutional procurement">Security overview, source/licensing register, methodology, known limitations, and deployment documentation support evaluation.</FeatureCard>
        </div>
        <div className="mt-8 flex flex-wrap gap-3"><Link href="/#view=billing" className="inline-flex min-h-11 items-center bg-nasa px-5 font-mono text-xs uppercase tracking-wide-mc text-white">View current plans & usage</Link><Link href="/contact" className="inline-flex min-h-11 items-center border border-edge px-5 font-mono text-xs uppercase tracking-wide-mc text-dim hover:text-ink">Discuss institutional deployment</Link></div>
      </ContentSection>
    </>
  );
}
