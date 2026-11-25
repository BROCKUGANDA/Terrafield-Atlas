import type { Metadata } from 'next';
import Link from 'next/link';
import { ContentSection, FeatureCard, PageHero } from '@/components/marketing/shell';

export const metadata: Metadata = { title: 'Contact', description: 'Contact TerraField Atlas for demonstrations, institutional deployments, research, and API integration.' };

export default function ContactPage() {
  const subject = encodeURIComponent('TerraField Atlas enquiry');
  const body = encodeURIComponent('Organization:\nUse case:\nCountry / region:\nExpected farms or users:\nTimeline:');
  return (
    <>
      <PageHero kicker="Contact · start a governed conversation" title="Tell us what decision you need to support." description="For cooperative pilots, institutional deployments, research collaboration, data licensing, or API integration, contact the team with your geography, users, and workflow." />
      <ContentSection title="Get in touch">
        <div className="grid gap-4 md:grid-cols-2">
          <FeatureCard index="01" title="Commercial & institutional"><a className="text-aqua underline" href={`mailto:contact@terrafieldatlas.us?subject=${subject}&body=${body}`}>Email the team</a><p className="mt-2">Include your organization, country, portfolio size, and the decision workflow you want to improve.</p></FeatureCard>
          <FeatureCard index="02" title="Product demonstration"><Link className="text-aqua underline" href="/#view=dashboard">Open the live console</Link><p className="mt-2">Explore real source coverage, create a verified account, and test the Earth Intelligence workflow.</p></FeatureCard>
          <FeatureCard index="03" title="Research & methodology"><Link className="text-aqua underline" href="/research">Review the research foundations</Link><p className="mt-2">Use the methodology and limitations pages to assess scientific fit before a pilot.</p></FeatureCard>
          <FeatureCard index="04" title="Security & procurement"><Link className="text-aqua underline" href="/privacy">Read the privacy overview</Link><p className="mt-2">Request the security overview, source/licensing register, and deployment documentation for evaluation.</p></FeatureCard>
        </div>
      </ContentSection>
      <ContentSection title="Before a pilot">
        <p className="max-w-4xl text-sm leading-relaxed text-dim">Confirm the target country, crops, data residency expectations, user roles, required integrations, and whether quantitative satellite science products are needed. Credentials and commercial data licenses must be reviewed before those products are represented as operational.</p>
      </ContentSection>
    </>
  );
}
