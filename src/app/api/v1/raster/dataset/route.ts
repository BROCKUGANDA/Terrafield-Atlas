import { z } from 'zod';
import { apiHandler, clientKey, errorResponse, jsonResponse, rateLimit, rateLimitResponse } from '@/lib/api/helpers';
import { requirePermission, resolveTenantContext } from '@/lib/tenancy';
import { assertEntitlement, recordUsage } from '@/lib/commercial';
import { requireFeature } from '@/lib/feature-flags';

export const runtime = 'nodejs';
const MAX_BYTES = 50 * 1024 * 1024;
const querySchema = z.object({
  variable: z.string().max(200).optional(),
  bbox: z.string().max(2_000).optional(),
  target_crs: z.string().max(200).optional(),
  target_resolution: z.coerce.number().positive().optional(),
  crs: z.string().max(200).optional(),
});

export const POST = apiHandler(async (req, { correlationId }) => {
  const context = await resolveTenantContext(req);
  requirePermission(context, 'analysis.run');
  await requireFeature('raster.enabled');
  await assertEntitlement(context, 'processing_jobs_per_month');
  const rl = await rateLimit(clientKey(req, 'raster:dataset'), { capacity: 4, refillPerMinute: 2 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec, correlationId);
  const serviceUrl = process.env.RASTER_SERVICE_URL?.trim();
  if (!serviceUrl) return errorResponse(503, 'RASTER_SERVICE_NOT_CONFIGURED', 'quantitative raster processing is not configured', correlationId);
  let endpoint: URL;
  try {
    endpoint = new URL('/v1/dataset/stats', serviceUrl);
    if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') throw new Error('invalid protocol');
  } catch {
    return errorResponse(503, 'RASTER_SERVICE_NOT_CONFIGURED', 'raster service URL is invalid', correlationId);
  }
  const query = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams.entries()));
  if (!query.success) return errorResponse(400, 'VALIDATION_ERROR', 'invalid dataset processing parameters', correlationId);
  let form: FormData;
  try { form = await req.formData(); } catch { return errorResponse(400, 'INVALID_MULTIPART', 'multipart dataset upload is required', correlationId); }
  const file = form.get('file');
  if (!(file instanceof File)) return errorResponse(400, 'FILE_REQUIRED', 'a NetCDF or Zarr ZIP file is required', correlationId);
  if (file.size > MAX_BYTES) return errorResponse(413, 'PAYLOAD_TOO_LARGE', 'dataset exceeds 50 MB', correlationId);
  const name = (file.name || '').toLowerCase();
  if (!name.endsWith('.nc') && !name.endsWith('.nc4') && !name.endsWith('.zip')) return errorResponse(400, 'UNSUPPORTED_DATASET', 'supported formats are .nc, .nc4, and Zarr .zip', correlationId);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const outbound = new FormData();
  outbound.set('file', new Blob([bytes]), file.name || 'dataset.nc');
  if (query.data.variable) outbound.set('variable', query.data.variable);
  if (query.data.bbox) outbound.set('bbox', query.data.bbox);
  if (query.data.target_crs) outbound.set('target_crs', query.data.target_crs);
  if (query.data.target_resolution !== undefined) outbound.set('target_resolution', String(query.data.target_resolution));
  if (query.data.crs) outbound.set('crs', query.data.crs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(endpoint, { method: 'POST', body: outbound, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) return errorResponse(502, 'DATASET_PROCESSING_FAILED', 'dataset processing service rejected the request', correlationId);
    let result: unknown;
    try { result = JSON.parse(text); } catch { return errorResponse(502, 'DATASET_BAD_RESPONSE', 'dataset service returned an invalid payload', correlationId); }
    await recordUsage({ context, metric: 'processing_jobs_per_month', operationId: `dataset:${correlationId}` });
    return jsonResponse(result, { correlationId });
  } catch {
    return errorResponse(504, 'DATASET_TIMEOUT', 'dataset processing service timed out or became unavailable', correlationId);
  } finally { clearTimeout(timer); }
});
