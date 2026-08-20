-- Account-level roles for the global billing administration surface.
CREATE TYPE "AccountRole" AS ENUM ('user', 'admin');
CREATE TYPE "BillingTaskType" AS ENUM ('image', 'video', 'audio', 'text');
CREATE TYPE "BillingStatus" AS ENUM ('pending', 'settled', 'void');

ALTER TABLE "User"
ADD COLUMN "role" "AccountRole" NOT NULL DEFAULT 'user';

-- The original owner account becomes the first global administrator.
UPDATE "User"
SET "role" = 'admin'
WHERE "email" IN ('2992656728@qq.com', 'admin@example.com');

CREATE TABLE "PricingCatalogSnapshot" (
    "provider" TEXT NOT NULL,
    "pricingVersion" TEXT NOT NULL,
    "catalog" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "lastAttemptedAt" TIMESTAMP(3) NOT NULL,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PricingCatalogSnapshot_pkey" PRIMARY KEY ("provider")
);

CREATE TABLE "UsageLedger" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "taskType" "BillingTaskType" NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceTaskId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "quantity" DECIMAL(20,6) NOT NULL,
    "unit" TEXT NOT NULL,
    "unitPrice" DECIMAL(24,12),
    "amount" DECIMAL(24,12),
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "status" "BillingStatus" NOT NULL DEFAULT 'pending',
    "pricingVersion" TEXT,
    "pricingSource" TEXT NOT NULL DEFAULT 'https://ai.cangyuansuanli.cn/api/pricing',
    "priceSnapshot" JSONB,
    "billingError" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageLedger_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UsageLedger_idempotencyKey_key" ON "UsageLedger"("idempotencyKey");
CREATE INDEX "UsageLedger_userId_occurredAt_idx" ON "UsageLedger"("userId", "occurredAt");
CREATE INDEX "UsageLedger_status_occurredAt_idx" ON "UsageLedger"("status", "occurredAt");
CREATE INDEX "UsageLedger_sourceType_sourceTaskId_idx" ON "UsageLedger"("sourceType", "sourceTaskId");
CREATE INDEX "UsageLedger_model_occurredAt_idx" ON "UsageLedger"("model", "occurredAt");

ALTER TABLE "UsageLedger"
ADD CONSTRAINT "UsageLedger_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
