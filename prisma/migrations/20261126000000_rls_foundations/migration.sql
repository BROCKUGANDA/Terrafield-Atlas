-- Database-enforced tenant isolation foundation.
-- Application queries must run as terrafield_app with transaction-local
-- app.user_id / app.organization_id settings. The table owner (migrations and
-- tests) retains normal access; production DATABASE_URL must select the role.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'terrafield_app') THEN
    CREATE ROLE terrafield_app NOLOGIN;
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.current_user_id()
RETURNS text
LANGUAGE sql
STABLE
AS $$ SELECT NULLIF(current_setting('app.user_id', true), '') $$;

CREATE OR REPLACE FUNCTION app.current_organization_id()
RETURNS text
LANGUAGE sql
STABLE
AS $$ SELECT NULLIF(current_setting('app.organization_id', true), '') $$;

CREATE OR REPLACE FUNCTION app.can_access_org(p_organization_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  allowed boolean;
BEGIN
  IF p_organization_id IS NULL OR app.current_user_id() IS NULL THEN
    RETURN false;
  END IF;
  EXECUTE 'SELECT EXISTS (
    SELECT 1 FROM public."Membership"
    WHERE "organizationId" = $1 AND "userId" = $2 AND status = ''active''
  )' USING p_organization_id, app.current_user_id() INTO allowed;
  RETURN allowed;
END;
$$;

CREATE OR REPLACE FUNCTION app.can_read_row(p_owner_id text, p_organization_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (p_organization_id IS NULL AND (p_owner_id IS NULL OR p_owner_id = app.current_user_id()))
      OR (p_organization_id IS NOT NULL
          AND p_organization_id = app.current_organization_id()
          AND app.can_access_org(p_organization_id))
$$;

CREATE OR REPLACE FUNCTION app.can_read_webhook_delivery(p_endpoint_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  allowed boolean;
BEGIN
  EXECUTE 'SELECT EXISTS (
    SELECT 1 FROM public."WebhookEndpoint" e
    WHERE e."id" = $1 AND app.can_access_org(e."organizationId")
  )' USING p_endpoint_id INTO allowed;
  RETURN allowed;
END;
$$;

GRANT USAGE ON SCHEMA public TO terrafield_app;
GRANT USAGE ON SCHEMA app TO terrafield_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO terrafield_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO terrafield_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO terrafield_app;

-- Tenant-owned domain tables.
ALTER TABLE "Farm" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS terrafield_tenant_access ON "Farm";
CREATE POLICY terrafield_tenant_access ON "Farm" FOR ALL TO terrafield_app
  USING (app.can_read_row("ownerId", "organizationId"))
  WITH CHECK (app.can_read_row("ownerId", "organizationId"));

ALTER TABLE "FireWatchlist" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS terrafield_tenant_access ON "FireWatchlist";
CREATE POLICY terrafield_tenant_access ON "FireWatchlist" FOR ALL TO terrafield_app
  USING (app.can_read_row("ownerId", "organizationId"))
  WITH CHECK (app.can_read_row("ownerId", "organizationId"));

ALTER TABLE "EnvironmentalObservation" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS terrafield_tenant_access ON "EnvironmentalObservation";
CREATE POLICY terrafield_tenant_access ON "EnvironmentalObservation" FOR ALL TO terrafield_app
  USING (app.can_read_row("ownerId", "organizationId"))
  WITH CHECK (app.can_read_row("ownerId", "organizationId"));

ALTER TABLE "TrendAnalysis" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS terrafield_tenant_access ON "TrendAnalysis";
CREATE POLICY terrafield_tenant_access ON "TrendAnalysis" FOR ALL TO terrafield_app
  USING (app.can_read_row("ownerId", "organizationId"))
  WITH CHECK (app.can_read_row("ownerId", "organizationId"));

ALTER TABLE "ProcessingJob" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS terrafield_tenant_access ON "ProcessingJob";
CREATE POLICY terrafield_tenant_access ON "ProcessingJob" FOR ALL TO terrafield_app
  USING (app.can_read_row("ownerId", "organizationId"))
  WITH CHECK (app.can_read_row("ownerId", "organizationId"));

ALTER TABLE "ReportRecord" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS terrafield_tenant_access ON "ReportRecord";
CREATE POLICY terrafield_tenant_access ON "ReportRecord" FOR ALL TO terrafield_app
  USING (app.can_read_row("ownerId", "organizationId"))
  WITH CHECK (app.can_read_row("ownerId", "organizationId"));

ALTER TABLE "AgentRun" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS terrafield_tenant_access ON "AgentRun";
CREATE POLICY terrafield_tenant_access ON "AgentRun" FOR ALL TO terrafield_app
  USING (app.can_read_row("ownerId", "organizationId"))
  WITH CHECK (app.can_read_row("ownerId", "organizationId"));

ALTER TABLE "SavedMapView" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS terrafield_tenant_access ON "SavedMapView";
CREATE POLICY terrafield_tenant_access ON "SavedMapView" FOR ALL TO terrafield_app
  USING (app.can_read_row("ownerId", "organizationId"))
  WITH CHECK (app.can_read_row("ownerId", "organizationId"));

ALTER TABLE "ApiKey" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS terrafield_tenant_access ON "ApiKey";
CREATE POLICY terrafield_tenant_access ON "ApiKey" FOR ALL TO terrafield_app
  USING (app.can_read_row("ownerId", "organizationId"))
  WITH CHECK (app.can_read_row("ownerId", "organizationId"));

ALTER TABLE "UsageEvent" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS terrafield_tenant_access ON "UsageEvent";
CREATE POLICY terrafield_tenant_access ON "UsageEvent" FOR ALL TO terrafield_app
  USING (app.can_read_row("ownerId", "organizationId"))
  WITH CHECK (app.can_read_row("ownerId", "organizationId"));

ALTER TABLE "IdempotencyRecord" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS terrafield_tenant_access ON "IdempotencyRecord";
CREATE POLICY terrafield_tenant_access ON "IdempotencyRecord" FOR ALL TO terrafield_app
  USING ("ownerId" = app.current_user_id())
  WITH CHECK ("ownerId" = app.current_user_id());

ALTER TABLE "AuditEvent" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS terrafield_tenant_access ON "AuditEvent";
CREATE POLICY terrafield_tenant_access ON "AuditEvent" FOR ALL TO terrafield_app
  USING (app.can_read_row(NULL, "organizationId") OR actor = 'account:' || app.current_user_id())
  WITH CHECK (app.can_read_row(NULL, "organizationId") OR actor = 'account:' || app.current_user_id());

ALTER TABLE "ApiRequestLog" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS terrafield_tenant_access ON "ApiRequestLog";
CREATE POLICY terrafield_tenant_access ON "ApiRequestLog" FOR ALL TO terrafield_app
  USING (app.can_read_row(NULL, "organizationId"))
  WITH CHECK (app.can_read_row(NULL, "organizationId"));

-- Organization-scoped tables.
ALTER TABLE "Organization" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS terrafield_tenant_access ON "Organization";
CREATE POLICY terrafield_tenant_access ON "Organization" FOR ALL TO terrafield_app
  USING (id = app.current_organization_id() OR app.can_access_org(id))
  WITH CHECK (id = app.current_organization_id() OR app.can_access_org(id));

ALTER TABLE "Membership" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS terrafield_tenant_access ON "Membership";
CREATE POLICY terrafield_tenant_access ON "Membership" FOR ALL TO terrafield_app
  USING ("userId" = app.current_user_id() OR app.can_access_org("organizationId"))
  WITH CHECK ("userId" = app.current_user_id() OR app.can_access_org("organizationId"));

ALTER TABLE "OrganizationInvitation" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS terrafield_tenant_access ON "OrganizationInvitation";
CREATE POLICY terrafield_tenant_access ON "OrganizationInvitation" FOR ALL TO terrafield_app
  USING (app.can_access_org("organizationId") OR "invitedById" = app.current_user_id())
  WITH CHECK (app.can_access_org("organizationId") OR "invitedById" = app.current_user_id());

ALTER TABLE "Workspace" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS terrafield_tenant_access ON "Workspace";
CREATE POLICY terrafield_tenant_access ON "Workspace" FOR ALL TO terrafield_app
  USING (app.can_access_org("organizationId"))
  WITH CHECK (app.can_access_org("organizationId"));

ALTER TABLE "WebhookEndpoint" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS terrafield_tenant_access ON "WebhookEndpoint";
CREATE POLICY terrafield_tenant_access ON "WebhookEndpoint" FOR ALL TO terrafield_app
  USING (app.can_access_org("organizationId"))
  WITH CHECK (app.can_access_org("organizationId"));

ALTER TABLE "WebhookDelivery" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS terrafield_tenant_access ON "WebhookDelivery";
CREATE POLICY terrafield_tenant_access ON "WebhookDelivery" FOR ALL TO terrafield_app
  USING (app.can_read_webhook_delivery("endpointId"))
  WITH CHECK (app.can_read_webhook_delivery("endpointId"));

ALTER TABLE "AccountUser" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS terrafield_tenant_access ON "AccountUser";
CREATE POLICY terrafield_tenant_access ON "AccountUser" FOR ALL TO terrafield_app
  USING (id = app.current_user_id() OR "isAdmin")
  WITH CHECK (id = app.current_user_id() OR "isAdmin");
