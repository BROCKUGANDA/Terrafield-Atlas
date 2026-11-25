-- Onchain support payments: intents plus verified transactions. No custody,
-- no subscription coupling; the receiver contract is OpenZeppelin-based and
-- forwards ERC20 support straight to the treasury.

CREATE TABLE "OnchainPaymentIntent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "ownerId" TEXT,
    "invoiceId" TEXT,
    "chainId" INTEGER NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "tokenSymbol" TEXT NOT NULL,
    "tokenDecimals" INTEGER NOT NULL,
    "treasuryAddress" TEXT NOT NULL,
    "amountUnits" TEXT NOT NULL,
    "memo" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    CONSTRAINT "OnchainPaymentIntent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OnchainPaymentIntent_memo_key" ON "OnchainPaymentIntent"("memo");
CREATE INDEX "OnchainPaymentIntent_organizationId_status_idx" ON "OnchainPaymentIntent"("organizationId", "status");
CREATE INDEX "OnchainPaymentIntent_ownerId_status_idx" ON "OnchainPaymentIntent"("ownerId", "status");

CREATE TABLE "OnchainPayment" (
    "id" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "amountUnits" TEXT NOT NULL,
    "confirmations" INTEGER NOT NULL,
    "blockNumber" BIGINT,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OnchainPayment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OnchainPayment_intentId_key" ON "OnchainPayment"("intentId");
CREATE UNIQUE INDEX "OnchainPayment_txHash_key" ON "OnchainPayment"("txHash");

ALTER TABLE "OnchainPaymentIntent" ADD CONSTRAINT "OnchainPaymentIntent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OnchainPaymentIntent" ADD CONSTRAINT "OnchainPaymentIntent_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "AccountUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OnchainPaymentIntent" ADD CONSTRAINT "OnchainPaymentIntent_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OnchainPayment" ADD CONSTRAINT "OnchainPayment_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "OnchainPaymentIntent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OnchainPaymentIntent" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS terrafield_tenant_access ON "OnchainPaymentIntent";
CREATE POLICY terrafield_tenant_access ON "OnchainPaymentIntent" FOR ALL TO terrafield_app
  USING (app.can_read_row("ownerId", "organizationId"))
  WITH CHECK (app.can_read_row("ownerId", "organizationId"));

ALTER TABLE "OnchainPayment" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS terrafield_tenant_access ON "OnchainPayment";
CREATE POLICY terrafield_tenant_access ON "OnchainPayment" FOR ALL TO terrafield_app
  USING (EXISTS (SELECT 1 FROM "OnchainPaymentIntent" i WHERE i."id" = "OnchainPayment"."intentId" AND app.can_read_row(i."ownerId", i."organizationId")))
  WITH CHECK (EXISTS (SELECT 1 FROM "OnchainPaymentIntent" i WHERE i."id" = "OnchainPayment"."intentId" AND app.can_read_row(i."ownerId", i."organizationId")));
