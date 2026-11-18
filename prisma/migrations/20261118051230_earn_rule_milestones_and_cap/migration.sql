-- AlterEnum
ALTER TYPE "EarnRuleType" ADD VALUE 'ORDER_MILESTONE';

-- AlterTable
ALTER TABLE "EarnRule" ADD COLUMN     "maxPoints" INTEGER,
ADD COLUMN     "milestones" JSONB;
