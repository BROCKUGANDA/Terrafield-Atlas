import { z } from 'zod';
import { apiHandler, clientKey, errorResponse, jsonResponse, rateLimit, rateLimitResponse } from '@/lib/api/helpers';
import { requirePermission, resolveTenantContext } from '@/lib/tenancy';
import { assertEntitlement, recordUsage } from '@/lib/commercial';
import { requireFeature } from '@/lib/feature-flags';
import { persistRasterAsset } from '@/lib/raster-assets';

export const runtime = 'nodejs';
const MAX_BYTES = 50 * 1024 * 1024;
const querySchema = z.object({
  band: z.coerce.number().int().min(1).max(64).default(1),
  bbox: z.string().max(2_000).optional(),
  target_crs: z.string().max(200).optional(),
  target_resolution: z.coerce.number().positive().optional(),
  persist: z.coerce.boolean().default(false),
});

export const POST = apiHandler(async (req, { correlationId }) => {
  const context = await resolveTenantContext(req);
  requirePermission(context, 'analysis.run');
  await requireFeature('raster.enabled');
  await assertEntitlement(context, 'processing_jobs_per_month');
  const rl = await rateLimit(clientKey(req, 'raster:stats'), { capacity: 6, refillPerMinute: 2 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);
  const serviceUrl = process.env.RASTER_SERVICE_URL?.trim();
  if (!serviceUrl) return errorResponse(503, 'RASTER_SERVICE_NOT_CONFIGURED', 'quantitative raster processing is not configured', correlationId);
  let endpoint: URL;
  try {
    endpoint = new URL('/v1/raster/stats', serviceUrl);
    if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') throw new Error('invalid protocol');
  } catch {
    return errorResponse(503, 'RASTER_SERVICE_NOT_CONFIGURED', 'raster service URL is invalid', correlationId);
  }
  const query = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams.entries()));
  if (!query.success) return errorResponse(400, 'VALIDATION_ERROR', 'invalid raster processing parameters', correlationId);
  let form: FormData;
  try { form = await req.formData(); } catch { return errorResponse(400, 'INVALID_MULTIPART', 'multipart GeoTIFF upload is required', correlationId); }
  const file = form.get('file');
  if (!(file instanceof File)) return errorResponse(400, 'FILE_REQUIRED', 'a GeoTIFF file is required', correlationId);
  if (file.size > MAX_BYTES) return errorResponse(413, 'PAYLOAD_TOO_LARGE', 'raster exceeds 50 MB', correlationId);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] !== 0x49 && bytes[0] !== 0x4d) return errorResponse(400, 'INVALID_RASTER', 'file is not a classic GeoTIFF', correlationId);

  const outbound = new FormData();
  outbound.set('file', new Blob([bytes], { type: 'image/tiff' }), 'raster.tif');
  outbound.set('band', String(query.data.band));
  if (query.data.bbox) outbound.set('bbox', query.data.bbox);
  if (query.data.target_crs) outbound.set('target_crs', query.data.target_crs);
  if (query.data.target_resolution !== undefined) outbound.set('target_resolution', String(query.data.target_resolution));
  if (query.data.persist) outbound.set('persist', 'true');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(endpoint, { method: 'POST', body: outbound, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) return errorResponse(502, 'RASTER_PROCESSING_FAILED', 'raster processing service rejected the request', correlationId);
    let result: unknown;
    try { result = JSON.parse(text); } catch { return errorResponse(502, 'RASTER_BAD_RESPONSE', 'raster service returned an invalid payload', correlationId); }
    if (query.data.persist) {
      try {
        const asset = await persistRasterAsset({ context, filename: file.name || 'raster.tif', result });
        result = { ...(result as Record<string, unknown>), rasterAsset: asset };
      } catch {
        return errorResponse(500, 'RASTER_ASSET_PERSIST_FAILED', 'raster result was computed but the asset record could not be stored', correlationId);
      }
    }
    await recordUsage({ context, metric: 'processing_jobs_per_month', operationId: `raster:${correlationId}` });
    return jsonResponse(result, { correlationId });
  } catch {
    return errorResponse(504, 'RASTER_TIMEOUT', 'raster processing service timed out or became unavailable', correlationId);
  } finally {
    clearTimeout(timer);
  }
});
