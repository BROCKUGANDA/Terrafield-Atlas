-- Replica-safe evaluation ordering and durable delivery deduplication.
ALTER TABLE "FireWatchlist" ADD COLUMN "evaluationVersion" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "OutboxEvent_event_type_published_at_available_at_idx"
  ON "OutboxEvent"("eventType", "publishedAt", "availableAt");

CREATE TABLE "DeliveryReceipt" (
  "id" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "destinationKey" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "deliveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DeliveryReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DeliveryReceipt_channel_destinationKey_eventId_key"
    UNIQUE ("channel", "destinationKey", "eventId")
);

CREATE INDEX "DeliveryReceipt_eventId_idx" ON "DeliveryReceipt"("eventId");
