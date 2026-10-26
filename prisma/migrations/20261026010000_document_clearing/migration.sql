-- CreateEnum
CREATE TYPE "ClearingScope" AS ENUM ('ALL', 'DELETED_ONLY');

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "clearingAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "DocumentClearing" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scope" "ClearingScope" NOT NULL,
    "documentIds" UUID[],
    "sharedDocumentIds" UUID[],
    "cancelledDocumentIds" UUID[],
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleteSharedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "emailsClaimedAt" TIMESTAMP(3),

    CONSTRAINT "DocumentClearing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DocumentClearing_userId_idx" ON "DocumentClearing"("userId");

-- AddForeignKey
ALTER TABLE "DocumentClearing" ADD CONSTRAINT "DocumentClearing_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- What follows is written by hand: the schema file cannot say it.

-- FR-AU-91: "records the clearing with the identifiers of the documents the confirmation counted, and
-- for each of those documents, and for no other, carries out the deletion". The lists are tied together
-- so that nothing the code writes, or a second instance, can make the clearing name a document that was
-- not confirmed: the shared and the cancelled documents are among the confirmed ones, and a clearing
-- confirms at least one document.
ALTER TABLE "DocumentClearing" ADD CONSTRAINT "DocumentClearing_confirmed_some" CHECK (cardinality("documentIds") > 0);
ALTER TABLE "DocumentClearing" ADD CONSTRAINT "DocumentClearing_shared_confirmed" CHECK ("sharedDocumentIds" <@ "documentIds");
ALTER TABLE "DocumentClearing" ADD CONSTRAINT "DocumentClearing_cancelled_confirmed" CHECK ("cancelledDocumentIds" <@ "documentIds");

-- The day of the notice exists exactly where a shared document does, and is after the confirmation.
ALTER TABLE "DocumentClearing" ADD CONSTRAINT "DocumentClearing_day_where_shared" CHECK (("deleteSharedAt" IS NULL) = (cardinality("sharedDocumentIds") = 0));
ALTER TABLE "DocumentClearing" ADD CONSTRAINT "DocumentClearing_day_after_confirmation" CHECK ("deleteSharedAt" IS NULL OR "deleteSharedAt" > "requestedAt");
ALTER TABLE "DocumentClearing" ADD CONSTRAINT "DocumentClearing_completed_after_confirmation" CHECK ("completedAt" IS NULL OR "completedAt" >= "requestedAt");

-- NFR-RE-15: the claim of the emails is set at or after the confirmation.
ALTER TABLE "DocumentClearing" ADD CONSTRAINT "DocumentClearing_emails_after_confirmation" CHECK ("emailsClaimedAt" IS NULL OR "emailsClaimedAt" >= "requestedAt");

-- Clearings that are not complete, which the timer reads.
CREATE INDEX "DocumentClearing_open_idx" ON "DocumentClearing"("requestedAt") WHERE "completedAt" IS NULL;

-- Documents in a clearing, which the retention timer and the deletion screen leave out or list.
CREATE INDEX "Document_clearingAt_idx" ON "Document"("clearingAt") WHERE "clearingAt" IS NOT NULL;
