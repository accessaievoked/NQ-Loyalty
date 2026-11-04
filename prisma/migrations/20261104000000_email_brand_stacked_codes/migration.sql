ALTER TABLE "StoreSettings" ADD COLUMN "allowStackedCodes" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "StoreSettings" ADD COLUMN "emailBrand" JSONB;
