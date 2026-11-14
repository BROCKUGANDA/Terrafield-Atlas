import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { Toaster } from '@/components/ui/toaster';
import { Providers } from '@/components/providers';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'TerraField Atlas — NASA Earth Intelligence for Agricultural Resilience',
  description:
    'Evidence-supported crop-rotation planning built on NASA POWER, GIBS MODIS/VIIRS and SMAP observations, with statistical trend detection and full data provenance. NASA Space Apps Challenge 2026 — Field Shift.',
  keywords: ['NASA', 'Space Apps', 'Earth observation', 'agriculture', 'crop rotation', 'POWER', 'GIBS', 'SMAP', 'VIIRS'],
  authors: [{ name: 'TerraField Atlas Team' }],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}>
        <Providers>{children}</Providers>
        <Toaster />
      </body>
    </html>
  );
}
