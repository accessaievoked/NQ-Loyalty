-- AlterTable
ALTER TABLE "StoreSettings" ADD COLUMN     "devCss" TEXT,
ADD COLUMN     "devEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "devLastGood" JSONB,
ADD COLUMN     "devPageShell" TEXT,
ADD COLUMN     "devPrevious" JSONB,
ADD COLUMN     "devShell" TEXT,
ADD COLUMN     "devUpdatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "EmailTemplate" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'blocks',
    "subject" TEXT NOT NULL,
    "config" JSONB,
    "html" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailTemplate_storeId_kind_key" ON "EmailTemplate"("storeId", "kind");

-- AddForeignKey
ALTER TABLE "EmailTemplate" ADD CONSTRAINT "EmailTemplate_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
