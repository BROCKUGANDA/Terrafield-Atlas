-- Organization creation must return the new row to its creator before the
-- creator has a membership row. PostgreSQL applies the SELECT policy to
-- INSERT ... RETURNING, so without a creator column the insert fails RLS.
-- The default captures the requesting account; owner/migration inserts stay
-- NULL and are covered by membership-based policies.

ALTER TABLE "Organization" ADD COLUMN "createdById" TEXT;
UPDATE "Organization" o
SET "createdById" = (
  SELECT m."userId" FROM "Membership" m
  WHERE m."organizationId" = o."id" AND m.role = 'owner'
  ORDER BY m."createdAt" ASC
  LIMIT 1
);
ALTER TABLE "Organization"
  ALTER COLUMN "createdById" SET DEFAULT NULLIF(current_setting('app.user_id', true), '');
CREATE INDEX "Organization_createdById_idx" ON "Organization"("createdById");

DROP POLICY IF EXISTS terrafield_org_select ON "Organization";
DROP POLICY IF EXISTS terrafield_org_insert ON "Organization";
DROP POLICY IF EXISTS terrafield_org_update ON "Organization";
DROP POLICY IF EXISTS terrafield_org_delete ON "Organization";

CREATE POLICY terrafield_org_select ON "Organization" FOR SELECT TO terrafield_app
  USING (id = app.current_organization_id() OR "createdById" = app.current_user_id() OR app.can_access_org(id));
CREATE POLICY terrafield_org_insert ON "Organization" FOR INSERT TO terrafield_app
  WITH CHECK (app.current_user_id() IS NOT NULL);
CREATE POLICY terrafield_org_update ON "Organization" FOR UPDATE TO terrafield_app
  USING (id = app.current_organization_id() OR "createdById" = app.current_user_id() OR app.can_access_org(id))
  WITH CHECK (id = app.current_organization_id() OR "createdById" = app.current_user_id() OR app.can_access_org(id));
CREATE POLICY terrafield_org_delete ON "Organization" FOR DELETE TO terrafield_app
  USING (id = app.current_organization_id() OR "createdById" = app.current_user_id() OR app.can_access_org(id));
