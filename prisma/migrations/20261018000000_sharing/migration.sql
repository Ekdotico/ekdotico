-- CreateEnum
CREATE TYPE "DocumentRole" AS ENUM ('EDITOR', 'REVIEWER', 'VIEWER');

-- CreateEnum
CREATE TYPE "InvitationState" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED', 'EXPIRED');

-- CreateTable
CREATE TABLE "DocumentCollaborator" (
    "id" TEXT NOT NULL,
    "documentId" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "DocumentRole" NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "roleSince" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentCollaborator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentInvitation" (
    "id" TEXT NOT NULL,
    "documentId" UUID NOT NULL,
    "email" TEXT,
    "role" "DocumentRole" NOT NULL,
    "invitedById" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "state" "InvitationState" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "respondedAt" TIMESTAMP(3),
    "acceptedById" TEXT,
    "emailClaimedAt" TIMESTAMP(3),
    "reminderClaimedAt" TIMESTAMP(3),

    CONSTRAINT "DocumentInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DocumentCollaborator_userId_idx" ON "DocumentCollaborator"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentCollaborator_documentId_userId_key" ON "DocumentCollaborator"("documentId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentInvitation_tokenHash_key" ON "DocumentInvitation"("tokenHash");

-- CreateIndex
CREATE INDEX "DocumentInvitation_documentId_email_idx" ON "DocumentInvitation"("documentId", "email");

-- CreateIndex
CREATE INDEX "Notification_recipientId_readAt_idx" ON "Notification"("recipientId", "readAt");

-- AddForeignKey
ALTER TABLE "DocumentCollaborator" ADD CONSTRAINT "DocumentCollaborator_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentCollaborator" ADD CONSTRAINT "DocumentCollaborator_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentInvitation" ADD CONSTRAINT "DocumentInvitation_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentInvitation" ADD CONSTRAINT "DocumentInvitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- What follows is written by hand: the schema file cannot say it.

-- FR-ED-37: "at most one pending invitation exists for one address and one
-- document". Two requests at once would each find nothing to revoke; the
-- index refuses the second.
CREATE UNIQUE INDEX "DocumentInvitation_document_email_pending_key" ON "DocumentInvitation"("documentId", "email") WHERE "state" = 'PENDING';

-- FR-AU-02, FR-ED-21: an address is stored in lower case and compared so.
ALTER TABLE "DocumentInvitation" ADD CONSTRAINT "DocumentInvitation_email_lower_case" CHECK ("email" = lower("email"));
