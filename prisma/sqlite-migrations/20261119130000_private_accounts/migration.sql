CREATE TABLE "AccountUser" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "email" TEXT NOT NULL,
  "name" TEXT,
  "passwordHash" TEXT,
  "emailVerified" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "AccountUser_email_key" ON "AccountUser"("email");
CREATE TABLE "AccountIdentity" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "provider" TEXT NOT NULL,
  "providerAccountId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  FOREIGN KEY ("userId") REFERENCES "AccountUser"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AccountIdentity_provider_providerAccountId_key" ON "AccountIdentity"("provider", "providerAccountId");
CREATE TABLE "AccountVerification" (
  "tokenHash" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "expiresAt" DATETIME NOT NULL,
  FOREIGN KEY ("userId") REFERENCES "AccountUser"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "AccountRateLimit" (
  "key" TEXT NOT NULL PRIMARY KEY,
  "count" INTEGER NOT NULL DEFAULT 1,
  "expiresAt" DATETIME NOT NULL
);
ALTER TABLE "Farm" ADD COLUMN "ownerId" TEXT REFERENCES "AccountUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FireWatchlist" ADD COLUMN "ownerId" TEXT REFERENCES "AccountUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;