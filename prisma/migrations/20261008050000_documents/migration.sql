-- CreateEnum
CREATE TYPE "RecordingState" AS ENUM ('RECORDED', 'UNRECORDED');

-- CreateTable
CREATE TABLE "Document" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspaceId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'Untitled document',
    "permissionSet" JSONB NOT NULL,
    "recording" "RecordingState" NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Document_ownerId_deletedAt_idx" ON "Document"("ownerId", "deletedAt");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- What follows is written by hand: the schema file cannot say it.

-- FR-ED-35: a title has at most 200 characters, and an empty one is stored as
-- the default, so no row holds an empty title. The application refuses before
-- the database does (src/lib/documents/documents.ts); this is the backstop.
-- char_length counts code points, as the application does.
ALTER TABLE "Document" ADD CONSTRAINT "Document_title_length" CHECK (char_length("title") BETWEEN 1 AND 200);
