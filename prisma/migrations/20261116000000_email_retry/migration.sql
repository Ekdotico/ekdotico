-- D263, NFR-RE-15: the emails that the service certainly did not take, waiting to be tried again. A row holds the kind,
-- the subject and the account, and no address, link or content.

-- CreateEnum
CREATE TYPE "EmailRetryKind" AS ENUM ('INVITATION', 'REMINDER', 'OFFER', 'OFFER_BATCH', 'CLEARING');

-- CreateTable
CREATE TABLE "EmailRetry" (
    "id" TEXT NOT NULL,
    "kind" "EmailRetryKind" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailRetry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailRetry_createdAt_idx" ON "EmailRetry"("createdAt");

-- CreateIndex
CREATE INDEX "EmailRetry_userId_idx" ON "EmailRetry"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailRetry_kind_subjectId_userId_key" ON "EmailRetry"("kind", "subjectId", "userId");

-- AddForeignKey
ALTER TABLE "EmailRetry" ADD CONSTRAINT "EmailRetry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
