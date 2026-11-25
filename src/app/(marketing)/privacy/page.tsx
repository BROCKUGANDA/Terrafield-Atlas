import type { Metadata } from 'next';
import { ContentSection, PageHero } from '@/components/marketing/shell';

export const metadata: Metadata = { title: 'Privacy', description: 'How TerraField Atlas handles account, farm, observation, and operational data.' };

export default function PrivacyPage() {
  return (
    <>
      <PageHero kicker="Privacy · data stewardship" title="Privacy overview" description="This overview explains the categories of data TerraField Atlas processes and the controls built into the product. It is not a substitute for a deployment-specific data-processing agreement." />
      <ContentSection title="Data we process">
        <div className="grid gap-4 text-sm leading-relaxed text-dim md:grid-cols-2">
          <section className="hud hud-calm p-4"><h3 className="font-display text-base font-bold text-ink">Account data</h3><p className="mt-2">Email address, optional name, password hash, verification state, organization memberships, and session metadata. Passwords are salted and hashed; plaintext passwords are not stored.</p></section>
          <section className="hud hud-calm p-4"><h3 className="font-display text-base font-bold text-ink">Farm & workspace data</h3><p className="mt-2">Farm names, boundaries, coordinates, soil tests, crop history, notes, workspaces, and reports that you choose to store.</p></section>
          <section className="hud hud-calm p-4"><h3 className="font-display text-base font-bold text-ink">Observation & usage data</h3><p className="mt-2">Public satellite and environmental observations, retrieval provenance, processing jobs, API usage, and audit events. Private provider responses are not written to shared caches or public provenance logs.</p></section>
          <section className="hud hud-calm p-4"><h3 className="font-display text-base font-bold text-ink">Local preferences</h3><p className="mt-2">Non-secret interface preferences and selected workspace may remain in browser local storage. Authentication relies on secure HttpOnly cookies, not local tokens.</p></section>
        </div>
      </ContentSection>
      <ContentSection title="How data is protected">
        <ul className="grid gap-2 text-sm leading-relaxed text-dim md:grid-cols-2">
          <li>Server-side authentication, organization membership checks, and role permissions.</li>
          <li>Tenant-scoped database queries and explicit cross-tenant tests.</li>
          <li>API keys stored as SHA-256 hashes and shown only once.</li>
          <li>Webhook signing secrets encrypted at rest and never returned after creation.</li>
          <li>Strict request validation, size limits, rate limits, and audit trails.</li>
          <li>Public demo records are readable; verified writes are owner/membership controlled.</li>
        </ul>
      </ContentSection>
      <ContentSection title="Retention, sharing, and your choices">
        <p className="max-w-4xl text-sm leading-relaxed text-dim">Retention depends on the deployment and organization policy. Public Earth-observation data retains its provider license and attribution. TerraField Atlas does not sell farm or account data. Data may be processed by configured infrastructure, email, or integration providers to deliver the service; production deployments must document those providers and regions.</p>
        <p className="mt-4 max-w-4xl text-sm leading-relaxed text-dim">Account deletion, organization offboarding, export, and retention controls require deployment-specific procedures. Contact <a className="text-aqua underline" href="mailto:contact@terrafieldatlas.us">contact@terrafieldatlas.us</a> to request assistance. Do not send passwords, API keys, or sensitive farm records in ordinary email.</p>
      </ContentSection>
      <ContentSection title="Cookies and public data">
        <p className="max-w-4xl text-sm leading-relaxed text-dim">Essential session cookies keep verified users signed in. The public demo may store non-secret interface preferences locally. Marketing pages do not require an account. Public source metadata and observations are governed by their respective provider licenses.</p>
      </ContentSection>
    </>
  );
}
