-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- PostGIS is part of the database baseline even while the existing lat/lon
-- columns remain provider-neutral numeric fields.
CREATE EXTENSION IF NOT EXISTS "postgis";

-- CreateTable
CREATE TABLE "Farm" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT,
    "name" TEXT NOT NULL,
    "country" TEXT,
    "region" TEXT,
    "centroidLat" DOUBLE PRECISION NOT NULL,
    "centroidLon" DOUBLE PRECISION NOT NULL,
    "boundaryGeoJson" TEXT,
    "areaHa" DOUBLE PRECISION,
    "notes" TEXT,
    "ownerLabel" TEXT,
    "cropHistory" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Farm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SoilTest" (
    "id" TEXT NOT NULL,
    "farmId" TEXT NOT NULL,
    "measuredAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "sourceDetail" TEXT,
    "depthCm" DOUBLE PRECISION,
    "texture" TEXT,
    "sandPct" DOUBLE PRECISION,
    "siltPct" DOUBLE PRECISION,
    "clayPct" DOUBLE PRECISION,
    "ph" DOUBLE PRECISION,
    "organicCarbonPct" DOUBLE PRECISION,
    "nitrogenMgKg" DOUBLE PRECISION,
    "phosphorusMgKg" DOUBLE PRECISION,
    "potassiumCmolKg" DOUBLE PRECISION,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SoilTest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataSource" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "datasetName" TEXT NOT NULL,
    "productId" TEXT,
    "endpointTemplate" TEXT NOT NULL,
    "dataFormat" TEXT NOT NULL,
    "temporalCoverage" TEXT NOT NULL,
    "spatialResolution" TEXT NOT NULL,
    "units" TEXT,
    "authRequired" BOOLEAN NOT NULL DEFAULT false,
    "rateLimit" TEXT,
    "license" TEXT NOT NULL,
    "attribution" TEXT NOT NULL,
    "limitations" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiRequestLog" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "datasetId" TEXT,
    "operation" TEXT NOT NULL,
    "requestUrl" TEXT NOT NULL,
    "paramsHash" TEXT,
    "status" INTEGER NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "responseBytes" INTEGER,
    "ok" BOOLEAN NOT NULL,
    "errorDetail" TEXT,
    "correlationId" TEXT,
    "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiRequestLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnvironmentalObservation" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT,
    "namespace" TEXT NOT NULL DEFAULT 'public',
    "farmId" TEXT,
    "lat" DOUBLE PRECISION NOT NULL,
    "lon" DOUBLE PRECISION NOT NULL,
    "variable" TEXT NOT NULL,
    "obsDate" TIMESTAMP(3) NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "sourceProvider" TEXT NOT NULL,
    "datasetVersion" TEXT NOT NULL,
    "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnvironmentalObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CropCharacteristic" (
    "id" TEXT NOT NULL,
    "catalogueVersion" TEXT NOT NULL,
    "cropKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scientificName" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "familyGroup" TEXT NOT NULL,
    "growthDaysMin" INTEGER NOT NULL,
    "growthDaysMax" INTEGER NOT NULL,
    "waterReqMmMin" INTEGER NOT NULL,
    "waterReqMmMax" INTEGER NOT NULL,
    "waterUseClass" TEXT NOT NULL,
    "nFixation" BOOLEAN NOT NULL,
    "nutrientDemand" TEXT NOT NULL,
    "thermalClass" TEXT NOT NULL,
    "calorieStaple" BOOLEAN NOT NULL DEFAULT false,
    "soilPhMin" DOUBLE PRECISION NOT NULL,
    "soilPhMax" DOUBLE PRECISION NOT NULL,
    "textureSuitability" TEXT NOT NULL,
    "notes" TEXT NOT NULL,
    "sources" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "CropCharacteristic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FarmerPreferenceProfile" (
    "id" TEXT NOT NULL,
    "farmId" TEXT NOT NULL,
    "soilHealth" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
    "waterEfficiency" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
    "seasonalAdaptability" DOUBLE PRECISION NOT NULL DEFAULT 0.15,
    "nutrientManagement" DOUBLE PRECISION NOT NULL DEFAULT 0.15,
    "cropDiversity" DOUBLE PRECISION NOT NULL DEFAULT 0.15,
    "economics" DOUBLE PRECISION NOT NULL DEFAULT 0.1,
    "foodSecurity" DOUBLE PRECISION NOT NULL DEFAULT 0.1,
    "rainfedOnly" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FarmerPreferenceProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RotationScenario" (
    "id" TEXT NOT NULL,
    "farmId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cropKeys" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "weights" TEXT NOT NULL,
    "scoresJson" TEXT NOT NULL,
    "overallScore" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "incompatibleJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RotationScenario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrendAnalysis" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT,
    "farmId" TEXT,
    "lat" DOUBLE PRECISION NOT NULL,
    "lon" DOUBLE PRECISION NOT NULL,
    "variable" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "sampleCount" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "slopePerYear" DOUBLE PRECISION,
    "pValue" DOUBLE PRECISION,
    "zValue" DOUBLE PRECISION,
    "direction" TEXT NOT NULL,
    "significant" BOOLEAN NOT NULL,
    "ciLower" DOUBLE PRECISION,
    "ciUpper" DOUBLE PRECISION,
    "resultJson" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrendAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessingJob" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "params" TEXT NOT NULL,
    "progressNote" TEXT,
    "resultRef" TEXT,
    "error" TEXT,
    "correlationId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ProcessingJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FireObservation" (
    "id" TEXT NOT NULL,
    "regionKey" TEXT NOT NULL,
    "obsDate" TIMESTAMP(3) NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "confidence" TEXT NOT NULL,
    "satellite" TEXT NOT NULL,
    "sensor" TEXT NOT NULL,
    "dayNight" TEXT NOT NULL,
    "acqTime" TEXT NOT NULL,
    "brightTi4" DOUBLE PRECISION,
    "brightTi5" DOUBLE PRECISION,
    "frp" DOUBLE PRECISION,
    "uid" TEXT,
    "sourceProvider" TEXT NOT NULL,
    "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FireObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FireCoverageDay" (
    "id" TEXT NOT NULL,
    "regionKey" TEXT NOT NULL,
    "obsDate" TIMESTAMP(3) NOT NULL,
    "dataAvailable" BOOLEAN NOT NULL,
    "detectionCount" INTEGER NOT NULL,
    "bboxWest" DOUBLE PRECISION NOT NULL,
    "bboxSouth" DOUBLE PRECISION NOT NULL,
    "bboxEast" DOUBLE PRECISION NOT NULL,
    "bboxNorth" DOUBLE PRECISION NOT NULL,
    "sourceProvider" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FireCoverageDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FireWatchlist" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT,
    "name" TEXT NOT NULL,
    "label" TEXT,
    "lat" DOUBLE PRECISION NOT NULL,
    "lon" DOUBLE PRECISION NOT NULL,
    "radiusKm" DOUBLE PRECISION NOT NULL DEFAULT 15,
    "minConfidence" TEXT NOT NULL DEFAULT 'nominal',
    "lookbackDays" INTEGER NOT NULL DEFAULT 7,
    "detectionThreshold" INTEGER NOT NULL DEFAULT 5,
    "notes" TEXT,
    "lastStatus" TEXT NOT NULL DEFAULT 'unverified',
    "lastDetectionCount" INTEGER,
    "lastEvaluatedAt" TIMESTAMP(3),
    "reevaluateIntervalMin" INTEGER,
    "nextReevaluateAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FireWatchlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FireWatchEvent" (
    "id" TEXT NOT NULL,
    "watchlistId" TEXT NOT NULL,
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "detectionCount" INTEGER NOT NULL,
    "highConfidenceCount" INTEGER NOT NULL,
    "nominalCount" INTEGER NOT NULL,
    "lowCount" INTEGER NOT NULL,
    "maxFrpMW" DOUBLE PRECISION,
    "daysWithDetections" INTEGER NOT NULL,
    "daysChecked" INTEGER NOT NULL,
    "daysNoData" INTEGER NOT NULL,
    "triggeredAlert" BOOLEAN NOT NULL,
    "detailJson" TEXT NOT NULL,
    "correlationId" TEXT,

    CONSTRAINT "FireWatchEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetId" TEXT,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountUser" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT,
    "emailVerified" TIMESTAMP(3),
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountIdentity" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "AccountIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountVerification" (
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountVerification_pkey" PRIMARY KEY ("tokenHash")
);

-- CreateTable
CREATE TABLE "AccountRateLimit" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountRateLimit_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseRef" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobLease" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobLease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Farm_ownerId_idx" ON "Farm"("ownerId");

-- CreateIndex
CREATE INDEX "SoilTest_farmId_idx" ON "SoilTest"("farmId");

-- CreateIndex
CREATE INDEX "ApiRequestLog_provider_retrievedAt_idx" ON "ApiRequestLog"("provider", "retrievedAt");

-- CreateIndex
CREATE INDEX "EnvironmentalObservation_ownerId_obsDate_idx" ON "EnvironmentalObservation"("ownerId", "obsDate");

-- CreateIndex
CREATE INDEX "EnvironmentalObservation_farmId_variable_obsDate_idx" ON "EnvironmentalObservation"("farmId", "variable", "obsDate");

-- CreateIndex
CREATE INDEX "EnvironmentalObservation_variable_obsDate_idx" ON "EnvironmentalObservation"("variable", "obsDate");

-- CreateIndex
CREATE UNIQUE INDEX "EnvironmentalObservation_namespace_lat_lon_variable_obsDate_key" ON "EnvironmentalObservation"("namespace", "lat", "lon", "variable", "obsDate");

-- CreateIndex
CREATE UNIQUE INDEX "CropCharacteristic_catalogueVersion_cropKey_key" ON "CropCharacteristic"("catalogueVersion", "cropKey");

-- CreateIndex
CREATE INDEX "FarmerPreferenceProfile_farmId_idx" ON "FarmerPreferenceProfile"("farmId");

-- CreateIndex
CREATE INDEX "RotationScenario_farmId_createdAt_idx" ON "RotationScenario"("farmId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RotationScenario_farmId_name_key" ON "RotationScenario"("farmId", "name");

-- CreateIndex
CREATE INDEX "TrendAnalysis_ownerId_createdAt_idx" ON "TrendAnalysis"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "TrendAnalysis_farmId_variable_idx" ON "TrendAnalysis"("farmId", "variable");

-- CreateIndex
CREATE INDEX "TrendAnalysis_variable_createdAt_idx" ON "TrendAnalysis"("variable", "createdAt");

-- CreateIndex
CREATE INDEX "ProcessingJob_ownerId_type_status_startedAt_idx" ON "ProcessingJob"("ownerId", "type", "status", "startedAt");

-- CreateIndex
CREATE INDEX "ProcessingJob_type_status_idx" ON "ProcessingJob"("type", "status");

-- CreateIndex
CREATE INDEX "FireObservation_regionKey_obsDate_idx" ON "FireObservation"("regionKey", "obsDate");

-- CreateIndex
CREATE UNIQUE INDEX "FireObservation_latitude_longitude_obsDate_acqTime_uid_key" ON "FireObservation"("latitude", "longitude", "obsDate", "acqTime", "uid");

-- CreateIndex
CREATE INDEX "FireCoverageDay_regionKey_obsDate_idx" ON "FireCoverageDay"("regionKey", "obsDate");

-- CreateIndex
CREATE UNIQUE INDEX "FireCoverageDay_regionKey_obsDate_key" ON "FireCoverageDay"("regionKey", "obsDate");

-- CreateIndex
CREATE INDEX "FireWatchlist_ownerId_createdAt_idx" ON "FireWatchlist"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "FireWatchlist_lastStatus_idx" ON "FireWatchlist"("lastStatus");

-- CreateIndex
CREATE INDEX "FireWatchlist_nextReevaluateAt_idx" ON "FireWatchlist"("nextReevaluateAt");

-- CreateIndex
CREATE INDEX "FireWatchEvent_watchlistId_evaluatedAt_idx" ON "FireWatchEvent"("watchlistId", "evaluatedAt");

-- CreateIndex
CREATE INDEX "AuditEvent_createdAt_idx" ON "AuditEvent"("createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_action_targetId_createdAt_idx" ON "AuditEvent"("action", "targetId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AccountUser_email_key" ON "AccountUser"("email");

-- CreateIndex
CREATE UNIQUE INDEX "AccountIdentity_provider_providerAccountId_key" ON "AccountIdentity"("provider", "providerAccountId");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_ownerId_createdAt_idx" ON "IdempotencyRecord"("ownerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_ownerId_route_key_key" ON "IdempotencyRecord"("ownerId", "route", "key");

-- CreateIndex
CREATE UNIQUE INDEX "JobLease_key_key" ON "JobLease"("key");

-- CreateIndex
CREATE INDEX "JobLease_expiresAt_idx" ON "JobLease"("expiresAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_availableAt_publishedAt_idx" ON "OutboxEvent"("availableAt", "publishedAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_aggregateType_aggregateId_createdAt_idx" ON "OutboxEvent"("aggregateType", "aggregateId", "createdAt");

-- AddForeignKey
ALTER TABLE "Farm" ADD CONSTRAINT "Farm_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "AccountUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SoilTest" ADD CONSTRAINT "SoilTest_farmId_fkey" FOREIGN KEY ("farmId") REFERENCES "Farm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvironmentalObservation" ADD CONSTRAINT "EnvironmentalObservation_farmId_fkey" FOREIGN KEY ("farmId") REFERENCES "Farm"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FarmerPreferenceProfile" ADD CONSTRAINT "FarmerPreferenceProfile_farmId_fkey" FOREIGN KEY ("farmId") REFERENCES "Farm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RotationScenario" ADD CONSTRAINT "RotationScenario_farmId_fkey" FOREIGN KEY ("farmId") REFERENCES "Farm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrendAnalysis" ADD CONSTRAINT "TrendAnalysis_farmId_fkey" FOREIGN KEY ("farmId") REFERENCES "Farm"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FireWatchlist" ADD CONSTRAINT "FireWatchlist_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "AccountUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FireWatchEvent" ADD CONSTRAINT "FireWatchEvent_watchlistId_fkey" FOREIGN KEY ("watchlistId") REFERENCES "FireWatchlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountIdentity" ADD CONSTRAINT "AccountIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AccountUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountVerification" ADD CONSTRAINT "AccountVerification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AccountUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "AccountUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
