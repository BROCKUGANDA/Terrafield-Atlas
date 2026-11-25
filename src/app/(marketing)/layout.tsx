import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { MarketingPage } from '@/components/marketing/shell';
import { resolveLocale } from '@/lib/i18n';

export const metadata: Metadata = {
  title: { default: 'TerraField Atlas — Earth Intelligence for Agriculture', template: '%s — TerraField Atlas' },
  description: 'Explainable Earth intelligence for agriculture, environmental monitoring, and institutional planning.',
};

export default async function MarketingLayout({ children }: { children: React.ReactNode }) {
  const locale = resolveLocale(await cookies());
  return <MarketingPage locale={locale}>{children}</MarketingPage>;
}
