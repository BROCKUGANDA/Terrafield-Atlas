import type { Metadata } from 'next';
import { ContentSection, PageHero } from '@/components/marketing/shell';

export const metadata: Metadata = { title: 'Terms', description: 'Terms of use and scientific limitations for TerraField Atlas.' };

export default function TermsPage() {
  return (
    <>
      <PageHero kicker="Terms · acceptable use" title="Terms of use" description="These terms describe use of the TerraField Atlas product and its public demonstrations. Institutional deployments may be subject to separate service agreements." />
      <ContentSection title="Use of the service">
        <div className="grid gap-4 text-sm leading-relaxed text-dim md:grid-cols-2">
          <section className="hud hud-calm p-4"><h3 className="font-display text-base font-bold text-ink">Accounts & organizations</h3><p className="mt-2">You are responsible for activity under your account and API keys. Keep credentials secure, use least-privilege scopes, revoke unused keys, and invite only authorized organization members.</p></section>
          <section className="hud hud-calm p-4"><h3 className="font-display text-base font-bold text-ink">Acceptable use</h3><p className="mt-2">Do not attempt to bypass tenant isolation, rate limits, or quotas; probe private infrastructure; ingest malicious files; or use the service to violate applicable law or third-party data rights.</p></section>
          <section className="hud hud-calm p-4"><h3 className="font-display text-base font-bold text-ink">Plans & usage</h3><p className="mt-2">Entitlements are enforced server-side. Usage metrics describe successfully fulfilled operations. Plan changes and cancellation state do not themselves process payment unless a reviewed provider integration is active.</p></section>
          <section className="hud hud-calm p-4"><h3 className="font-display text-base font-bold text-ink">Integrations</h3><p className="mt-2">You are responsible for the security and availability of endpoints you register. Signed webhooks must be verified over exact request bytes, and replay protection should be implemented.</p></section>
        </div>
      </ContentSection>
      <ContentSection title="Scientific and operational limitations">
        <ul className="grid gap-2 text-sm leading-relaxed text-dim md:grid-cols-2">
          <li>Satellite and reanalysis products have resolution, latency, cloud, archive, and model limitations.</li>
          <li>Thermal anomalies are not confirmed fires.</li>
          <li>Environmental association does not establish agricultural causation.</li>
          <li>The platform does not guarantee yields, profits, or emergency warning performance.</li>
          <li>Human decision authority remains essential for consequential agricultural and financial actions.</li>
          <li>Provider availability and data licensing can change and are surfaced explicitly.</li>
        </ul>
      </ContentSection>
      <ContentSection title="Intellectual property & attribution">
        <p className="max-w-4xl text-sm leading-relaxed text-dim">TerraField Atlas software, branding, and original analytical methods remain the property of their respective owners. Third-party datasets retain their provider licenses and attribution requirements. No NASA endorsement or partnership is claimed. Users are responsible for reviewing commercial-use conditions before redistributing data or derived products.</p>
      </ContentSection>
      <ContentSection title="Service changes & contact">
        <p className="max-w-4xl text-sm leading-relaxed text-dim">Features, limits, providers, and availability may change. Material changes to a deployment should be communicated by its operator. Questions about these terms can be sent to <a className="text-aqua underline" href="mailto:contact@terrafieldatlas.us">contact@terrafieldatlas.us</a>.</p>
      </ContentSection>
    </>
  );
}
