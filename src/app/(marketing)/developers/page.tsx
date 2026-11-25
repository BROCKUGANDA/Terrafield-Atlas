import type { Metadata } from 'next';
import Link from 'next/link';
import { ContentSection, FeatureCard, PageHero } from '@/components/marketing/shell';

export const metadata: Metadata = { title: 'Developer API', description: 'Versioned, scoped TerraField Atlas API for farms, observations, analyses, reports, and sources.' };

const example = `curl https://terrafieldatlas.us/api/v1/developer/farms \\
  -H "Authorization: Bearer tf_live_..." \\
  -H "Accept: application/json"`;

export default function ApiPage() {
  return (
    <>
      <PageHero kicker="Developer platform · versioned contracts" title="Bring Earth intelligence into your own workflow." description="Use scoped API keys to read authorized farms, stored observations, trend analyses, persisted reports, and the governed source register. Every response carries a correlation ID; quotas and rate limits are enforced server-side." />
      <ContentSection title="Core resources">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <FeatureCard index="GET" title="/developer/farms">Cursor-paginated farms in the API key’s tenant scope. Requires farms.read.</FeatureCard>
          <FeatureCard index="GET" title="/developer/observations">Real stored observations with source, version, unit, date, and retrieval time. Requires observations.read.</FeatureCard>
          <FeatureCard index="GET" title="/developer/analyses">Authorized trend analyses with structured results. Requires analyses.read.</FeatureCard>
          <FeatureCard index="GET" title="/developer/reports">Persisted report records and provenance. Requires reports.read.</FeatureCard>
          <FeatureCard index="GET" title="/developer/sources">The governed data-source register. Requires sources.read.</FeatureCard>
          <FeatureCard index="POST" title="Signed webhooks">Organization events delivered from the transactional outbox with HMAC-SHA256 signatures and durable retries.</FeatureCard>
        </div>
      </ContentSection>
      <ContentSection title="Quick start">
        <ol className="grid gap-3 text-sm text-dim md:grid-cols-3">
          <li className="hud hud-calm p-4"><span className="telemetry text-nasa">01</span><p className="mt-2">Sign in and open Plans & Usage.</p></li>
          <li className="hud hud-calm p-4"><span className="telemetry text-nasa">02</span><p className="mt-2">Create an API key with only the scopes you need. The secret is shown once.</p></li>
          <li className="hud hud-calm p-4"><span className="telemetry text-nasa">03</span><p className="mt-2">Call the versioned endpoint and retain the X-Correlation-Id for support.</p></li>
        </ol>
        <pre className="mt-6 overflow-x-auto rounded-sm border border-edge bg-sidebar p-4"><code className="font-mono text-xs leading-relaxed text-aqua">{example}</code></pre>
        <div className="mt-6 flex flex-wrap gap-3"><Link href="/api/v1/openapi.json" className="inline-flex min-h-11 items-center border border-aqua/50 px-5 font-mono text-xs uppercase tracking-wide-mc text-aqua">OpenAPI 3.1</Link><Link href="/#view=billing" className="inline-flex min-h-11 items-center bg-nasa px-5 font-mono text-xs uppercase tracking-wide-mc text-white">Manage API keys</Link></div>
      </ContentSection>
      <ContentSection title="Integration guarantees">
        <p className="max-w-4xl text-sm leading-relaxed text-dim">Keys are hashed at rest, revocable, optionally expiring, and bound to a personal or organization tenant. Read scopes are explicit. Rate limits and plan quotas return stable error codes. Webhook URLs reject private and metadata targets, redirects are not followed, and delivery attempts are durable.</p>
      </ContentSection>
    </>
  );
}
