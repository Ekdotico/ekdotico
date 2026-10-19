-- CreateEnum
CREATE TYPE "OwnershipOfferState" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED');

-- CreateTable
CREATE TABLE "OwnershipOffer" (
    "id" TEXT NOT NULL,
    "documentId" UUID NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "state" "OwnershipOfferState" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "respondedAt" TIMESTAMP(3),
    "emailClaimedAt" TIMESTAMP(3),

    CONSTRAINT "OwnershipOffer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OwnershipOffer_documentId_state_idx" ON "OwnershipOffer"("documentId", "state");

-- CreateIndex
CREATE INDEX "OwnershipOffer_toUserId_state_idx" ON "OwnershipOffer"("toUserId", "state");

-- AddForeignKey
ALTER TABLE "OwnershipOffer" ADD CONSTRAINT "OwnershipOffer_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnershipOffer" ADD CONSTRAINT "OwnershipOffer_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnershipOffer" ADD CONSTRAINT "OwnershipOffer_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- What follows is written by hand: the schema file cannot say it.

-- FR-ED-47: "at most one offer is pending for a document". Two requests at
-- once would each find none; the index refuses the second.
CREATE UNIQUE INDEX "OwnershipOffer_document_pending_key" ON "OwnershipOffer"("documentId") WHERE "state" = 'PENDING';

-- FR-ED-47: ownership is offered to another user.
ALTER TABLE "OwnershipOffer" ADD CONSTRAINT "OwnershipOffer_not_to_self" CHECK ("fromUserId" <> "toUserId");

