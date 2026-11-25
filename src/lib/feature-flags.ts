import { db } from '@/lib/db';
import { AccountAccessError } from '@/lib/access-error';

const DEFAULTS: Record<string, { description: string; enabled: boolean }> = {
  'intelligence.enabled': { description: 'Approved intelligence plans and tool execution', enabled: true },
  'stac.enabled': { description: 'External STAC catalogue discovery', enabled: true },
  'raster.enabled': { description: 'Quantitative GeoTIFF processing service', enabled: true },
  'markets.enabled': { description: 'Market intelligence (requires approved feeds)', enabled: false },
};

export async function ensureFeatureFlags(): Promise<void> {
  await db.featureFlag.createMany({
    data: Object.entries(DEFAULTS).map(([key, value]) => ({ key, description: value.description, enabled: value.enabled })),
    skipDuplicates: true,
  });
}

export async function isFeatureEnabled(key: string): Promise<boolean> {
  const flag = await db.featureFlag.findUnique({ where: { key }, select: { enabled: true } });
  return flag?.enabled ?? DEFAULTS[key]?.enabled ?? false;
}

export async function requireFeature(key: string): Promise<void> {
  if (!await isFeatureEnabled(key)) throw new AccountAccessError(404, 'FEATURE_DISABLED', `feature ${key} is disabled`);
}
