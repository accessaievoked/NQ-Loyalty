-- CreateEnum
CREATE TYPE "LoyaltyBlockStatus" AS ENUM ('BLOCKED', 'CONFIRMED', 'RELEASED');

-- CreateTable
CREATE TABLE "LoyaltyPointsBlock" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "discountValue" DECIMAL(12,2) NOT NULL,
    "redemptionFactor" DECIMAL(12,4) NOT NULL,
    "status" "LoyaltyBlockStatus" NOT NULL DEFAULT 'BLOCKED',
    "transactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoyaltyPointsBlock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyPointsBlock_storeId_orderId_key" ON "LoyaltyPointsBlock"("storeId", "orderId");

-- CreateIndex
CREATE INDEX "LoyaltyPointsBlock_storeId_customerId_idx" ON "LoyaltyPointsBlock"("storeId", "customerId");

-- AddForeignKey
ALTER TABLE "LoyaltyPointsBlock" ADD CONSTRAINT "LoyaltyPointsBlock_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyPointsBlock" ADD CONSTRAINT "LoyaltyPointsBlock_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
