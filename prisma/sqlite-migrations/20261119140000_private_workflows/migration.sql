-- Additive migration: retain every observation, analysis and job.
ALTER TABLE "EnvironmentalObservation" ADD COLUMN "ownerId" TEXT;
ALTER TABLE "EnvironmentalObservation" ADD COLUMN "namespace" TEXT NOT NULL DEFAULT 'public';
ALTER TABLE "TrendAnalysis" ADD COLUMN "ownerId" TEXT;
ALTER TABLE "ProcessingJob" ADD COLUMN "ownerId" TEXT;

UPDATE "EnvironmentalObservation" SET "ownerId" = (SELECT "ownerId" FROM "Farm" WHERE "Farm"."id" = "EnvironmentalObservation"."farmId");
UPDATE "TrendAnalysis" SET "ownerId" = (SELECT "ownerId" FROM "Farm" WHERE "Farm"."id" = "TrendAnalysis"."farmId");
UPDATE "EnvironmentalObservation" SET "namespace" = 'farm:' || "farmId" WHERE "ownerId" IS NOT NULL;

-- Unresolvable historical references are retained but never made public.
UPDATE "ProcessingJob" SET "ownerId" = CASE
  WHEN NOT json_valid("params") THEN 'unresolved:legacy'
  WHEN json_type("params") != 'object' THEN 'unresolved:legacy'
  WHEN json_type("params", '$.farmId') NOT IN ('text', 'null') OR json_type("params", '$.watchlistId') NOT IN ('text', 'null') THEN 'unresolved:legacy'
  WHEN json_type("params", '$.farmId') = 'text' AND NOT EXISTS (SELECT 1 FROM "Farm" WHERE "id" = json_extract("ProcessingJob"."params", '$.farmId')) THEN 'unresolved:legacy'
  WHEN json_type("params", '$.watchlistId') = 'text' AND NOT EXISTS (SELECT 1 FROM "FireWatchlist" WHERE "id" = json_extract("ProcessingJob"."params", '$.watchlistId')) THEN 'unresolved:legacy'
  WHEN (SELECT "ownerId" FROM "Farm" WHERE "id" = json_extract("ProcessingJob"."params", '$.farmId')) IS NOT NULL
    AND (SELECT "ownerId" FROM "FireWatchlist" WHERE "id" = json_extract("ProcessingJob"."params", '$.watchlistId')) IS NOT NULL
    AND (SELECT "ownerId" FROM "Farm" WHERE "id" = json_extract("ProcessingJob"."params", '$.farmId')) != (SELECT "ownerId" FROM "FireWatchlist" WHERE "id" = json_extract("ProcessingJob"."params", '$.watchlistId')) THEN 'unresolved:legacy'
  WHEN json_type("params", '$.farmId') IS NOT NULL AND json_type("params", '$.farmId') != 'null'
    THEN COALESCE((SELECT "ownerId" FROM "Farm" WHERE "id" = json_extract("ProcessingJob"."params", '$.farmId')), (SELECT "ownerId" FROM "FireWatchlist" WHERE "id" = json_extract("ProcessingJob"."params", '$.watchlistId')), '')
  WHEN json_type("params", '$.watchlistId') IS NOT NULL AND json_type("params", '$.watchlistId') != 'null'
    THEN COALESCE((SELECT COALESCE("ownerId", '') FROM "FireWatchlist" WHERE "id" = json_extract("ProcessingJob"."params", '$.watchlistId')), 'unresolved:legacy')
  ELSE '' END;
UPDATE "ProcessingJob" SET "ownerId" = NULL WHERE "ownerId" = '';

CREATE UNIQUE INDEX "EnvironmentalObservation_namespace_lat_lon_variable_obsDate_key" ON "EnvironmentalObservation"("namespace", "lat", "lon", "variable", "obsDate");
DROP INDEX "EnvironmentalObservation_lat_lon_variable_obsDate_key";
CREATE INDEX "EnvironmentalObservation_ownerId_idx" ON "EnvironmentalObservation"("ownerId");