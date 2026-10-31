-- AlterEnum
ALTER TYPE "RewardType" ADD VALUE 'CUSTOM_AMOUNT';

-- AlterTable
ALTER TABLE "Reward" ADD COLUMN     "maxPoints" INTEGER,
ADD COLUMN     "minPoints" INTEGER NOT NULL DEFAULT 0;
