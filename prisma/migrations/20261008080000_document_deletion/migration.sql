-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionClaimedAt" TIMESTAMP(3);
