import { z } from 'zod';
import { cacheGet, cacheSet, canonicalKey } from '@/lib/cache';
import { resilientFetch, redactProviderUrl } from '@/lib/http';
import { fetchPinnedPublicUrl } from '@/lib/network-safety';

const DEFAULT_STAC_URL = 'https://stac.maap-project.org/search';
const MAX_ITEMS = 50;

function isPosition(value: unknown): value is [number, number, number?] {
  return Array.isArray(value) && (value.length === 2 || value.length === 3)
    && value.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate))
    && value[0] >= -180 && value[0] <= 180 && value[1] >= -90 && value[1] <= 90;
}

function isLinearRing(value: unknown): boolean {
  if (!Array.isArray(value) || value.length < 4 || !value.every(isPosition)) return false;
  const first = value[0];
  const last = value[value.length - 1];
  return first[0] === last[0] && first[1] === last[1];
}

function isPolygon(value: unknown): boolean {
  return Array.isArray(value) && value.length >= 1 && value.every(isLinearRing);
}

function isMultiPolygon(value: unknown): boolean {
  return Array.isArray(value) && value.length >= 1 && value.every(isPolygon);
}

export const stacGeometrySchema = z.object({
  type: z.enum(['Polygon', 'MultiPolygon']),
  coordinates: z.array(z.unknown()),
}).refine((value) => JSON.stringify(value).length <= 20_000)
  .refine((value) => value.type === 'Polygon' ? isPolygon(value.coordinates) : isMultiPolygon(value.coordinates), {
    message: 'geometry must contain closed, bounded Polygon or MultiPolygon coordinates',
  });

const assetSchema = z.object({ href: z.string().min(1).max(2_000), type: z.string().optional(), title: z.string().optional() });
const itemSchema = z.object({
  id: z.string(),
  collection: z.string().optional(),
  type: z.literal('Feature').optional(),
  geometry: z.unknown().optional(),
  bbox: z.array(z.number()).optional(),
  properties: z.record(z.string(), z.unknown()),
  assets: z.record(z.string(), assetSchema),
  links: z.array(z.object({ rel: z.string(), href: z.string().url() })).optional(),
});

export interface StacSearchInput {
  geometry?: z.infer<typeof stacGeometrySchema>;
  from?: string;
  to?: string;
  collections?: string[];
  limit?: number;
  checkAssets?: boolean;
  correlationId?: string;
}

export async function searchStac(input: StacSearchInput) {
  const endpoint = process.env.STAC_API_URL?.trim() || DEFAULT_STAC_URL;
  const publicEndpoint = redactProviderUrl(endpoint);
  const limit = Math.min(Math.max(input.limit ?? 20, 1), MAX_ITEMS);
  const url = new URL(endpoint);
  url.searchParams.set('limit', String(limit));
  if (input.geometry) url.searchParams.set('intersects', JSON.stringify(input.geometry));
  if (input.from || input.to) url.searchParams.set('datetime', `${input.from ?? '..'}T00:00:00Z/${input.to ?? '..'}T23:59:59Z`);
  if (input.collections?.length) url.searchParams.set('collections', input.collections.slice(0, 20).join(','));
  const key = `stac:search:${canonicalKey({ endpoint: publicEndpoint, query: url.searchParams.toString() })}`;
  if (!input.checkAssets) {
    const cached = await cacheGet<unknown>(key);
    if (cached) return cached;
  }
  const outcome = await resilientFetch(url.toString(), {
    provider: 'STAC', operation: 'item-search', timeoutMs: 30_000, maxAttempts: 2,
    correlationId: input.correlationId, pinned: true, maxResponseBytes: 2 * 1024 * 1024,
  });
  if (!outcome.ok) throw new Error(`STAC search returned HTTP ${outcome.status}`);
  const raw: unknown = JSON.parse(new TextDecoder().decode(outcome.body));
  const parsed = z.object({
    type: z.literal('FeatureCollection'),
    features: z.array(itemSchema).max(MAX_ITEMS),
    links: z.array(z.object({ rel: z.string(), href: z.string().url(), method: z.string().optional() })).optional(),
  }).parse(raw);
  const items = parsed.features.map((item) => ({
    id: item.id,
    collection: item.collection ?? null,
    datetime: typeof item.properties.datetime === 'string' ? item.properties.datetime : null,
    start: typeof item.properties.start_datetime === 'string' ? item.properties.start_datetime : null,
    end: typeof item.properties.end_datetime === 'string' ? item.properties.end_datetime : null,
    cloudCover: typeof item.properties['eo:cloud_cover'] === 'number' ? item.properties['eo:cloud_cover'] : null,
    assets: Object.entries(item.assets).map(([name, asset]) => ({ name, href: asset.href, type: asset.type ?? null, title: asset.title ?? null })),
  }));
  let assetAccessibility: { href: string; status: number | null; accessible: boolean; note: string }[] = [];
  if (input.checkAssets) {
    const candidates = items.flatMap((item) => item.assets).slice(0, 5);
    assetAccessibility = await Promise.all(candidates.map(async (asset) => {
      try {
        const response = await fetchPinnedPublicUrl(asset.href, { method: 'HEAD', timeoutMs: 5_000, maxResponseBytes: 16 * 1024 });
        const authRequired = response.status === 401 || response.status === 403;
        return { href: asset.href, status: response.status, accessible: response.ok, note: response.ok ? 'reachable' : authRequired ? 'authentication required' : 'not accessible' };
      } catch { return { href: asset.href, status: null, accessible: false, note: 'asset probe failed' }; }
    }));
  }
  const result = {
    provider: endpoint === DEFAULT_STAC_URL ? 'NASA MAAP public STAC API' : 'Configured STAC API',
    endpoint: publicEndpoint,
    count: items.length,
    items,
    assetAccessibility,
    limitations: ['STAC metadata describes available assets; it does not grant access or imply unrestricted commercial licensing.', 'Asset accessibility probes are bounded to five assets and do not download data.'],
    retrievedAt: new Date().toISOString(),
  };
  if (!input.checkAssets) await cacheSet(key, result, 60 * 60_000);
  return result;
}
