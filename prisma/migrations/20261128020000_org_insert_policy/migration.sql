-- Organization creation happens before the creator has a membership row, so a
-- single FOR ALL policy that requires can_access_org(id) blocks onboarding when
-- the web role is terrafield_app. INSERT is allowed for any authenticated
-- account (the API layer owns naming, quota and audit rules); reads and writes
-- to an existing organization still require the active tenant context.

DROP POLICY IF EXISTS terrafield_tenant_access ON "Organization";
DROP POLICY IF EXISTS terrafield_org_select ON "Organization";
DROP POLICY IF EXISTS terrafield_org_insert ON "Organization";
DROP POLICY IF EXISTS terrafield_org_update ON "Organization";
DROP POLICY IF EXISTS terrafield_org_delete ON "Organization";

CREATE POLICY terrafield_org_select ON "Organization" FOR SELECT TO terrafield_app
  USING (id = app.current_organization_id() OR app.can_access_org(id));
CREATE POLICY terrafield_org_insert ON "Organization" FOR INSERT TO terrafield_app
  WITH CHECK (app.current_user_id() IS NOT NULL);
CREATE POLICY terrafield_org_update ON "Organization" FOR UPDATE TO terrafield_app
  USING (id = app.current_organization_id() OR app.can_access_org(id))
  WITH CHECK (id = app.current_organization_id() OR app.can_access_org(id));
CREATE POLICY terrafield_org_delete ON "Organization" FOR DELETE TO terrafield_app
  USING (id = app.current_organization_id() OR app.can_access_org(id));
