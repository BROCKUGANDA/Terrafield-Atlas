import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { AccountForm } from '@/components/account-form';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { resolveLocale, t } from '@/lib/i18n';

export const metadata: Metadata = {
  title: 'Private account', description: 'Sign in to a TerraField Atlas account or continue with the shared public demo.',
  robots: { index: false, follow: false },
};

type AccountPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AccountPage({ searchParams }: AccountPageProps) {
  const [cookieStore, params] = await Promise.all([cookies(), searchParams ?? Promise.resolve({})]);
  // Explicit `?lang=sw` wins over the persisted cookie; see resolveLocale.
  const locale = resolveLocale(cookieStore, params);
  return (
    <main className="mx-auto grid max-w-5xl gap-10 px-5 py-12 md:grid-cols-[1fr_1.2fr] md:gap-16 sm:px-8">
      <section>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="font-mono text-xs uppercase tracking-[0.25em] text-muted-foreground">{t(locale, 'account.kicker')}</p>
          <LocaleSwitcher locale={locale} />
        </div>
        <h1 className="mt-5 text-4xl font-semibold leading-tight sm:text-5xl">{t(locale, 'account.titleLine1')}<br />{t(locale, 'account.titleLine2')}</h1>
        <p className="mt-6 leading-relaxed text-muted-foreground">{t(locale, 'account.intro')}</p>
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{t(locale, 'account.detail')}</p>
        <Link href="/" className="mt-8 inline-flex min-h-11 items-center underline underline-offset-4">{t(locale, 'account.continueDemo')} →</Link>
      </section>
      <AccountForm />
    </main>
  );
}
