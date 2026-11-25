import { db } from '@/lib/db';
import { accountUserId } from '@/lib/auth';
import { AccountAccessError } from '@/lib/access-error';

export const ORGANIZATION_HEADER = 'x-terrafield-organization';

export const ORGANIZATION_ROLES = [
  'owner',
  'admin',
  'analyst',
  'agronomist',
  'researcher',
  'field_officer',
  'viewer',
  'api_service',
] as const;

export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export const PERMISSIONS = [
  'org.read',
  'org.manage',
  'member.manage',
  'billing.manage',
  'farm.read',
  'farm.write',
  'analysis.run',
  'report.create',
  'data.export',
  'api_key.manage',
  'webhook.manage',
  'platform.admin',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<OrganizationRole, readonly Permission[]> = {
  owner: [...PERMISSIONS.filter((permission) => permission !== 'platform.admin')],
  admin: ['org.read', 'org.manage', 'member.manage', 'farm.read', 'farm.write', 'analysis.run', 'report.create', 'data.export', 'api_key.manage', 'webhook.manage'],
  analyst: ['org.read', 'farm.read', 'analysis.run', 'report.create', 'data.export'],
  agronomist: ['org.read', 'farm.read', 'farm.write', 'analysis.run', 'report.create'],
  researcher: ['org.read', 'farm.read', 'analysis.run', 'data.export'],
  field_officer: ['org.read', 'farm.read', 'farm.write'],
  viewer: ['org.read', 'farm.read'],
  api_service: ['org.read', 'farm.read', 'analysis.run'],
};

export interface TenantContext {
  userId: string | null;
  organizationId: string | null;
  organizationName: string | null;
  role: OrganizationRole | 'personal';
  permissions: readonly Permission[];
  isPlatformAdmin: boolean;
}

const PERSONAL_PERMISSIONS: readonly Permission[] = [
  'farm.read', 'farm.write', 'analysis.run', 'report.create', 'data.export', 'api_key.manage', 'billing.manage',
];

export function isOrganizationRole(value: string): value is OrganizationRole {
  return (ORGANIZATION_ROLES as readonly string[]).includes(value);
}

/** Resolve identity and optional organization scope from the verified session. */
export async function resolveTenantContext(req: Request): Promise<TenantContext> {
  const organizationId = req.headers.get(ORGANIZATION_HEADER)?.trim() || null;
  const userId = await accountUserId(req);
  if (!userId) {
    if (organizationId) throw new AccountAccessError(401, 'AUTH_REQUIRED', 'a verified account is required for an organization workspace');
    return {
      userId: null,
      organizationId: null,
      organizationName: null,
      role: 'personal',
      permissions: [],
      isPlatformAdmin: false,
    };
  }

  const user = await db.accountUser.findUnique({ where: { id: userId }, select: { isAdmin: true } });
  if (!organizationId) {
    return {
      userId,
      organizationId: null,
      organizationName: null,
      role: 'personal',
      permissions: user?.isAdmin ? [...PERSONAL_PERMISSIONS, 'platform.admin'] : PERSONAL_PERMISSIONS,
      isPlatformAdmin: user?.isAdmin === true,
    };
  }

  if (organizationId.length > 128) throw new AccountAccessError(400, 'INVALID_ORGANIZATION', 'organization identifier is invalid');
  const membership = await db.membership.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    select: { role: true, status: true, organization: { select: { id: true, name: true } } },
  });
  if (!membership || membership.status !== 'active' || !isOrganizationRole(membership.role)) {
    throw new AccountAccessError(403, 'ORGANIZATION_ACCESS_DENIED', 'active organization membership is required');
  }
  return {
    userId,
    organizationId,
    organizationName: membership.organization.name,
    role: membership.role,
    permissions: user?.isAdmin ? [...ROLE_PERMISSIONS[membership.role], 'platform.admin'] : ROLE_PERMISSIONS[membership.role],
    isPlatformAdmin: user?.isAdmin === true,
  };
}

export function hasPermission(context: TenantContext, permission: Permission): boolean {
  return context.permissions.includes(permission);
}

export function requirePermission(context: TenantContext, permission: Permission): void {
  if (!hasPermission(context, permission)) {
    throw new AccountAccessError(403, 'PERMISSION_DENIED', `permission ${permission} is required`);
  }
}

export function requireOrganization(context: TenantContext, organizationId: string): void {
  if (!context.organizationId || context.organizationId !== organizationId) {
    throw new AccountAccessError(404, 'NOT_FOUND', 'organization not found');
  }
}

interface OwnedResource {
  ownerId: string | null;
  organizationId?: string | null;
}

export function canReadResource(context: TenantContext, resource: OwnedResource): boolean {
  if (resource.ownerId === null) return true;
  if (context.organizationId && resource.organizationId === context.organizationId) return hasPermission(context, 'farm.read');
  return context.userId !== null && resource.ownerId === context.userId;
}

export function canWriteResource(context: TenantContext, resource: OwnedResource): boolean {
  if (context.organizationId && resource.organizationId === context.organizationId) return hasPermission(context, 'farm.write');
  return context.userId !== null && resource.ownerId === context.userId;
}

/** Prisma predicates for list endpoints. Public records remain readable. */
export function visibleFarmScope(context: TenantContext) {
  if (context.organizationId) return { OR: [{ organizationId: context.organizationId }, { ownerId: null }] };
  return context.userId ? { OR: [{ ownerId: null }, { ownerId: context.userId }] } : { ownerId: null };
}

export function visibleWatchlistScope(context: TenantContext) {
  if (context.organizationId) return { OR: [{ organizationId: context.organizationId }, { ownerId: null }] };
  return context.userId ? { OR: [{ ownerId: null }, { ownerId: context.userId }] } : { ownerId: null };
}

export function visibleObservationScope(context: TenantContext) {
  if (context.organizationId) {
    return {
      OR: [
        { organizationId: context.organizationId },
        { farm: { organizationId: context.organizationId } },
        { ownerId: null, namespace: 'public' },
      ],
    };
  }
  return context.userId ? { OR: [{ ownerId: null }, { ownerId: context.userId }] } : { ownerId: null };
}

export function visibleTrendScope(context: TenantContext) {
  if (context.organizationId) return { OR: [{ organizationId: context.organizationId }, { ownerId: null }] };
  return context.userId ? { OR: [{ ownerId: null }, { ownerId: context.userId }] } : { ownerId: null };
}

export function visibleJobScope(context: TenantContext) {
  if (context.organizationId) return { OR: [{ organizationId: context.organizationId }, { ownerId: null }] };
  return context.userId ? { OR: [{ ownerId: null }, { ownerId: context.userId }] } : { ownerId: null };
}
