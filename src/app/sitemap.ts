import type { MetadataRoute } from 'next';
import { MODULE_GUIDES } from '@/lib/module-guides';

/**
 * Sitemap for the single-route console. The console is one SPA surface; the
 * machine-readable surface is the open API + /llms.txt + /llms-full.txt.
 */
const BASE = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') || 'https://terrafieldatlas.us';

export default function sitemap(): MetadataRoute.Sitemap {
  // Fixed date, not `new Date()`: a lastmod that moves on every request tells a
  // crawler every URL changed today, every day — the same as no signal at all.
  const lastModified = new Date('2026-11-25');
  return [
    { url: `${BASE}/`, lastModified, changeFrequency: 'daily', priority: 1 },
    { url: `${BASE}/about`, lastModified, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${BASE}/platform`, lastModified, changeFrequency: 'monthly', priority: 0.9 },
    { url: `${BASE}/solutions`, lastModified, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${BASE}/data-methodology`, lastModified, changeFrequency: 'monthly', priority: 0.9 },
    { url: `${BASE}/industries`, lastModified, changeFrequency: 'monthly', priority: 0.7 },
    { url: `${BASE}/pricing`, lastModified, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${BASE}/developers`, lastModified, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${BASE}/research`, lastModified, changeFrequency: 'monthly', priority: 0.7 },
    { url: `${BASE}/contact`, lastModified, changeFrequency: 'yearly', priority: 0.6 },
    { url: `${BASE}/privacy`, lastModified, changeFrequency: 'yearly', priority: 0.4 },
    { url: `${BASE}/terms`, lastModified, changeFrequency: 'yearly', priority: 0.4 },
    ...MODULE_GUIDES.map((guide) => ({ url: `${BASE}/guide/${guide.key}`, changeFrequency: 'monthly' as const, priority: 0.7 })),
    { url: `${BASE}/llms.txt`, lastModified, changeFrequency: 'weekly', priority: 0.6 },
    { url: `${BASE}/llms-full.txt`, lastModified, changeFrequency: 'weekly', priority: 0.6 },
    { url: `${BASE}/manifest.webmanifest`, lastModified, changeFrequency: 'yearly', priority: 0.3 },
  ];
}
