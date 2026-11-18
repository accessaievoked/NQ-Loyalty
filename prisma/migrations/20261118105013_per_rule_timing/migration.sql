-- AlterTable
ALTER TABLE "EarnRule" ADD COLUMN     "creditWhen" "EarnTrigger" NOT NULL DEFAULT 'PAID',
ADD COLUMN     "expiryDays" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "holdDays" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PointsAward" ADD COLUMN     "parts" JSONB;

-- Existing rules keep behaving exactly as the store-wide settings did: copy them onto each rule.
UPDATE "EarnRule" AS r
SET "creditWhen" = s."earnTrigger",
    "holdDays" = s."holdDays",
    "expiryDays" = s."expiryDays"
FROM "StoreSettings" AS s
WHERE s."storeId" = r."storeId";
