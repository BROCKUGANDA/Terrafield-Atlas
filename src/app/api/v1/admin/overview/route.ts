import { db } from '@/lib/db';
import { apiHandler, jsonResponse } from '@/lib/api/helpers';
import { requireAdministrator } from '@/lib/account-access';
import { queueMetrics } from '@/lib/jobs/runtime';
import { ensureFeatureFlags } from '@/lib/feature-flags';

export const GET = apiHandler(async (req, { correlationId }) => {
  await requireAdministrator(req);
  await ensureFeatureFlags();
  const [organizations, users, sources, flags, audit, failedJobs, queue] = await Promise.all([
    db.organization.findMany({ orderBy: { createdAt: 'desc' }, take: 100, include: { _count: { select: { farms: true, memberships: true } } } }),
    db.accountUser.findMany({ orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, email: true, name: true, isAdmin: true, emailVerified: true, createdAt: true } }),
    db.dataSource.findMany({ orderBy: { datasetName: 'asc' }, take: 200, select: { id: true, provider: true, datasetName: true, status: true, lastCheckedAt: true } }),
    db.featureFlag.findMany({ orderBy: { key: 'asc' } }),
    db.auditEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, actor: true, action: true, targetId: true, organizationId: true, createdAt: true } }),
    db.processingJob.findMany({ where: { status: { in: ['failed', 'dead-lettered'] } }, orderBy: { startedAt: 'desc' }, take: 50, select: { id: true, type: true, status: true, error: true, startedAt: true, organizationId: true } }),
    queueMetrics(),
  ]);
  return jsonResponse({
    organizations: organizations.map((organization) => ({ id: organization.id, name: organization.name, slug: organization.slug, country: organization.country, createdAt: organization.createdAt, farms: organization._count.farms, members: organization._count.memberships })),
    users,
    sources,
    featureFlags: flags,
    audit,
    failedJobs,
    queue,
  }, { correlationId });
});
