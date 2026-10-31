-- CreateTable
CREATE TABLE "OrderRefund" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "shopifyRefundId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderRefund_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderRefund_orderId_shopifyRefundId_key" ON "OrderRefund"("orderId", "shopifyRefundId");

-- AddForeignKey
ALTER TABLE "OrderRefund" ADD CONSTRAINT "OrderRefund_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
