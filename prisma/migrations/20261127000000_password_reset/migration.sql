CREATE TABLE "PasswordReset" (
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordReset_pkey" PRIMARY KEY ("tokenHash")
);

CREATE INDEX "PasswordReset_userId_expiresAt_idx" ON "PasswordReset"("userId", "expiresAt");

ALTER TABLE "PasswordReset"
  ADD CONSTRAINT "PasswordReset_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "AccountUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
