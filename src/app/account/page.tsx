import type { Metadata } from 'next';
import Link from 'next/link';
import { AccountForm } from '@/components/account-form';

export const metadata: Metadata = {
  title: 'Private account', description: 'Sign in to a TerraField Atlas account or continue with the shared public demo.',
  robots: { index: false, follow: false },
};

export default function AccountPage() {
  return (
    <main className="mx-auto grid max-w-5xl gap-10 px-5 py-12 md:grid-cols-[1fr_1.2fr] md:gap-16 sm:px-8">
      <section>
        <p className="font-mono text-xs uppercase tracking-[0.25em] text-muted-foreground">TerraField Atlas / Account access</p>
        <h1 className="mt-5 text-4xl font-semibold leading-tight sm:text-5xl">Your evidence.<br />Your workspace.</h1>
        <p className="mt-6 leading-relaxed text-muted-foreground">A verified account is separate from the public demo callsign. Account-owned farms and watchlists are checked on the server, not protected by a browser label.</p>
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">Private accounts support farm records, POWER ingestion, historical analysis, soil tests, rotation scenarios and reports. Private watchlists support evaluation, backtesting, scheduling and owner-only live digests. Shared email and webhook destinations never receive private alerts. Provider availability and archive coverage still apply.</p>
        <Link href="/" className="mt-8 inline-flex min-h-11 items-center underline underline-offset-4">Continue with the shared public demo →</Link>
      </section>
      <AccountForm />
    </main>
  );
}