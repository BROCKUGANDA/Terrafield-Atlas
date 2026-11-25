-- Make the RLS helper functions resolve their lookup tables in the active
-- schema. Production is `public`; schema-scoped test databases need the same
-- policies to work. The schema name is supplied per transaction by the tenant
-- proxy (app.schema) and never by user input.

CREATE OR REPLACE FUNCTION app.current_schema_name()
RETURNS text
LANGUAGE sql
STABLE
AS $$ SELECT COALESCE(NULLIF(current_setting('app.schema', true), ''), 'public') $$;

CREATE OR REPLACE FUNCTION app.can_access_org(p_organization_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  allowed boolean;
  target_schema text := app.current_schema_name();
BEGIN
  IF p_organization_id IS NULL OR app.current_user_id() IS NULL THEN
    RETURN false;
  END IF;
  EXECUTE format(
    'SELECT EXISTS (
       SELECT 1 FROM %I."Membership"
       WHERE "organizationId" = $1 AND "userId" = $2 AND status = ''active''
     )', target_schema
  ) USING p_organization_id, app.current_user_id() INTO allowed;
  RETURN allowed;
END;
$$;

CREATE OR REPLACE FUNCTION app.can_read_webhook_delivery(p_endpoint_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  allowed boolean;
  target_schema text := app.current_schema_name();
BEGIN
  IF p_endpoint_id IS NULL OR app.current_user_id() IS NULL THEN
    RETURN false;
  END IF;
  EXECUTE format(
    'SELECT EXISTS (
       SELECT 1 FROM %I."WebhookEndpoint" e
       WHERE e."id" = $1 AND app.can_access_org(e."organizationId")
     )', target_schema
  ) USING p_endpoint_id INTO allowed;
  RETURN allowed;
END;
$$;
