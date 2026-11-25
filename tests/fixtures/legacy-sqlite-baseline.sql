-- CreateTable
CREATE TABLE "Farm" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "country" TEXT,
    "region" TEXT,
    "centroidLat" REAL NOT NULL,
    "centroidLon" REAL NOT NULL,
    "boundaryGeoJson" TEXT,
    "areaHa" REAL,
    "notes" TEXT,
    "ownerLabel" TEXT,
    "cropHistory" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SoilTest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "farmId" TEXT NOT NULL,
    "measuredAt" DATETIME NOT NULL,
    "source" TEXT NOT NULL,
    "sourceDetail" TEXT,
    "depthCm" REAL,
    "texture" TEXT,
    "sandPct" REAL,
    "siltPct" REAL,
    "clayPct" REAL,
    "ph" REAL,
    "organicCarbonPct" REAL,
    "nitrogenMgKg" REAL,
    "phosphorusMgKg" REAL,
    "potassiumCmolKg" REAL,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SoilTest_farmId_fkey" FOREIGN KEY ("farmId") REFERENCES "Farm" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DataSource" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "lastCheckedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ApiRequestLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "retrievedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "EnvironmentalObservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "farmId" TEXT,
    "lat" REAL NOT NULL,
    "lon" REAL NOT NULL,
    "variable" TEXT NOT NULL,
    "obsDate" DATETIME NOT NULL,
    "value" REAL NOT NULL,
    "unit" TEXT NOT NULL,
    "sourceProvider" TEXT NOT NULL,
    "datasetVersion" TEXT NOT NULL,
    "retrievedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EnvironmentalObservation_farmId_fkey" FOREIGN KEY ("farmId") REFERENCES "Farm" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CropCharacteristic" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "soilPhMin" REAL NOT NULL,
    "soilPhMax" REAL NOT NULL,
    "textureSuitability" TEXT NOT NULL,
    "notes" TEXT NOT NULL,
    "sources" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true
);

-- CreateTable
CREATE TABLE "FarmerPreferenceProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "farmId" TEXT NOT NULL,
    "soilHealth" REAL NOT NULL DEFAULT 0.2,
    "waterEfficiency" REAL NOT NULL DEFAULT 0.2,
    "seasonalAdaptability" REAL NOT NULL DEFAULT 0.15,
    "nutrientManagement" REAL NOT NULL DEFAULT 0.15,
    "cropDiversity" REAL NOT NULL DEFAULT 0.15,
    "economics" REAL NOT NULL DEFAULT 0.1,
    "foodSecurity" REAL NOT NULL DEFAULT 0.1,
    "rainfedOnly" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FarmerPreferenceProfile_farmId_fkey" FOREIGN KEY ("farmId") REFERENCES "Farm" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RotationScenario" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "farmId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cropKeys" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "weights" TEXT NOT NULL,
    "scoresJson" TEXT NOT NULL,
    "overallScore" REAL NOT NULL,
    "confidence" REAL NOT NULL,
    "incompatibleJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RotationScenario_farmId_fkey" FOREIGN KEY ("farmId") REFERENCES "Farm" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TrendAnalysis" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "farmId" TEXT,
    "lat" REAL NOT NULL,
    "lon" REAL NOT NULL,
    "variable" TEXT NOT NULL,
    "periodStart" DATETIME NOT NULL,
    "periodEnd" DATETIME NOT NULL,
    "sampleCount" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "slopePerYear" REAL,
    "pValue" REAL,
    "zValue" REAL,
    "direction" TEXT NOT NULL,
    "significant" BOOLEAN NOT NULL,
    "ciLower" REAL,
    "ciUpper" REAL,
    "resultJson" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrendAnalysis_farmId_fkey" FOREIGN KEY ("farmId") REFERENCES "Farm" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProcessingJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "params" TEXT NOT NULL,
    "progressNote" TEXT,
    "resultRef" TEXT,
    "error" TEXT,
    "correlationId" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);

-- CreateTable
CREATE TABLE "FireObservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "regionKey" TEXT NOT NULL,
    "obsDate" DATETIME NOT NULL,
    "latitude" REAL NOT NULL,
    "longitude" REAL NOT NULL,
    "confidence" TEXT NOT NULL,
    "satellite" TEXT NOT NULL,
    "sensor" TEXT NOT NULL,
    "dayNight" TEXT NOT NULL,
    "acqTime" TEXT NOT NULL,
    "brightTi4" REAL,
    "brightTi5" REAL,
    "frp" REAL,
    "uid" TEXT,
    "sourceProvider" TEXT NOT NULL,
    "retrievedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "FireCoverageDay" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "regionKey" TEXT NOT NULL,
    "obsDate" DATETIME NOT NULL,
    "dataAvailable" BOOLEAN NOT NULL,
    "detectionCount" INTEGER NOT NULL,
    "bboxWest" REAL NOT NULL,
    "bboxSouth" REAL NOT NULL,
    "bboxEast" REAL NOT NULL,
    "bboxNorth" REAL NOT NULL,
    "sourceProvider" TEXT NOT NULL,
    "checkedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "FireWatchlist" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "label" TEXT,
    "lat" REAL NOT NULL,
    "lon" REAL NOT NULL,
    "radiusKm" REAL NOT NULL DEFAULT 15,
    "minConfidence" TEXT NOT NULL DEFAULT 'nominal',
    "lookbackDays" INTEGER NOT NULL DEFAULT 7,
    "detectionThreshold" INTEGER NOT NULL DEFAULT 5,
    "notes" TEXT,
    "lastStatus" TEXT NOT NULL DEFAULT 'unverified',
    "lastDetectionCount" INTEGER,
    "lastEvaluatedAt" DATETIME,
    "reevaluateIntervalMin" INTEGER,
    "nextReevaluateAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "FireWatchEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "watchlistId" TEXT NOT NULL,
    "evaluatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "windowStart" DATETIME NOT NULL,
    "windowEnd" DATETIME NOT NULL,
    "status" TEXT NOT NULL,
    "detectionCount" INTEGER NOT NULL,
    "highConfidenceCount" INTEGER NOT NULL,
    "nominalCount" INTEGER NOT NULL,
    "lowCount" INTEGER NOT NULL,
    "maxFrpMW" REAL,
    "daysWithDetections" INTEGER NOT NULL,
    "daysChecked" INTEGER NOT NULL,
    "daysNoData" INTEGER NOT NULL,
    "triggeredAlert" BOOLEAN NOT NULL,
    "detailJson" TEXT NOT NULL,
    "correlationId" TEXT,
    CONSTRAINT "FireWatchEvent_watchlistId_fkey" FOREIGN KEY ("watchlistId") REFERENCES "FireWatchlist" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetId" TEXT,
    "detail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "SoilTest_farmId_idx" ON "SoilTest"("farmId");

-- CreateIndex
CREATE INDEX "ApiRequestLog_provider_retrievedAt_idx" ON "ApiRequestLog"("provider", "retrievedAt");

-- CreateIndex
CREATE INDEX "EnvironmentalObservation_farmId_variable_obsDate_idx" ON "EnvironmentalObservation"("farmId", "variable", "obsDate");

-- CreateIndex
CREATE INDEX "EnvironmentalObservation_variable_obsDate_idx" ON "EnvironmentalObservation"("variable", "obsDate");

-- CreateIndex
CREATE UNIQUE INDEX "EnvironmentalObservation_lat_lon_variable_obsDate_key" ON "EnvironmentalObservation"("lat", "lon", "variable", "obsDate");

-- CreateIndex
CREATE UNIQUE INDEX "CropCharacteristic_catalogueVersion_cropKey_key" ON "CropCharacteristic"("catalogueVersion", "cropKey");

-- CreateIndex
CREATE INDEX "FarmerPreferenceProfile_farmId_idx" ON "FarmerPreferenceProfile"("farmId");

-- CreateIndex
CREATE INDEX "RotationScenario_farmId_idx" ON "RotationScenario"("farmId");

-- CreateIndex
CREATE INDEX "TrendAnalysis_farmId_variable_idx" ON "TrendAnalysis"("farmId", "variable");

-- CreateIndex
CREATE INDEX "TrendAnalysis_variable_createdAt_idx" ON "TrendAnalysis"("variable", "createdAt");

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
CREATE INDEX "FireWatchlist_lastStatus_idx" ON "FireWatchlist"("lastStatus");

-- CreateIndex
CREATE INDEX "FireWatchlist_nextReevaluateAt_idx" ON "FireWatchlist"("nextReevaluateAt");

-- CreateIndex
CREATE INDEX "FireWatchEvent_watchlistId_evaluatedAt_idx" ON "FireWatchEvent"("watchlistId", "evaluatedAt");

-- CreateIndex
CREATE INDEX "AuditEvent_createdAt_idx" ON "AuditEvent"("createdAt");
