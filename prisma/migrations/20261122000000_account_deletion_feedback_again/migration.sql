-- The second call to the feedback intake, step (g) of an account deletion (fw-late-write; FR-AU-79): the intake is told
-- again to pseudonymise the account's feedback at least 301 seconds after step (c), because a submission that was
-- in flight at (c) may be stored after it. A deletion whose step (c) was skipped (the switch was off) has no
-- second call and completes as before.

-- AlterTable
ALTER TABLE "AccountDeletion" ADD COLUMN "feedbackAgainDoneAt" TIMESTAMP(3);

-- Deletions that completed with the switch on before this column existed had no second call to make.
UPDATE "AccountDeletion" SET "feedbackAgainDoneAt" = "completedAt" WHERE "completedAt" IS NOT NULL AND "feedbackDoneAt" IS NOT NULL;

-- What follows is written by hand: the schema file cannot say it.

-- The second call is made only after step (c) was done (not skipped) and after the application's own rows are
-- done, since it is the last step; and the deletion is complete only when the step it needs has been done: a
-- skipped step (c) needs none, a done one needs the second call.
ALTER TABLE "AccountDeletion" ADD CONSTRAINT "AccountDeletion_feedback_again_after_rows" CHECK ("feedbackAgainDoneAt" IS NULL OR ("feedbackDoneAt" IS NOT NULL AND "rowsDoneAt" IS NOT NULL));
ALTER TABLE "AccountDeletion" ADD CONSTRAINT "AccountDeletion_completed_after_feedback_again" CHECK ("completedAt" IS NULL OR "feedbackDoneAt" IS NULL OR "feedbackAgainDoneAt" IS NOT NULL);
