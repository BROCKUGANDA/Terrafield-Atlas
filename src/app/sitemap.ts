import type { MetadataRoute } from 'next';

/**
 * Sitemap for the single-route console. The console is one SPA surface; the
 * machine-readable surface is the open API + /llms.txt + /llms-full.txt.
 */
const BASE = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') || 'https://terrafield-atlas.space';

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return [
    { url: `${BASE}/`, lastModified, changeFrequency: 'daily', priority: 1 },
    { url: `${BASE}/llms.txt`, lastModified, changeFrequency: 'weekly', priority: 0.6 },
    { url: `${BASE}/llms-full.txt`, lastModified, changeFrequency: 'weekly', priority: 0.6 },
    { url: `${BASE}/manifest.webmanifest`, lastModified, changeFrequency: 'yearly', priority: 0.3 },
  ];
}
