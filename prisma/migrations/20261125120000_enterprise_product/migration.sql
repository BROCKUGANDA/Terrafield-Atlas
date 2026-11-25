-- Enterprise product layer: organizations, commercial operations, developer
-- platform, intelligence governance, and structured source metadata.
-- Additive by design: existing owner/public rows remain valid.

-- AlterTable
ALTER TABLE "ApiRequestLog" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "AuditEvent" ADD COLUMN "organizationId" TEXT;

ALTER TABLE "DataSource"
  ADD COLUMN "accessConditions" TEXT,
  ADD COLUMN "apiLimits" TEXT,
  ADD COLUMN "knownLimitations" TEXT,
  ADD COLUMN "nativeResolutionM" DOUBLE PRECISION,
  ADD COLUMN "processingHistory" TEXT,
  ADD COLUMN "productVersion" TEXT,
  ADD COLUMN "qualityMetadata" TEXT,
  ADD COLUMN "retrievalTimestamp" TIMESTAMP(3),
  ADD COLUMN "spatialCoverage" TEXT,
  ADD COLUMN "stacApiUrl" TEXT,
  ADD COLUMN "stacCollectionId" TEXT,
  ADD COLUMN "temporalEnd" TIMESTAMP(3),
  ADD COLUMN "temporalStart" TIMESTAMP(3);

ALTER TABLE "EnvironmentalObservation" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "Farm" ADD COLUMN "organizationId" TEXT, ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "FireWatchlist" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "ProcessingJob" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "TrendAnalysis" ADD COLUMN "organizationId" TEXT;

-- CreateTable
CREATE TABLE "Organization" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "country" TEXT,
  "timezone" TEXT NOT NULL DEFAULT 'Africa/Kampala',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Membership" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Membership_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Membership_role_check" CHECK ("role" IN ('owner','admin','analyst','agronomist','researcher','field_officer','viewer','api_service')),
  CONSTRAINT "Membership_status_check" CHECK ("status" IN ('active','suspended'))
);

CREATE TABLE "OrganizationInvitation" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "invitedById" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrganizationInvitation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrganizationInvitation_role_check" CHECK ("role" IN ('admin','analyst','agronomist','researcher','field_officer','viewer','api_service'))
);

CREATE TABLE "Workspace" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Plan" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "monthlyPriceMinor" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "entitlementsJson" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Plan_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Plan_price_check" CHECK ("monthlyPriceMinor" >= 0),
  CONSTRAINT "Plan_currency_check" CHECK (char_length("currency") = 3)
);

CREATE TABLE "Subscription" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT,
  "ownerId" TEXT,
  "planId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'trialing',
  "paymentProvider" TEXT,
  "providerReference" TEXT,
  "trialEndsAt" TIMESTAMP(3),
  "currentPeriodStart" TIMESTAMP(3),
  "currentPeriodEnd" TIMESTAMP(3),
  "cancelAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Subscription_account_check" CHECK ((("organizationId" IS NOT NULL)::integer + ("ownerId" IS NOT NULL)::integer) = 1),
  CONSTRAINT "Subscription_status_check" CHECK ("status" IN ('trialing','active','past_due','canceled','paused'))
);

CREATE TABLE "UsageEvent" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT,
  "ownerId" TEXT,
  "metric" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "operationId" TEXT NOT NULL,
  "jobId" TEXT,
  "billed" BOOLEAN NOT NULL DEFAULT false,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UsageEvent_quantity_check" CHECK ("quantity" > 0)
);

CREATE TABLE "ApiKey" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT,
  "ownerId" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "prefix" TEXT NOT NULL,
  "keyHash" TEXT NOT NULL,
  "scopesJson" TEXT NOT NULL,
  "lastUsedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WebhookEndpoint" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "eventsJson" TEXT NOT NULL,
  "secretCiphertext" TEXT NOT NULL,
  "secretIv" TEXT NOT NULL,
  "secretTag" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WebhookEndpoint_status_check" CHECK ("status" IN ('active','disabled'))
);

CREATE TABLE "WebhookDelivery" (
  "id" TEXT NOT NULL,
  "endpointId" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "payloadJson" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "nextAttemptAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WebhookDelivery_status_check" CHECK ("status" IN ('pending','delivered','failed'))
);

CREATE TABLE "ReportRecord" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT,
  "ownerId" TEXT,
  "farmId" TEXT,
  "title" TEXT NOT NULL,
  "format" TEXT NOT NULL,
  "contentJson" TEXT NOT NULL,
  "provenanceJson" TEXT NOT NULL,
  "artifactRef" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReportRecord_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReportRecord_format_check" CHECK ("format" IN ('pdf','csv','json'))
);

CREATE TABLE "SavedMapView" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT,
  "ownerId" TEXT,
  "name" TEXT NOT NULL,
  "centerLat" DOUBLE PRECISION NOT NULL,
  "centerLon" DOUBLE PRECISION NOT NULL,
  "zoom" DOUBLE PRECISION NOT NULL,
  "layersJson" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SavedMapView_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SavedMapView_lat_check" CHECK ("centerLat" BETWEEN -90 AND 90),
  CONSTRAINT "SavedMapView_lon_check" CHECK ("centerLon" BETWEEN -180 AND 180)
);

CREATE TABLE "AgentRun" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT,
  "ownerId" TEXT NOT NULL,
  "query" TEXT NOT NULL,
  "planJson" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'planned',
  "approvedAt" TIMESTAMP(3),
  "resultJson" TEXT,
  "limitationsJson" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AgentRun_status_check" CHECK ("status" IN ('planned','awaiting_approval','running','succeeded','failed','rejected'))
);

CREATE TABLE "ToolExecution" (
  "id" TEXT NOT NULL,
  "agentRunId" TEXT NOT NULL,
  "toolName" TEXT NOT NULL,
  "inputJson" TEXT NOT NULL,
  "permission" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "outputRef" TEXT,
  "error" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "ToolExecution_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EvidenceReference" (
  "id" TEXT NOT NULL,
  "agentRunId" TEXT,
  "sourceType" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "uri" TEXT,
  "contentHash" TEXT,
  "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EvidenceReference_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AnalysisMethod" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "specificationJson" TEXT NOT NULL,
  "validatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AnalysisMethod_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ValidationResult" (
  "id" TEXT NOT NULL,
  "methodId" TEXT NOT NULL,
  "dataset" TEXT NOT NULL,
  "splitStrategy" TEXT NOT NULL,
  "metricsJson" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ValidationResult_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FeatureFlag" (
  "key" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "rolloutJson" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FeatureFlag_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");
CREATE INDEX "Membership_userId_status_idx" ON "Membership"("userId", "status");
CREATE INDEX "Membership_organizationId_role_idx" ON "Membership"("organizationId", "role");
CREATE UNIQUE INDEX "Membership_organizationId_userId_key" ON "Membership"("organizationId", "userId");
CREATE UNIQUE INDEX "OrganizationInvitation_tokenHash_key" ON "OrganizationInvitation"("tokenHash");
CREATE INDEX "OrganizationInvitation_organizationId_email_idx" ON "OrganizationInvitation"("organizationId", "email");
CREATE INDEX "OrganizationInvitation_email_expiresAt_idx" ON "OrganizationInvitation"("email", "expiresAt");
CREATE INDEX "Workspace_organizationId_createdAt_idx" ON "Workspace"("organizationId", "createdAt");
CREATE UNIQUE INDEX "Workspace_organizationId_name_key" ON "Workspace"("organizationId", "name");
CREATE UNIQUE INDEX "Plan_code_key" ON "Plan"("code");
CREATE INDEX "Subscription_organizationId_status_idx" ON "Subscription"("organizationId", "status");
CREATE INDEX "Subscription_ownerId_status_idx" ON "Subscription"("ownerId", "status");
CREATE UNIQUE INDEX "UsageEvent_operationId_key" ON "UsageEvent"("operationId");
CREATE INDEX "UsageEvent_organizationId_metric_occurredAt_idx" ON "UsageEvent"("organizationId", "metric", "occurredAt");
CREATE INDEX "UsageEvent_ownerId_metric_occurredAt_idx" ON "UsageEvent"("ownerId", "metric", "occurredAt");
CREATE INDEX "UsageEvent_jobId_idx" ON "UsageEvent"("jobId");
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");
CREATE INDEX "ApiKey_organizationId_revokedAt_idx" ON "ApiKey"("organizationId", "revokedAt");
CREATE INDEX "ApiKey_ownerId_revokedAt_idx" ON "ApiKey"("ownerId", "revokedAt");
CREATE INDEX "WebhookEndpoint_organizationId_status_idx" ON "WebhookEndpoint"("organizationId", "status");
CREATE UNIQUE INDEX "WebhookDelivery_eventId_key" ON "WebhookDelivery"("eventId");
CREATE INDEX "WebhookDelivery_endpointId_status_createdAt_idx" ON "WebhookDelivery"("endpointId", "status", "createdAt");
CREATE INDEX "WebhookDelivery_status_nextAttemptAt_idx" ON "WebhookDelivery"("status", "nextAttemptAt");
CREATE INDEX "ReportRecord_organizationId_createdAt_idx" ON "ReportRecord"("organizationId", "createdAt");
CREATE INDEX "ReportRecord_ownerId_createdAt_idx" ON "ReportRecord"("ownerId", "createdAt");
CREATE INDEX "ReportRecord_farmId_createdAt_idx" ON "ReportRecord"("farmId", "createdAt");
CREATE INDEX "SavedMapView_organizationId_createdAt_idx" ON "SavedMapView"("organizationId", "createdAt");
CREATE INDEX "SavedMapView_ownerId_createdAt_idx" ON "SavedMapView"("ownerId", "createdAt");
CREATE INDEX "AgentRun_organizationId_createdAt_idx" ON "AgentRun"("organizationId", "createdAt");
CREATE INDEX "AgentRun_ownerId_createdAt_idx" ON "AgentRun"("ownerId", "createdAt");
CREATE INDEX "ToolExecution_agentRunId_startedAt_idx" ON "ToolExecution"("agentRunId", "startedAt");
CREATE INDEX "EvidenceReference_agentRunId_idx" ON "EvidenceReference"("agentRunId");
CREATE INDEX "EvidenceReference_sourceType_sourceId_idx" ON "EvidenceReference"("sourceType", "sourceId");
CREATE UNIQUE INDEX "AnalysisMethod_key_key" ON "AnalysisMethod"("key");
CREATE UNIQUE INDEX "AnalysisMethod_key_version_key" ON "AnalysisMethod"("key", "version");
CREATE INDEX "ValidationResult_methodId_createdAt_idx" ON "ValidationResult"("methodId", "createdAt");
CREATE INDEX "ApiRequestLog_organizationId_retrievedAt_idx" ON "ApiRequestLog"("organizationId", "retrievedAt");
CREATE INDEX "AuditEvent_organizationId_createdAt_idx" ON "AuditEvent"("organizationId", "createdAt");
CREATE INDEX "EnvironmentalObservation_organizationId_variable_obsDate_idx" ON "EnvironmentalObservation"("organizationId", "variable", "obsDate");
CREATE INDEX "Farm_organizationId_createdAt_idx" ON "Farm"("organizationId", "createdAt");
CREATE INDEX "Farm_workspaceId_idx" ON "Farm"("workspaceId");
CREATE INDEX "FireWatchlist_organizationId_createdAt_idx" ON "FireWatchlist"("organizationId", "createdAt");
CREATE INDEX "ProcessingJob_organizationId_type_status_startedAt_idx" ON "ProcessingJob"("organizationId", "type", "status", "startedAt");
CREATE INDEX "TrendAnalysis_organizationId_variable_createdAt_idx" ON "TrendAnalysis"("organizationId", "variable", "createdAt");

-- AddForeignKey
ALTER TABLE "Farm" ADD CONSTRAINT "Farm_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Farm" ADD CONSTRAINT "Farm_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ApiRequestLog" ADD CONSTRAINT "ApiRequestLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EnvironmentalObservation" ADD CONSTRAINT "EnvironmentalObservation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TrendAnalysis" ADD CONSTRAINT "TrendAnalysis_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProcessingJob" ADD CONSTRAINT "ProcessingJob_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FireWatchlist" ADD CONSTRAINT "FireWatchlist_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AccountUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrganizationInvitation" ADD CONSTRAINT "OrganizationInvitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrganizationInvitation" ADD CONSTRAINT "OrganizationInvitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "AccountUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "AccountUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "AccountUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "AccountUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "AccountUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "WebhookEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReportRecord" ADD CONSTRAINT "ReportRecord_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReportRecord" ADD CONSTRAINT "ReportRecord_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "AccountUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReportRecord" ADD CONSTRAINT "ReportRecord_farmId_fkey" FOREIGN KEY ("farmId") REFERENCES "Farm"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SavedMapView" ADD CONSTRAINT "SavedMapView_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SavedMapView" ADD CONSTRAINT "SavedMapView_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "AccountUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "AccountUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ToolExecution" ADD CONSTRAINT "ToolExecution_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EvidenceReference" ADD CONSTRAINT "EvidenceReference_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ValidationResult" ADD CONSTRAINT "ValidationResult_methodId_fkey" FOREIGN KEY ("methodId") REFERENCES "AnalysisMethod"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "OutboxEvent_event_type_published_at_available_at_idx" RENAME TO "OutboxEvent_eventType_publishedAt_availableAt_idx";
