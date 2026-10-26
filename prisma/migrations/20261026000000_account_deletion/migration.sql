-- AlterTable
ALTER TABLE "User" ADD COLUMN     "erasedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AccountDeletion" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "istoricoDoneAt" TIMESTAMP(3),
    "feedbackDoneAt" TIMESTAMP(3),
    "feedbackSkippedAt" TIMESTAMP(3),
    "credentialsDoneAt" TIMESTAMP(3),
    "rowsDoneAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),

    CONSTRAINT "AccountDeletion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountDeletion_userId_key" ON "AccountDeletion"("userId");

-- AddForeignKey
ALTER TABLE "AccountDeletion" ADD CONSTRAINT "AccountDeletion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- What follows is written by hand: the schema file cannot say it.

-- FR-AU-58: "carry out the steps below in order". The steps are (b) Istorico,
-- (c) the feedback intake, (d) the sessions and credentials, and (e) with (f),
-- the application's own rows; each one's time is set only where the step before
-- it has been done, or, for (c), done or skipped. So no crash, no second
-- instance and no fault of the code can leave a step done that an earlier one
-- has not been.
ALTER TABLE "AccountDeletion" ADD CONSTRAINT "AccountDeletion_feedback_once" CHECK ("feedbackDoneAt" IS NULL OR "feedbackSkippedAt" IS NULL);
ALTER TABLE "AccountDeletion" ADD CONSTRAINT "AccountDeletion_feedback_after_istorico" CHECK (("feedbackDoneAt" IS NULL AND "feedbackSkippedAt" IS NULL) OR "istoricoDoneAt" IS NOT NULL);
ALTER TABLE "AccountDeletion" ADD CONSTRAINT "AccountDeletion_credentials_after_feedback" CHECK ("credentialsDoneAt" IS NULL OR "feedbackDoneAt" IS NOT NULL OR "feedbackSkippedAt" IS NOT NULL);
ALTER TABLE "AccountDeletion" ADD CONSTRAINT "AccountDeletion_rows_after_credentials" CHECK ("rowsDoneAt" IS NULL OR "credentialsDoneAt" IS NOT NULL);
ALTER TABLE "AccountDeletion" ADD CONSTRAINT "AccountDeletion_completed_after_rows" CHECK ("completedAt" IS NULL OR "rowsDoneAt" IS NOT NULL);
