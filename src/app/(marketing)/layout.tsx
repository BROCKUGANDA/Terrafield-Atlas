import type { Metadata } from 'next';
import { MarketingPage } from '@/components/marketing/shell';

export const metadata: Metadata = {
  title: { default: 'TerraField Atlas — Earth Intelligence for Agriculture', template: '%s — TerraField Atlas' },
  description: 'Explainable Earth intelligence for agriculture, environmental monitoring, and institutional planning.',
};

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return <MarketingPage>{children}</MarketingPage>;
}
