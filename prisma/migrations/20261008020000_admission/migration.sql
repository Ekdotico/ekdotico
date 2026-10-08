-- CreateEnum
CREATE TYPE "AdmissionState" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "WorkspaceType" AS ENUM ('PERSONAL', 'INSTITUTIONAL');

-- CreateTable
CREATE TABLE "AdmissionInvitation" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "tokenHash" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "state" "AdmissionState" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "acceptedById" TEXT,

    CONSTRAINT "AdmissionInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "type" "WorkspaceType" NOT NULL,
    "ownerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdmissionInvitation_tokenHash_key" ON "AdmissionInvitation"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "AdmissionInvitation_requestId_key" ON "AdmissionInvitation"("requestId");

-- CreateIndex
CREATE INDEX "AdmissionInvitation_email_idx" ON "AdmissionInvitation"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_ownerId_key" ON "Workspace"("ownerId");

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- What follows is written by hand: the schema file cannot say it.

-- FR-AU-89 (a): a request for an address that has a pending invitation revokes
-- it and creates a new one, so an address never has two open links. Two
-- requests at once would each find nothing to revoke; the index refuses the second.
CREATE UNIQUE INDEX "AdmissionInvitation_email_pending_key" ON "AdmissionInvitation"("email") WHERE "state" = 'PENDING';

-- FR-AU-02: an address is stored in lower case, so that two addresses that
-- differ only by case are one. The invited address becomes the account's.
ALTER TABLE "User" ADD CONSTRAINT "User_email_lower_case" CHECK ("email" = lower("email"));
ALTER TABLE "AdmissionInvitation" ADD CONSTRAINT "AdmissionInvitation_email_lower_case" CHECK ("email" = lower("email"));

-- FR-AU-09: a personal workspace has its account, without which the unique
-- index on "ownerId" would not keep an account from a second one.
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_personal_has_owner" CHECK ("type" <> 'PERSONAL' OR "ownerId" IS NOT NULL);
