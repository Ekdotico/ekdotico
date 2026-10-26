-- The three lists of a clearing are never null (review of pull request 60, probe 8): a null list makes the checks of the
-- table ("the shared documents are among the confirmed ones", "the day exists exactly where a shared document does")
-- pass by being unknown, and `cardinality` of a null is null. An empty list is `'{}'`.
UPDATE "DocumentClearing" SET "documentIds" = '{}' WHERE "documentIds" IS NULL;
UPDATE "DocumentClearing" SET "sharedDocumentIds" = '{}' WHERE "sharedDocumentIds" IS NULL;
UPDATE "DocumentClearing" SET "cancelledDocumentIds" = '{}' WHERE "cancelledDocumentIds" IS NULL;

ALTER TABLE "DocumentClearing" ALTER COLUMN "documentIds" SET DEFAULT ARRAY[]::UUID[];
ALTER TABLE "DocumentClearing" ALTER COLUMN "sharedDocumentIds" SET DEFAULT ARRAY[]::UUID[];
ALTER TABLE "DocumentClearing" ALTER COLUMN "cancelledDocumentIds" SET DEFAULT ARRAY[]::UUID[];
ALTER TABLE "DocumentClearing" ALTER COLUMN "documentIds" SET NOT NULL;
ALTER TABLE "DocumentClearing" ALTER COLUMN "sharedDocumentIds" SET NOT NULL;
ALTER TABLE "DocumentClearing" ALTER COLUMN "cancelledDocumentIds" SET NOT NULL;
