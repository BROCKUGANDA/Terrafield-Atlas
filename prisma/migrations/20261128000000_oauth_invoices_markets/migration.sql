-- Developer OAuth clients, invoice settlement, and market price intelligence.
-- Additive. Tenant tables get RLS policies; market prices are public reference
-- data. OAuth token exchange runs on the owner connection (like sign-in),
-- because it happens before any tenant context exists.

CREATE TABLE "OAuthClient" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "scopesJson" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    CONSTRAINT "OAuthClient_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OAuthClient_clientId_key" ON "OAuthClient"("clientId");
CREATE INDEX "OAuthClient_organizationId_active_idx" ON "OAuthClient"("organizationId", "active");

CREATE TABLE "OAuthToken" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "scopesJson" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OAuthToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OAuthToken_tokenHash_key" ON "OAuthToken"("tokenHash");
CREATE INDEX "OAuthToken_clientId_expiresAt_idx" ON "OAuthToken"("clientId", "expiresAt");

CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "ownerId" TEXT,
    "subscriptionId" TEXT,
    "number" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Invoice_number_key" ON "Invoice"("number");
CREATE INDEX "Invoice_organizationId_status_idx" ON "Invoice"("organizationId", "status");
CREATE INDEX "Invoice_ownerId_status_idx" ON "Invoice"("ownerId", "status");

CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "organizationId" TEXT,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'succeeded',
    "reference" TEXT,
    "recordedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Payment_invoiceId_idx" ON "Payment"("invoiceId");
CREATE INDEX "Payment_organizationId_createdAt_idx" ON "Payment"("organizationId", "createdAt");

CREATE TABLE "MarketPrice" (
    "id" TEXT NOT NULL,
    "sourceProvider" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "marketName" TEXT NOT NULL,
    "commodityId" TEXT NOT NULL,
    "commodityName" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "priceDate" TIMESTAMP(3) NOT NULL,
    "category" TEXT,
    "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MarketPrice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MarketPrice_sourceProvider_marketId_commodityId_priceDate_unit_currency_key"
  ON "MarketPrice"("sourceProvider", "marketId", "commodityId", "priceDate", "unit", "currency");
CREATE INDEX "MarketPrice_countryCode_commodityId_priceDate_idx" ON "MarketPrice"("countryCode", "commodityId", "priceDate");

CREATE TABLE "MarketIngestion" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "resourceUrl" TEXT NOT NULL,
    "resourceUpdatedAt" TIMESTAMP(3),
    "rowCount" INTEGER NOT NULL,
    "accepted" INTEGER NOT NULL,
    "skipped" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'running',
    "errorDetail" TEXT,
    CONSTRAINT "MarketIngestion_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MarketIngestion_datasetId_startedAt_idx" ON "MarketIngestion"("datasetId", "startedAt");

ALTER TABLE "OAuthClient" ADD CONSTRAINT "OAuthClient_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OAuthClient" ADD CONSTRAINT "OAuthClient_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "AccountUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OAuthToken" ADD CONSTRAINT "OAuthToken_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "OAuthClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_recordedByUserId_fkey" FOREIGN KEY ("recordedByUserId") REFERENCES "AccountUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Tenant policies for the new commercial and developer tables.
ALTER TABLE "OAuthClient" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS terrafield_tenant_access ON "OAuthClient";
CREATE POLICY terrafield_tenant_access ON "OAuthClient" FOR ALL TO terrafield_app
  USING (app.can_access_org("organizationId"))
  WITH CHECK (app.can_access_org("organizationId"));

ALTER TABLE "OAuthToken" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS terrafield_tenant_access ON "OAuthToken";
CREATE POLICY terrafield_tenant_access ON "OAuthToken" FOR ALL TO terrafield_app
  USING (EXISTS (SELECT 1 FROM "OAuthClient" c WHERE c."id" = "OAuthToken"."clientId" AND app.can_access_org(c."organizationId")))
  WITH CHECK (EXISTS (SELECT 1 FROM "OAuthClient" c WHERE c."id" = "OAuthToken"."clientId" AND app.can_access_org(c."organizationId")));

ALTER TABLE "Invoice" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS terrafield_tenant_access ON "Invoice";
CREATE POLICY terrafield_tenant_access ON "Invoice" FOR ALL TO terrafield_app
  USING (app.can_read_row("ownerId", "organizationId"))
  WITH CHECK (app.can_read_row("ownerId", "organizationId"));

ALTER TABLE "Payment" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS terrafield_tenant_access ON "Payment";
CREATE POLICY terrafield_tenant_access ON "Payment" FOR ALL TO terrafield_app
  USING (app.can_read_row(NULL, "organizationId") OR "recordedByUserId" = app.current_user_id())
  WITH CHECK (app.can_read_row(NULL, "organizationId") OR "recordedByUserId" = app.current_user_id());

-- Members of a visible organization may read their colleagues' account rows
-- (member lists, invitations), not only their own. Added with the OAuth and
-- invoice tables because the web role now enforces RLS in production.
DROP POLICY IF EXISTS terrafield_tenant_access ON "AccountUser";
CREATE POLICY terrafield_tenant_access ON "AccountUser" FOR ALL TO terrafield_app
  USING (
    id = app.current_user_id()
    OR "isAdmin"
    OR EXISTS (
      SELECT 1 FROM "Membership" m
      WHERE m."userId" = "AccountUser"."id"
        AND app.can_access_org(m."organizationId")
    )
  )
  WITH CHECK (id = app.current_user_id() OR "isAdmin");
