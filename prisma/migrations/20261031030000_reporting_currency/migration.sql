-- AlterTable
ALTER TABLE "StoreSettings" ADD COLUMN     "displayCurrency" TEXT,
ADD COLUMN     "fxManual" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "fxPair" TEXT,
ADD COLUMN     "fxRate" DECIMAL(18,8),
ADD COLUMN     "fxRateAt" TIMESTAMP(3);
