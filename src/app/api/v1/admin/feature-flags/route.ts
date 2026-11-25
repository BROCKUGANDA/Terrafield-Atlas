import { z } from 'zod';
import { apiHandler, jsonResponse, parseBody, withIdempotency, writeMutationEffects } from '@/lib/api/helpers';
import { requireAdministrator } from '@/lib/account-access';

const schema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_.:-]{1,80}$/),
  description: z.string().trim().min(1).max(300),
  enabled: z.boolean(),
  rolloutJson: z.string().max(10_000).optional(),
});

export const PATCH = apiHandler((req, { correlationId }) => withIdempotency(req, '/api/v1/admin/feature-flags', async (req, { userId }) => {
  await requireAdministrator(req);
  const parsed = await parseBody(req, schema);
  if (!parsed.ok) return parsed.res;
  if (parsed.data.rolloutJson) {
    try { JSON.parse(parsed.data.rolloutJson); } catch { return jsonResponse({ error: { code: 'INVALID_ROLLOUT', message: 'rolloutJson must be valid JSON', correlationId } }, { status: 400, correlationId }); }
  }
  return {
    commit: async (tx) => {
      const flag = await tx.featureFlag.upsert({
        where: { key: parsed.data.key },
        create: parsed.data,
        update: parsed.data,
      });
      await writeMutationEffects(tx, {
        actor: `account:${userId}`,
        action: 'feature-flag.update',
        targetId: flag.key,
        aggregateType: 'FeatureFlag',
        aggregateId: flag.key,
        eventType: 'feature_flag.updated',
        payload: { key: flag.key, enabled: flag.enabled },
      });
      return jsonResponse({ flag }, { correlationId });
    },
  };
}));
