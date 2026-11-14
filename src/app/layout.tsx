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

/**
 * Site URL: explicit env wins; otherwise the deployment origin is built from
 * the known preview host pattern — never a fabricated domain in prod.
 */
const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') || 'https://terrafield-atlas.space');

const FAQ = [
  {
    q: 'What does TerraField Atlas do?',
    a: 'It is a mission console that turns real NASA Earth observations — POWER meteorology, GIBS MODIS/VIIRS layers, SMAP moisture, EONET events and the VIIRS fire-detection stream — into evidence-supported crop-rotation guidance and live, push-delivered fire intelligence for agricultural operators.',
  },
  {
    q: 'Is the data real or simulated?',
    a: 'Real. Every displayed observation is a stored NASA record attributed to its provider and retrieval. Missing data renders as no-data with a stated reason — never zero-filled and never imputed.',
  },
  {
    q: 'How are trends tested?',
    a: 'Seasonal Mann-Kendall (Hirsch-Slack) with tie-corrected variance, Theil-Sen seasonal slopes with Sen-rank 95% confidence intervals, Hamed-Rao autocorrelation correction, and Benjamini-Hochberg false-discovery-rate control across variables. At least 8 full years of record are required before any significance claim.',
  },
  {
    q: 'How does the fire intelligence work?',
    a: 'The console decodes the VIIRS 375 m thermal-anomaly stream — the same detections NASA FIRMS distributes — from NASA GIBS vector tiles, keeps a queryable detection ledger with a fire calendar, and evaluates regional watchlists on real scheduler cadences with cadence-aware digests.',
  },
  {
    q: 'How are digests delivered?',
    a: 'Every evaluation event pushes a cadence-aware digest over Server-Sent Events to open consoles, exits through an HMAC-SHA256-signed webhook (timestamped signature, replay window, SSRF guard), and — for scheduler facts — SMTP email. Every attempt is logged with status, latency and a correlation ID.',
  },
  {
    q: 'What are the limits?',
    a: 'No yield, harvest or profit prediction exists anywhere in the engine. Archive gaps are reported as gaps; confidence drops with missing inputs; economics are deliberately not assessed; and source reachability is shown live rather than claimed.',
  },
];

const JSON_LD = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      '@id': `${SITE_URL}/#org`,
      name: 'TerraField Atlas Team',
      url: SITE_URL,
      logo: `${SITE_URL}/icons/icon-512.png`,
    },
    {
      '@type': 'WebSite',
      '@id': `${SITE_URL}/#website`,
      url: SITE_URL,
      name: 'TerraField Atlas',
      publisher: { '@id': `${SITE_URL}/#org` },
      inLanguage: 'en',
    },
    {
      '@type': 'SoftwareApplication',
      name: 'TerraField Atlas',
      applicationCategory: 'ScienceApplication',
      operatingSystem: 'Web',
      url: SITE_URL,
      image: `${SITE_URL}/og-image.png`,
      description:
        'Mission console for evidence-supported crop-rotation planning and live fire intelligence built on NASA POWER, GIBS MODIS/VIIRS and SMAP observations, with statistical trend detection, full data provenance and push-delivered digests.',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      featureList: [
        '12+ years of daily NASA POWER meteorology for any coordinate',
        'Seasonal Mann-Kendall trend detection with FDR control',
        'VIIRS 375 m fire-detection stream from NASA GIBS vector tiles',
        'Regional fire watchlists on real scheduler cadences',
        'Cadence-aware digests pushed via SSE, signed webhook and email',
        'Full data provenance for every retrieval',
      ],
    },
    {
      '@type': 'FAQPage',
      mainEntity: FAQ.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    },
  ],
};

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'TerraField Atlas — NASA Earth Intelligence for Agricultural Resilience',
    template: '%s · TerraField Atlas',
  },
  description:
    'Mission console for evidence-supported crop-rotation planning and live fire intelligence built on NASA POWER, GIBS MODIS/VIIRS and SMAP observations — statistical trend detection, VIIRS fire watchlists on real cadences, push-delivered digests, full data provenance. NASA Space Apps Challenge 2026 — Field Shift.',
  keywords: [
    'NASA', 'Space Apps 2026', 'Earth observation', 'agriculture', 'crop rotation', 'NASA POWER', 'GIBS',
    'SMAP', 'VIIRS', 'FIRMS', 'fire intelligence', 'thermal anomalies', 'Mann-Kendall', 'food security',
    'remote sensing', 'EO', 'agritech', 'wildfire alerts', 'data provenance', 'AEO', 'llms.txt',
  ],
  authors: [{ name: 'TerraField Atlas Team' }],
  creator: 'TerraField Atlas Team',
  publisher: 'TerraField Atlas Team',
  category: 'science',
  applicationName: 'TerraField Atlas',
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    url: SITE_URL,
    siteName: 'TerraField Atlas',
    title: 'TerraField Atlas — NASA Earth Intelligence for Agricultural Resilience',
    description:
      'Real NASA Earth observations, honest statistics, live fire intelligence and push-delivered digests — with full provenance for every retrieval. NASA Space Apps Challenge 2026.',
    locale: 'en_US',
    images: [{ url: '/og-image.png', width: 1200, height: 630, alt: 'TerraField Atlas — NASA Earth intelligence for agricultural resilience' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'TerraField Atlas — NASA Earth Intelligence for Agricultural Resilience',
    description: 'Real data · honest gaps · push-delivered fire intelligence · full provenance. NASA Space Apps Challenge 2026 — Field Shift.',
    images: ['/og-image.png'],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
      'max-video-preview': -1,
    },
  },
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '48x48' },
      { url: '/icons/icon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    shortcut: ['/favicon.ico'],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'TerraField',
  },
  formatDetection: { telephone: false, address: false, email: false },
  other: {
    // GEO metadata — the demo operations area (Central Province, Zambia),
    // matching the seeded demo watchlist; global coverage otherwise.
    'geo.region': 'ZM-02',
    'geo.placename': 'Central Province, Zambia (demo operations area — global coverage)',
    'geo.position': '-14.3;28.1',
    ICBM: '-14.3, 28.1',
    'llms-txt': '/llms.txt',
  },
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
        {/* Structured data for search + answer engines (AEO): Organization,
            WebSite, SoftwareApplication and the mission FAQ. */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
        />
      </body>
    </html>
  );
}
