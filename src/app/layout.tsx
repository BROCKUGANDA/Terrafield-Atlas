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
const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') || 'https://terrafieldatlas.us');

const FAQ = [
  {
    q: 'What does TerraField Atlas do?',
    a: 'It is a mission console for NASA POWER meteorology, GIBS imagery and thermal anomalies, EONET event context, crop-rotation comparisons and fire watchlists. Quantitative SMAP/MODIS science ingestion requires separately configured Earthdata access.',
  },
  {
    q: 'Is the data real or simulated?',
    a: 'Environmental observations are source-attributed provider records. Recent FIRMS and EONET snapshots are fetched separately from stored historical observations. Globe stations and orbital links are illustrative. Missing observations remain missing, not zero-filled.',
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
    a: 'Public-demo evaluations can publish via SSE and configured signed webhooks; scheduler facts can send through Resend or SMTP. The deployed email recipient is a reserved Resend test inbox, and the webhook records a local signed receipt without external forwarding. Private digest broadcasting is disabled.',
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
        'Mission console for evidence-supported crop-rotation comparisons, NASA POWER history, GIBS imagery and fire context, with explicit provenance and availability limits.',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      featureList: [
        '12+ years of daily NASA POWER meteorology for any coordinate',
        'Seasonal Mann-Kendall trend detection with FDR control',
        'VIIRS 375 m fire-detection stream from NASA GIBS vector tiles',
        'Regional fire watchlists on real scheduler cadences',
        'Cadence-aware digests pushed via SSE, signed webhook and email',
        'Provider retrieval logging with secret redaction and privacy-gated diagnostics',
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
    'Explore NASA Earth observations, compare crop rotations, inspect VIIRS fire context and review evidence limits. Public demo and verified private farm records. NASA Space Apps Challenge 2026 — Field Shift.',
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
  alternates: {
    canonical: '/',
    languages: {
      'en-AE': '/',
      'en-US': '/',
      en: '/',
      'x-default': '/',
    },
  },
  openGraph: {
    type: 'website',
    url: SITE_URL,
    siteName: 'TerraField Atlas',
    title: 'TerraField Atlas — NASA Earth Intelligence for Agricultural Resilience',
    description:
      'Real NASA Earth observations, honest statistics, live fire intelligence and push-delivered digests — with full provenance for every retrieval. NASA Space Apps Challenge 2026.',
    locale: 'en_AE',
    alternateLocale: ['en_US', 'en_GB'],
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
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
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
        <footer className="marketing-footer mx-auto max-w-7xl px-6 py-6 text-sm text-muted-foreground">
          <a href="/about" className="underline underline-offset-4">Data sources, methodology, privacy & frequently asked questions</a>
          <details className="mt-4">
            <summary className="min-h-11 cursor-pointer py-3">Mission questions and evidence limits</summary>
            {FAQ.map((entry) => <section key={entry.q} className="border-t py-4"><h2 className="font-medium text-foreground">{entry.q}</h2><p className="mt-2 leading-relaxed">{entry.a}</p></section>)}
          </details>
        </footer>
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
