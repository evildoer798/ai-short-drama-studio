ALTER TABLE "Storyboard"
ADD COLUMN "assetSelectionInitialized" BOOLEAN NOT NULL DEFAULT false;

-- Existing storyboards keep exactly the asset set users already see. New storyboards
-- remain false until their one-time initial recognition has completed.
UPDATE "Storyboard" SET "assetSelectionInitialized" = true;
