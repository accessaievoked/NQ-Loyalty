-- CreateEnum
CREATE TYPE "EarnTrigger" AS ENUM ('PAID', 'FULFILLED', 'DELIVERED');

-- CreateEnum
CREATE TYPE "DisplayMode" AS ENUM ('WIDGET', 'PAGE');

-- CreateEnum
CREATE TYPE "EarnRuleType" AS ENUM ('PURCHASE_PER_CURRENCY', 'PURCHASE_FIXED', 'SIGNUP');

-- CreateEnum
CREATE TYPE "RewardType" AS ENUM ('FIXED_AMOUNT', 'PERCENTAGE', 'FREE_SHIPPING');

-- CreateEnum
CREATE TYPE "AwardStatus" AS ENUM ('PENDING', 'RELEASED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('EARN', 'REDEEM', 'EXPIRE', 'REVERSAL', 'ADJUST');

-- CreateEnum
CREATE TYPE "RedemptionStatus" AS ENUM ('PENDING', 'ACTIVE', 'USED', 'FAILED', 'EXPIRED');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Store" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "scopes" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Store_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreSettings" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "earnTrigger" "EarnTrigger" NOT NULL DEFAULT 'PAID',
    "holdDays" INTEGER NOT NULL DEFAULT 0,
    "expiryDays" INTEGER NOT NULL DEFAULT 0,
    "minRedeemPoints" INTEGER NOT NULL DEFAULT 100,
    "emailsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "notifyPointsEarned" BOOLEAN NOT NULL DEFAULT true,
    "notifyRedeemed" BOOLEAN NOT NULL DEFAULT true,
    "notifyExpiring" BOOLEAN NOT NULL DEFAULT true,
    "expiryReminderDays" INTEGER NOT NULL DEFAULT 7,
    "senderName" TEXT,
    "replyTo" TEXT,
    "displayMode" "DisplayMode" NOT NULL DEFAULT 'WIDGET',
    "widgetConfig" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT,
    "imageUrl" TEXT,
    "status" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "shopifyCustomerId" TEXT,
    "email" TEXT,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "phone" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "pointsBalance" INTEGER NOT NULL DEFAULT 0,
    "lifetimePoints" INTEGER NOT NULL DEFAULT 0,
    "emailOptOut" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "customerId" TEXT,
    "shopifyOrderId" TEXT NOT NULL,
    "orderName" TEXT,
    "email" TEXT,
    "currency" TEXT,
    "eligibleAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "refundedAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "cancelledAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "fulfilledAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "discountCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EarnRule" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "EarnRuleType" NOT NULL,
    "value" INTEGER NOT NULL,
    "minOrderAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EarnRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reward" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "RewardType" NOT NULL,
    "value" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "pointsCost" INTEGER NOT NULL,
    "minOrderAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "codeValidDays" INTEGER NOT NULL DEFAULT 30,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PointsAward" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "status" "AwardStatus" NOT NULL DEFAULT 'PENDING',
    "releaseAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PointsAward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PointsTransaction" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "type" "TransactionType" NOT NULL,
    "points" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "idempotencyKey" TEXT NOT NULL,
    "orderId" TEXT,
    "redemptionId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PointsTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Redemption" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "rewardId" TEXT,
    "rewardName" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "status" "RedemptionStatus" NOT NULL DEFAULT 'PENDING',
    "code" TEXT,
    "shopifyDiscountId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "usedOrderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Redemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "customerId" TEXT,
    "kind" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Session_shop_idx" ON "Session"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "Store_shop_key" ON "Store"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "StoreSettings_storeId_key" ON "StoreSettings"("storeId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_storeId_shopifyProductId_key" ON "Product"("storeId", "shopifyProductId");

-- CreateIndex
CREATE INDEX "Customer_storeId_email_idx" ON "Customer"("storeId", "email");

-- CreateIndex
CREATE INDEX "Customer_storeId_lifetimePoints_idx" ON "Customer"("storeId", "lifetimePoints");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_storeId_shopifyCustomerId_key" ON "Customer"("storeId", "shopifyCustomerId");

-- CreateIndex
CREATE INDEX "Order_storeId_email_idx" ON "Order"("storeId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "Order_storeId_shopifyOrderId_key" ON "Order"("storeId", "shopifyOrderId");

-- CreateIndex
CREATE INDEX "EarnRule_storeId_type_active_idx" ON "EarnRule"("storeId", "type", "active");

-- CreateIndex
CREATE INDEX "Reward_storeId_active_idx" ON "Reward"("storeId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "PointsAward_orderId_key" ON "PointsAward"("orderId");

-- CreateIndex
CREATE INDEX "PointsAward_status_releaseAt_idx" ON "PointsAward"("status", "releaseAt");

-- CreateIndex
CREATE INDEX "PointsAward_storeId_customerId_idx" ON "PointsAward"("storeId", "customerId");

-- CreateIndex
CREATE INDEX "PointsTransaction_customerId_createdAt_idx" ON "PointsTransaction"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "PointsTransaction_storeId_type_expiresAt_idx" ON "PointsTransaction"("storeId", "type", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PointsTransaction_storeId_idempotencyKey_key" ON "PointsTransaction"("storeId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "Redemption_storeId_customerId_idx" ON "Redemption"("storeId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Redemption_storeId_code_key" ON "Redemption"("storeId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_storeId_dedupeKey_key" ON "Notification"("storeId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "StoreSettings" ADD CONSTRAINT "StoreSettings_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EarnRule" ADD CONSTRAINT "EarnRule_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reward" ADD CONSTRAINT "Reward_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointsAward" ADD CONSTRAINT "PointsAward_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointsAward" ADD CONSTRAINT "PointsAward_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointsAward" ADD CONSTRAINT "PointsAward_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointsTransaction" ADD CONSTRAINT "PointsTransaction_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointsTransaction" ADD CONSTRAINT "PointsTransaction_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Redemption" ADD CONSTRAINT "Redemption_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Redemption" ADD CONSTRAINT "Redemption_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Redemption" ADD CONSTRAINT "Redemption_rewardId_fkey" FOREIGN KEY ("rewardId") REFERENCES "Reward"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
