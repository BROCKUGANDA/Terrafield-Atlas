-- Persisted derived raster assets with tenant-aware access control.

CREATE TABLE "RasterAsset" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT,
    "organizationId" TEXT,
    "filename" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "artifactRef" TEXT NOT NULL,
    "artifactBytes" INTEGER NOT NULL,
    "statsJson" TEXT NOT NULL,
    "lineageJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RasterAsset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RasterAsset_artifactRef_key" ON "RasterAsset"("artifactRef");
CREATE INDEX "RasterAsset_ownerId_createdAt_idx" ON "RasterAsset"("ownerId", "createdAt");
CREATE INDEX "RasterAsset_organizationId_createdAt_idx" ON "RasterAsset"("organizationId", "createdAt");
CREATE INDEX "RasterAsset_sourceHash_idx" ON "RasterAsset"("sourceHash");

ALTER TABLE "RasterAsset" ADD CONSTRAINT "RasterAsset_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RasterAsset" ADD CONSTRAINT "RasterAsset_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "AccountUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE, DELETE ON "RasterAsset" TO terrafield_app;

ALTER TABLE "RasterAsset" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS terrafield_tenant_access ON "RasterAsset";
CREATE POLICY terrafield_tenant_access ON "RasterAsset" FOR ALL TO terrafield_app
  USING (app.can_read_row("ownerId", "organizationId"))
  WITH CHECK (app.can_read_row("ownerId", "organizationId"));
