-- Password changes invalidate existing JWTs: the token carries sessionVersion
-- and accountUserId compares it with the row.
ALTER TABLE "AccountUser" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;
