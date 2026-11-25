-- Task 6: durable BullMQ job ledger.
--
-- The queue (Redis/BullMQ) carries only a pointer; PostgreSQL owns the durable
-- job state. The new columns record the lease (who is running the job and
-- until when), the overall deadline, cooperative-cancellation intent, the
-- attempt budget and the dead-letter flag.
--
-- `dedupeKey` is the tenant-scoped natural key of a logical job: a repeated
-- enqueue with the same idempotency key resolves to the same row instead of
-- creating a second job. It is NULL when no idempotency key was supplied, and
-- PostgreSQL keeps NULLs distinct, so unkeyed jobs never collide.

-- AlterTable
ALTER TABLE "ProcessingJob" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "ProcessingJob" ADD COLUMN "dedupeKey" TEXT;
ALTER TABLE "ProcessingJob" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ProcessingJob" ADD COLUMN "maxAttempts" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "ProcessingJob" ADD COLUMN "deadlineAt" TIMESTAMP(3);
ALTER TABLE "ProcessingJob" ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);
ALTER TABLE "ProcessingJob" ADD COLUMN "leaseHolder" TEXT;
ALTER TABLE "ProcessingJob" ADD COLUMN "cancelRequested" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ProcessingJob" ADD COLUMN "deadLettered" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ProcessingJob" ADD COLUMN "enqueuedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "ProcessingJob_dedupeKey_key" ON "ProcessingJob"("dedupeKey");

-- CreateIndex
CREATE INDEX "ProcessingJob_status_leaseExpiresAt_idx" ON "ProcessingJob"("status", "leaseExpiresAt");
