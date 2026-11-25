-- AlterTable
ALTER TABLE "User" ADD COLUMN     "feedbackNoticeAcknowledgedAt" TIMESTAMP(3),
ADD COLUMN     "feedbackNoticeVersion" INTEGER;
