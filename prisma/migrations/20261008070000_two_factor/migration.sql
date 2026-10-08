-- DropIndex
DROP INDEX "TwoFactor_userId_idx";

-- CreateIndex
CREATE UNIQUE INDEX "TwoFactor_userId_key" ON "TwoFactor"("userId");
