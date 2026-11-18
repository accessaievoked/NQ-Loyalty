-- AlterTable
ALTER TABLE "EarnRule" ADD COLUMN     "combine" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "notify" BOOLEAN NOT NULL DEFAULT true;
