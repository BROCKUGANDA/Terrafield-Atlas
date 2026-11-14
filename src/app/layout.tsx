import type { Metadata, Viewport } from 'next';
import { Space_Grotesk, Archivo, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';
import { Toaster } from '@/components/ui/toaster';
import { Providers } from '@/components/providers';

/**
 * Mission-console typography:
 *  - Space Grotesk  → display / headings / kickers (aerospace grotesque)
 *  - Archivo        → body copy (neutral, editorial)
 *  - IBM Plex Mono  → telemetry, coordinates, every numeral readout
 */
const spaceGrotesk = Space_Grotesk({
  variable: '--font-space-grotesk',
  subsets: ['latin'],
});

const archivo = Archivo({
  variable: '--font-archivo',
  subsets: ['latin'],
});

const plexMono = IBM_Plex_Mono({
  variable: '--font-plex-mono',
  weight: ['400', '500', '600'],
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'TerraField Atlas — NASA Earth Intelligence for Agricultural Resilience',
  description:
    'Mission console for evidence-supported crop-rotation planning built on NASA POWER, GIBS MODIS/VIIRS and SMAP observations, with statistical trend detection and full data provenance. NASA Space Apps Challenge 2026 — Field Shift.',
  keywords: ['NASA', 'Space Apps', 'Earth observation', 'agriculture', 'crop rotation', 'POWER', 'GIBS', 'SMAP', 'VIIRS'],
  authors: [{ name: 'TerraField Atlas Team' }],
};

export const viewport: Viewport = {
  themeColor: '#050914',
  colorScheme: 'dark',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${spaceGrotesk.variable} ${archivo.variable} ${plexMono.variable} font-sans antialiased bg-background text-foreground`}
      >
        <Providers>{children}</Providers>
        <Toaster />
      </body>
    </html>
  );
}
