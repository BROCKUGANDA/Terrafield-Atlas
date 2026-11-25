import { z } from 'zod';
import { db } from '@/lib/db';
import type { TenantContext } from '@/lib/tenancy';
import { recordUsage } from '@/lib/commercial';

const resultSchema = z.object({
  artifactRef: z.string().min(1).max(300),
  artifactBytes: z.number().int().nonnegative(),
  metadata: z.record(z.string(), z.unknown()),
  statistics: z.record(z.string(), z.unknown()),
  lineage: z.record(z.string(), z.unknown()),
});

export async function persistRasterAsset(input: {
  context: TenantContext;
  filename: string;
  result: unknown;
}): Promise<{ assetId: string; artifactRef: string }> {
  const parsed = resultSchema.parse(input.result);
  const dataset = parsed.metadata.dataset as { inputFormat?: unknown } | undefined;
  const lineage = parsed.lineage as { inputSha256?: unknown };
  const format = typeof dataset?.inputFormat === 'string' ? dataset.inputFormat : 'geotiff';
  const sourceHash = typeof lineage.inputSha256 === 'string' ? lineage.inputSha256 : '';
  const asset = await db.rasterAsset.create({
    data: {
      ownerId: input.context.userId,
      organizationId: input.context.organizationId,
      filename: input.filename.slice(0, 300),
      format,
      sourceHash,
      artifactRef: parsed.artifactRef,
      artifactBytes: parsed.artifactBytes,
      statsJson: JSON.stringify(parsed.statistics),
      lineageJson: JSON.stringify(parsed.lineage),
    },
  });
  await recordUsage({
    context: input.context,
    metric: 'storage_mb',
    quantity: Math.max(1, Math.ceil(parsed.artifactBytes / (1024 * 1024))),
    operationId: `raster-asset:${parsed.artifactRef}`,
    billed: false,
  });
  return { assetId: asset.id, artifactRef: asset.artifactRef };
}
